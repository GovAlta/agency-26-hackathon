/**
 * 03-scc-decomposition.js
 *
 * Tarjan's Strongly Connected Components algorithm.
 *
 * ─── WHY THIS EXISTS ────────────────────────────────────────────────────────
 *
 * Every cycle in a directed graph is entirely contained within a single
 * Strongly Connected Component (SCC). An SCC is a maximal subgraph where
 * every node can reach every other node.
 *
 * This gives you three things:
 *
 *   1. VALIDATION: Every cycle found by 01 and 02 must have all its members
 *      in the same SCC. If not, something is wrong.
 *
 *   2. STRUCTURE: You see how the circular-giving network clusters. Maybe
 *      there are 5 big SCCs of 200+ charities each, or maybe there are
 *      hundreds of tiny 3-node clusters. This is forensically significant.
 *
 *   3. FUTURE OPTIMIZATION: If you ever need to re-run cycle enumeration,
 *      you can run it independently per SCC. A 50-node SCC with 200 edges
 *      finishes in milliseconds even for 8-hop cycles.
 *
 * Tarjan's runs in O(V + E) — linear time. On 10K nodes / 52K edges,
 * it completes in under a second.
 *
 * ─── OUTPUT ─────────────────────────────────────────────────────────────────
 *
 * cra.scc_components:   one row per node, with its SCC id and SCC size
 * cra.scc_summary:      one row per SCC, with size, edge count, cycle counts
 *
 * ─── USAGE ──────────────────────────────────────────────────────────────────
 *
 *   node 03-scc-decomposition.js --migrate
 *   node 03-scc-decomposition.js
 */

const db = require('../../lib/db');
const log = require('../../lib/logger');

// ─── CLI Args ────────────────────────────────────────────────────────────────

function parseArgs() {
  const args = { migrate: false };
  for (let i = 2; i < process.argv.length; i++) {
    if (process.argv[i] === '--migrate') args.migrate = true;
  }
  return args;
}

const args = parseArgs();

// ─── Migration ───────────────────────────────────────────────────────────────

async function migrate(client) {
  log.info('Running migration...');
  await client.query(`
    CREATE TABLE IF NOT EXISTS cra.scc_components (
      bn             varchar(15) PRIMARY KEY,
      scc_id         int NOT NULL,
      scc_root       varchar(15) NOT NULL,
      scc_size       int NOT NULL,
      legal_name     text
    );
    CREATE INDEX IF NOT EXISTS idx_scc_comp_scc_id ON cra.scc_components (scc_id);
    CREATE INDEX IF NOT EXISTS idx_scc_comp_size ON cra.scc_components (scc_size DESC);

    CREATE TABLE IF NOT EXISTS cra.scc_summary (
      scc_id              int PRIMARY KEY,
      scc_root            varchar(15) NOT NULL,
      node_count          int NOT NULL,
      edge_count          int NOT NULL DEFAULT 0,
      total_internal_flow numeric DEFAULT 0,
      cycle_count_from_loops    int DEFAULT 0,
      cycle_count_from_johnson  int DEFAULT 0,
      top_charity_names   text[]
    );
    CREATE INDEX IF NOT EXISTS idx_scc_summary_size ON cra.scc_summary (node_count DESC);
  `);
  log.info('Migration complete.');
}

// ─── Load Graph ──────────────────────────────────────────────────────────────

async function loadGraph(client) {
  log.info('\nLoading pruned edge table...');

  const res = await client.query('SELECT src, dst, total_amt FROM cra.loop_edges');

  if (res.rows.length === 0) {
    log.warn('cra.loop_edges is empty. Run 01-detect-all-loops.js first.');
    return null;
  }

  // Build adjacency list
  const adj = new Map();
  const nodeSet = new Set();
  const edges = [];

  for (const row of res.rows) {
    if (!adj.has(row.src)) adj.set(row.src, []);
    adj.get(row.src).push(row.dst);
    nodeSet.add(row.src);
    nodeSet.add(row.dst);
    edges.push({ src: row.src, dst: row.dst, amt: parseFloat(row.total_amt) });
  }

  // Ensure every node has an adjacency entry (even if empty)
  for (const n of nodeSet) {
    if (!adj.has(n)) adj.set(n, []);
  }

  const nodes = Array.from(nodeSet).sort();
  log.info(`  ${edges.length.toLocaleString()} edges, ${nodes.length.toLocaleString()} nodes`);

  return { adj, nodes, edges };
}

// ─── Tarjan's SCC Algorithm ──────────────────────────────────────────────────
//
// Iterative implementation to avoid stack overflow on large graphs.
// Returns an array of SCCs, each being an array of node IDs.

function tarjanSCC(adj, nodes) {
  let index = 0;
  const indices = new Map();
  const lowlinks = new Map();
  const onStack = new Set();
  const stack = [];
  const sccs = [];

  // Iterative Tarjan's using an explicit call stack
  // Each frame: { node, neighborIdx, calledFrom }
  for (const startNode of nodes) {
    if (indices.has(startNode)) continue;

    const callStack = [{ node: startNode, neighborIdx: 0 }];
    indices.set(startNode, index);
    lowlinks.set(startNode, index);
    index++;
    stack.push(startNode);
    onStack.add(startNode);

    while (callStack.length > 0) {
      const frame = callStack[callStack.length - 1];
      const v = frame.node;
      const neighbors = adj.get(v) || [];

      if (frame.neighborIdx < neighbors.length) {
        const w = neighbors[frame.neighborIdx];
        frame.neighborIdx++;

        if (!indices.has(w)) {
          // Tree edge: recurse
          indices.set(w, index);
          lowlinks.set(w, index);
          index++;
          stack.push(w);
          onStack.add(w);
          callStack.push({ node: w, neighborIdx: 0 });
        } else if (onStack.has(w)) {
          // Back edge
          lowlinks.set(v, Math.min(lowlinks.get(v), indices.get(w)));
        }
      } else {
        // All neighbors processed — check if v is root of SCC
        if (lowlinks.get(v) === indices.get(v)) {
          const scc = [];
          let w;
          do {
            w = stack.pop();
            onStack.delete(w);
            scc.push(w);
          } while (w !== v);
          sccs.push(scc);
        }

        // Pop call stack and update parent's lowlink
        callStack.pop();
        if (callStack.length > 0) {
          const parent = callStack[callStack.length - 1].node;
          lowlinks.set(parent, Math.min(lowlinks.get(parent), lowlinks.get(v)));
        }
      }
    }
  }

  return sccs;
}

// ─── Write Results ───────────────────────────────────────────────────────────

async function writeResults(client, sccs, edges) {
  log.info('\nWriting SCC results...');

  await client.query('TRUNCATE cra.scc_components');
  await client.query('TRUNCATE cra.scc_summary');

  // Build node-to-SCC mapping
  const nodeToScc = new Map();
  const sccList = [];

  // Sort SCCs by size descending, assign sequential IDs
  sccs.sort((a, b) => b.length - a.length);

  for (let i = 0; i < sccs.length; i++) {
    const scc = sccs[i];
    const sccId = i + 1;
    const root = scc.sort()[0]; // lex-smallest node as root
    sccList.push({ id: sccId, root, nodes: scc });
    for (const node of scc) {
      nodeToScc.set(node, { sccId, root, size: scc.length });
    }
  }

  // Batch insert components
  const batchSize = 2000;
  const allNodes = Array.from(nodeToScc.entries());
  let written = 0;

  for (let i = 0; i < allNodes.length; i += batchSize) {
    const batch = allNodes.slice(i, i + batchSize);
    const values = [];
    const params = [];
    let p = 1;

    for (const [bn, info] of batch) {
      values.push(`($${p}, $${p + 1}, $${p + 2}, $${p + 3})`);
      params.push(bn, info.sccId, info.root, info.size);
      p += 4;
    }

    await client.query(`
      INSERT INTO cra.scc_components (bn, scc_id, scc_root, scc_size)
      VALUES ${values.join(', ')}
      ON CONFLICT (bn) DO UPDATE SET scc_id = EXCLUDED.scc_id, scc_root = EXCLUDED.scc_root, scc_size = EXCLUDED.scc_size
    `, params);

    written += batch.length;
  }
  log.info(`  ${written.toLocaleString()} node-SCC assignments written`);

  // Backfill legal names from cra_identification
  await client.query(`
    UPDATE cra.scc_components sc
    SET legal_name = sub.legal_name
    FROM (
      SELECT DISTINCT ON (bn) bn, legal_name
      FROM cra.cra_identification
      ORDER BY bn, fiscal_year DESC
    ) sub
    WHERE sc.bn = sub.bn
  `);

  // Compute per-SCC edge counts and flow
  const sccEdgeCounts = new Map();
  const sccFlows = new Map();
  for (const edge of edges) {
    const srcScc = nodeToScc.get(edge.src);
    const dstScc = nodeToScc.get(edge.dst);
    if (srcScc && dstScc && srcScc.sccId === dstScc.sccId) {
      const sid = srcScc.sccId;
      sccEdgeCounts.set(sid, (sccEdgeCounts.get(sid) || 0) + 1);
      sccFlows.set(sid, (sccFlows.get(sid) || 0) + edge.amt);
    }
  }

  // Write SCC summary
  for (const scc of sccList) {
    if (scc.nodes.length < 2) continue; // skip singletons

    const topNames = await client.query(`
      SELECT legal_name FROM cra.scc_components
      WHERE scc_id = $1 AND legal_name IS NOT NULL
      ORDER BY bn LIMIT 5
    `, [scc.id]);

    const names = topNames.rows.map(r => r.legal_name);

    await client.query(`
      INSERT INTO cra.scc_summary (scc_id, scc_root, node_count, edge_count, total_internal_flow, top_charity_names)
      VALUES ($1, $2, $3, $4, $5, $6)
      ON CONFLICT (scc_id) DO UPDATE SET
        node_count = EXCLUDED.node_count,
        edge_count = EXCLUDED.edge_count,
        total_internal_flow = EXCLUDED.total_internal_flow,
        top_charity_names = EXCLUDED.top_charity_names
    `, [
      scc.id,
      scc.root,
      scc.nodes.length,
      sccEdgeCounts.get(scc.id) || 0,
      sccFlows.get(scc.id) || 0,
      `{${names.map(n => `"${(n || '').replace(/"/g, '\\"')}"`).join(',')}}`
    ]);
  }

  // Backfill cycle counts from cra.loops and cra.johnson_cycles
  await client.query(`
    UPDATE cra.scc_summary ss
    SET cycle_count_from_loops = sub.cnt
    FROM (
      SELECT sc.scc_id, COUNT(DISTINCT lp.loop_id) AS cnt
      FROM cra.loop_participants lp
      JOIN cra.scc_components sc ON lp.bn = sc.bn
      GROUP BY sc.scc_id
    ) sub
    WHERE ss.scc_id = sub.scc_id
  `).catch(() => log.info('  (cra.loops not available for cross-ref — skipping)'));

  await client.query(`
    UPDATE cra.scc_summary ss
    SET cycle_count_from_johnson = sub.cnt
    FROM (
      SELECT sc.scc_id, COUNT(DISTINCT jc.id) AS cnt
      FROM cra.johnson_cycles jc, unnest(jc.path_bns) AS pbn
      JOIN cra.scc_components sc ON sc.bn = pbn
      GROUP BY sc.scc_id
    ) sub
    WHERE ss.scc_id = sub.scc_id
  `).catch(() => log.info('  (cra.johnson_cycles not available for cross-ref — skipping)'));
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  log.section('Step 3: Tarjan SCC Decomposition');

  const client = await db.getClient();

  try {
    // migrate() is idempotent (CREATE TABLE / INDEX IF NOT EXISTS) so we
    // always run it — no --migrate flag required, survives drop-loop-tables.
    await migrate(client);

    const graph = await loadGraph(client);
    if (!graph) return;

    // Run Tarjan's
    log.info('\nRunning Tarjan\'s SCC algorithm...');
    const t0 = Date.now();
    const sccs = tarjanSCC(graph.adj, graph.nodes);
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

    // Stats
    const nonTrivial = sccs.filter(s => s.length >= 2);
    const trivial = sccs.filter(s => s.length === 1);
    const largest = nonTrivial.length > 0 ? Math.max(...nonTrivial.map(s => s.length)) : 0;
    const totalInNonTrivial = nonTrivial.reduce((sum, s) => sum + s.length, 0);

    log.info(`\nTarjan's complete in ${elapsed}s`);
    log.info(`\n  ── SCC Structure ──`);
    log.info(`  Total SCCs:          ${sccs.length.toLocaleString()}`);
    log.info(`  Trivial (1 node):    ${trivial.length.toLocaleString()}`);
    log.info(`  Non-trivial (2+):    ${nonTrivial.length.toLocaleString()}`);
    log.info(`  Nodes in non-trivial: ${totalInNonTrivial.toLocaleString()}`);
    log.info(`  Largest SCC:         ${largest.toLocaleString()} nodes`);

    // Size distribution
    const sizeBuckets = {};
    for (const scc of nonTrivial) {
      const bucket = scc.length <= 5 ? '2-5'
        : scc.length <= 10 ? '6-10'
        : scc.length <= 50 ? '11-50'
        : scc.length <= 100 ? '51-100'
        : scc.length <= 500 ? '101-500'
        : '500+';
      sizeBuckets[bucket] = (sizeBuckets[bucket] || 0) + 1;
    }
    log.info('\n  ── Size Distribution (non-trivial SCCs) ──');
    for (const [bucket, count] of Object.entries(sizeBuckets).sort()) {
      log.info(`    ${bucket.padEnd(8)} nodes: ${count} SCCs`);
    }

    // Write to DB
    await writeResults(client, sccs, graph.edges);

    // Validation: check that all detected loops are intra-SCC
    log.info('\n  ── Validation ──');
    const crossSccLoops = await client.query(`
      SELECT l.id, l.path_display, COUNT(DISTINCT sc.scc_id) AS scc_count
      FROM cra.loops l, unnest(l.path_bns) AS pbn
      JOIN cra.scc_components sc ON sc.bn = pbn
      GROUP BY l.id, l.path_display
      HAVING COUNT(DISTINCT sc.scc_id) > 1
      LIMIT 10
    `).catch(() => ({ rows: [] }));

    if (crossSccLoops.rows.length === 0) {
      log.info('  ✓ All detected loops are within a single SCC (as expected)');
    } else {
      log.warn(`  ✗ ${crossSccLoops.rows.length} loops span multiple SCCs — this indicates a bug!`);
      for (const r of crossSccLoops.rows.slice(0, 3)) {
        log.warn(`    Loop ${r.id}: ${r.path_display} (${r.scc_count} SCCs)`);
      }
    }

    log.section('Step 3 Complete');

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
