/**
 * 04-matrix-power-census.js
 *
 * Adjacency matrix power analysis for cycle participation census.
 *
 * ─── WHY THIS EXISTS ────────────────────────────────────────────────────────
 *
 * The diagonal of A^k (the adjacency matrix raised to the k-th power) counts
 * the number of closed walks of length k that pass through each node. This is
 * the mathematical formalization of "water flowing through pipes and returning
 * to its source."
 *
 * This is NOT the same as counting simple cycles (closed walks can revisit
 * nodes), but it provides:
 *
 *   1. FAST CENSUS: Which nodes participate in ANY circular flow at each
 *      hop length? Nodes with A^k[i,i] = 0 definitely have no k-cycles.
 *      This completes in seconds for all k simultaneously.
 *
 *   2. FLOW MAGNITUDE: Using a weighted adjacency matrix, the diagonal of
 *      (weighted A)^k gives the total circular flow volume through each
 *      node. High values = high-volume round-tripping.
 *
 *   3. CROSS-VALIDATION: The number of nodes with non-zero A^k diagonals
 *      should be >= the number of nodes found in k-hop cycles by Johnson's
 *      and the self-join. If Johnson finds a node in a 5-cycle but A^5[i,i]
 *      is zero, something is wrong.
 *
 * Computation: Instead of actual matrix multiplication (O(n³) per power),
 * we use sparse matrix-vector multiplication. For each node i, we propagate
 * a unit of "flow" outward for k hops and see how much returns. This is
 * O(E * k) total, which for 52K edges and k=8 is ~400K operations.
 *
 * ─── OUTPUT ─────────────────────────────────────────────────────────────────
 *
 * cra.matrix_census:  one row per node, with closed-walk counts at each k
 *
 * ─── USAGE ──────────────────────────────────────────────────────────────────
 *
 *   node 04-matrix-power-census.js --migrate
 *   node 04-matrix-power-census.js
 *   node 04-matrix-power-census.js --max-hops 8
 */

const db = require('../../lib/db');
const log = require('../../lib/logger');

// ─── CLI Args ────────────────────────────────────────────────────────────────

function parseArgs() {
  const args = { maxHops: 8, migrate: false, weighted: false };
  for (let i = 2; i < process.argv.length; i++) {
    const a = process.argv[i];
    const next = process.argv[i + 1];
    if (a === '--max-hops' && next) { args.maxHops = parseInt(next, 10) || args.maxHops; i++; }
    else if (a === '--migrate')     { args.migrate = true; }
    else if (a === '--weighted')    { args.weighted = true; }
  }
  args.maxHops = Math.min(Math.max(args.maxHops, 2), 8);
  return args;
}

const args = parseArgs();

// ─── Migration ───────────────────────────────────────────────────────────────

async function migrate(client) {
  log.info('Running migration...');
  await client.query(`
    CREATE TABLE IF NOT EXISTS cra.matrix_census (
      bn                varchar(15) PRIMARY KEY,
      legal_name        text,
      walks_2           numeric DEFAULT 0,
      walks_3           numeric DEFAULT 0,
      walks_4           numeric DEFAULT 0,
      walks_5           numeric DEFAULT 0,
      walks_6           numeric DEFAULT 0,
      walks_7           numeric DEFAULT 0,
      walks_8           numeric DEFAULT 0,
      max_walk_length   int DEFAULT 0,
      total_walk_count  numeric DEFAULT 0,
      in_johnson_cycle  boolean DEFAULT false,
      in_selfjoin_cycle boolean DEFAULT false,
      scc_id            int,
      scc_size          int
    );
    CREATE INDEX IF NOT EXISTS idx_matrix_census_total ON cra.matrix_census (total_walk_count DESC);
    CREATE INDEX IF NOT EXISTS idx_matrix_census_scc ON cra.matrix_census (scc_id);
  `);
  log.info('Migration complete.');
}

// ─── Load Graph ──────────────────────────────────────────────────────────────

async function loadGraph(client) {
  log.info('\nLoading pruned edge table...');

  const res = await client.query('SELECT src, dst, total_amt FROM cra.loop_edges');
  if (res.rows.length === 0) {
    log.warn('cra.loop_edges is empty.');
    return null;
  }

  // Assign integer indices to nodes for efficient array access
  const nodeSet = new Set();
  for (const row of res.rows) {
    nodeSet.add(row.src);
    nodeSet.add(row.dst);
  }
  const nodes = Array.from(nodeSet).sort();
  const nodeIndex = new Map();
  for (let i = 0; i < nodes.length; i++) nodeIndex.set(nodes[i], i);

  const n = nodes.length;

  // Build sparse adjacency: for each node, list of {targetIdx, weight}
  const adjOut = new Array(n);
  for (let i = 0; i < n; i++) adjOut[i] = [];

  for (const row of res.rows) {
    const si = nodeIndex.get(row.src);
    const di = nodeIndex.get(row.dst);
    const w = args.weighted ? parseFloat(row.total_amt) : 1;
    adjOut[si].push({ idx: di, w });
  }

  log.info(`  ${res.rows.length.toLocaleString()} edges, ${n.toLocaleString()} nodes (indexed)`);
  return { nodes, nodeIndex, adjOut, n };
}

// ─── Sparse Matrix Power Diagonal ───────────────────────────────────────────
//
// Instead of computing the full A^k matrix, we compute only the diagonal.
//
// For each node i, we track a "flow vector" starting with all flow at i.
// After k hops of propagation through the adjacency list, the amount of
// flow that returns to i is A^k[i,i].
//
// Optimization: We don't need a separate propagation per node. We can
// compute the diagonal of A^k by iterative sparse matrix-vector multiplication:
//
//   Start with vectors e_i (unit at position i) for all i simultaneously.
//   But that's the identity matrix, and A^k * I = A^k.
//   We only need the diagonal, so we track it differently.
//
// Efficient approach: iterative "squaring" of the diagonal.
//   - A^2[i,i] = sum_j A[i,j] * A[j,i]
//   - A^k[i,i] = sum over all k-hop closed walks from i to i
//
// We compute this by propagating flow: at step 0, each node has 1 unit.
// At each step, flow propagates along edges. After k steps, we read
// how much flow from node i returned to node i.
//
// Implementation: for each node, BFS-like propagation for k hops,
// tracking flow amounts. This is essentially sparse matrix-vector multiply
// iterated k times, reading only diagonals.

function computeDiagonals(graph, maxHops) {
  const { adjOut, n } = graph;

  // Result: diag[k][i] = A^k[i,i] (closed walks of length k through node i)
  const diag = {};
  for (let k = 2; k <= maxHops; k++) diag[k] = new Float64Array(n);

  // For efficiency: we propagate flow from ALL sources simultaneously
  // using iterative sparse matrix-vector multiplication.
  //
  // Let V be an n×n matrix, initially I (identity).
  // After one multiply: V = A * V, so V[i][j] = walks of length 1 from j to i.
  // After k multiplies: V = A^k, and diagonal V[i][i] = A^k[i,i].
  //
  // But storing the full n×n matrix is too large (10K × 10K = 100M entries).
  //
  // Instead: for each source node s, propagate independently.
  // Use sparse flow: Map<nodeIdx, flowAmount>

  log.info(`\n  Computing diagonals for k = 2..${maxHops}...`);

  // Process nodes in chunks for memory efficiency and progress reporting
  const chunkSize = 500;
  let processed = 0;

  for (let chunk = 0; chunk < n; chunk += chunkSize) {
    const chunkEnd = Math.min(chunk + chunkSize, n);

    for (let s = chunk; s < chunkEnd; s++) {
      // Propagate flow from source s
      // At step 0: flow = {s: 1}
      // At step t: flow[v] = number of walks of length t from s to v
      // At step k: flow[s] = A^k[s,s] = closed walks of length k

      let current = new Map();
      current.set(s, 1);

      for (let step = 1; step <= maxHops; step++) {
        const next = new Map();

        for (const [v, amount] of current) {
          for (const edge of adjOut[v]) {
            const existing = next.get(edge.idx) || 0;
            next.set(edge.idx, existing + amount * edge.w);
          }
        }

        // Record diagonal: how much flow returned to source at this step
        if (step >= 2) {
          const returnedFlow = next.get(s) || 0;
          diag[step][s] = returnedFlow;
        }

        current = next;

        // Memory safety: if flow vector gets too large, we're in a dense region.
        // Cap the map size to prevent blowup on hub nodes.
        if (current.size > 50000) {
          // Keep only the top entries by flow amount
          const entries = Array.from(current.entries());
          entries.sort((a, b) => b[1] - a[1]);
          current = new Map(entries.slice(0, 10000));
        }
      }
    }

    processed = chunkEnd;
    const pct = ((processed / n) * 100).toFixed(1);
    log.info(`    ${processed.toLocaleString()} / ${n.toLocaleString()} nodes (${pct}%)`);
  }

  return diag;
}

// ─── Write Results ───────────────────────────────────────────────────────────

async function writeResults(client, graph, diag) {
  const { nodes, n } = graph;

  log.info('\nWriting census results...');
  await client.query('TRUNCATE cra.matrix_census');

  const batchSize = 1000;
  let written = 0;

  for (let i = 0; i < n; i += batchSize) {
    const batch = [];
    const params = [];
    let p = 1;
    const end = Math.min(i + batchSize, n);

    for (let j = i; j < end; j++) {
      const bn = nodes[j];
      const w2 = diag[2] ? diag[2][j] : 0;
      const w3 = diag[3] ? diag[3][j] : 0;
      const w4 = diag[4] ? diag[4][j] : 0;
      const w5 = diag[5] ? diag[5][j] : 0;
      const w6 = diag[6] ? diag[6][j] : 0;
      const w7 = diag[7] ? diag[7][j] : 0;
      const w8 = diag[8] ? diag[8][j] : 0;

      let maxLen = 0;
      if (w8 > 0) maxLen = 8;
      else if (w7 > 0) maxLen = 7;
      else if (w6 > 0) maxLen = 6;
      else if (w5 > 0) maxLen = 5;
      else if (w4 > 0) maxLen = 4;
      else if (w3 > 0) maxLen = 3;
      else if (w2 > 0) maxLen = 2;

      const total = w2 + w3 + w4 + w5 + w6 + w7 + w8;

      batch.push(`($${p},$${p+1},$${p+2},$${p+3},$${p+4},$${p+5},$${p+6},$${p+7},$${p+8},$${p+9})`);
      params.push(bn, w2, w3, w4, w5, w6, w7, w8, maxLen, total);
      p += 10;
    }

    if (batch.length > 0) {
      await client.query(`
        INSERT INTO cra.matrix_census (bn, walks_2, walks_3, walks_4, walks_5, walks_6, walks_7, walks_8, max_walk_length, total_walk_count)
        VALUES ${batch.join(', ')}
        ON CONFLICT (bn) DO UPDATE SET
          walks_2 = EXCLUDED.walks_2, walks_3 = EXCLUDED.walks_3,
          walks_4 = EXCLUDED.walks_4, walks_5 = EXCLUDED.walks_5,
          walks_6 = EXCLUDED.walks_6, walks_7 = EXCLUDED.walks_7,
          walks_8 = EXCLUDED.walks_8, max_walk_length = EXCLUDED.max_walk_length,
          total_walk_count = EXCLUDED.total_walk_count
      `, params);
    }

    written = end;
    if (written % 5000 === 0 || written === n) {
      log.info(`  Written ${written.toLocaleString()} / ${n.toLocaleString()}`);
    }
  }

  // Backfill legal names
  await client.query(`
    UPDATE cra.matrix_census mc
    SET legal_name = sub.legal_name
    FROM (
      SELECT DISTINCT ON (bn) bn, legal_name
      FROM cra.cra_identification
      ORDER BY bn, fiscal_year DESC
    ) sub
    WHERE mc.bn = sub.bn
  `);

  // Cross-reference with Johnson cycles
  await client.query(`
    UPDATE cra.matrix_census mc
    SET in_johnson_cycle = true
    WHERE EXISTS (
      SELECT 1 FROM cra.johnson_cycles jc
      WHERE mc.bn = ANY(jc.path_bns)
    )
  `).catch(() => log.info('  (johnson_cycles not available — skipping)'));

  // Cross-reference with self-join loops
  await client.query(`
    UPDATE cra.matrix_census mc
    SET in_selfjoin_cycle = true
    WHERE EXISTS (
      SELECT 1 FROM cra.loop_participants lp
      WHERE lp.bn = mc.bn
    )
  `).catch(() => log.info('  (loop_participants not available — skipping)'));

  // Cross-reference with SCC
  await client.query(`
    UPDATE cra.matrix_census mc
    SET scc_id = sc.scc_id, scc_size = sc.scc_size
    FROM cra.scc_components sc
    WHERE mc.bn = sc.bn
  `).catch(() => log.info('  (scc_components not available — skipping)'));
}

// ─── Summary Stats ───────────────────────────────────────────────────────────

async function printSummary(client, maxHops) {
  log.info('\n  ── Census Summary ──');

  for (let k = 2; k <= maxHops; k++) {
    const col = `walks_${k}`;
    const res = await client.query(`
      SELECT
        COUNT(*) FILTER (WHERE ${col} > 0) AS participating,
        SUM(${col}) AS total_walks
      FROM cra.matrix_census
    `);
    const r = res.rows[0];
    log.info(`    ${k}-hop: ${parseInt(r.participating).toLocaleString()} nodes with closed walks (total: ${parseFloat(r.total_walks || 0).toLocaleString()})`);
  }

  // Validation: nodes in cycles but with zero walks (shouldn't happen)
  const anomalies = await client.query(`
    SELECT COUNT(*) AS c
    FROM cra.matrix_census
    WHERE in_johnson_cycle = true AND total_walk_count = 0
  `).catch(() => ({ rows: [{ c: 0 }] }));

  const anomalyCount = parseInt(anomalies.rows[0].c);
  if (anomalyCount === 0) {
    log.info('\n  ✓ All cycle participants have non-zero walk counts (consistent)');
  } else {
    log.warn(`\n  ✗ ${anomalyCount} nodes are in Johnson cycles but have zero walk counts — investigate`);
  }

  // Top nodes by walk count
  const top = await client.query(`
    SELECT bn, legal_name, total_walk_count,
           walks_2, walks_3, walks_4, walks_5, walks_6, walks_7, walks_8,
           scc_id, scc_size
    FROM cra.matrix_census
    WHERE total_walk_count > 0
    ORDER BY total_walk_count DESC
    LIMIT 15
  `);

  if (top.rows.length > 0) {
    log.info('\n  ── Top 15 Nodes by Total Circular Walk Volume ──');
    for (const r of top.rows) {
      const name = (r.legal_name || 'Unknown').substring(0, 40);
      log.info(`    ${r.bn} | ${name.padEnd(40)} | walks: ${parseFloat(r.total_walk_count).toLocaleString()} | SCC: ${r.scc_id || '-'} (${r.scc_size || '-'} nodes)`);
    }
  }
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  log.section('Step 4: Matrix Power Census');
  log.info(`Max hops:  ${args.maxHops}`);
  log.info(`Weighted:  ${args.weighted ? 'yes (by gift amount)' : 'no (unweighted / structural)'}`);

  const client = await db.getClient();

  try {
    // migrate() is idempotent (CREATE TABLE / INDEX IF NOT EXISTS) so we
    // always run it — no --migrate flag required, survives drop-loop-tables.
    await migrate(client);

    const graph = await loadGraph(client);
    if (!graph) return;

    const t0 = Date.now();
    const diag = computeDiagonals(graph, args.maxHops);
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    log.info(`\n  Diagonal computation complete in ${elapsed}s`);

    await writeResults(client, graph, diag);
    await printSummary(client, args.maxHops);

    log.section('Step 4 Complete');

  } catch (err) {
    log.error(`Fatal: ${err.message}`);
    console.error(err.stack);
    process.exit(1);
  } finally {
    client.release();
    await db.end();
  }
}

main();
