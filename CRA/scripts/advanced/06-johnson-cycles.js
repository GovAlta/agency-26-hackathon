/**
 * 06-johnson-cycles.js
 *
 * Johnson's algorithm for bounded-length cycle enumeration, in-memory.
 *
 * ─── DIAGNOSTIC / CROSS-VALIDATION TOOL ─────────────────────────────────────
 *
 * Johnson's algorithm (1975) finds all simple cycles via DFS with a "blocking"
 * mechanism. It works well on small SCCs but chokes on the giant 8,971-node
 * SCC at depths > 5. Use with --max-hops 5 for practical results, or run
 * 05-partitioned-cycles.js which applies Johnson's per-SCC automatically.
 *
 * Results go to cra.johnson_cycles for cross-referencing with cra.loops
 * (the brute force ground truth from 01).
 *
 * ─── USAGE ──────────────────────────────────────────────────────────────────
 *
 *   node 06-johnson-cycles.js --migrate
 *   node 06-johnson-cycles.js --max-hops 5
 *   node 06-johnson-cycles.js --max-hops 6 --year-window 1
 */

const db = require('../../lib/db');
const log = require('../../lib/logger');

// ─── CLI Args ────────────────────────────────────────────────────────────────

function parseArgs() {
  const args = { threshold: 5000, maxHops: 8, yearWindow: 1, migrate: false, batchSize: 5000 };
  for (let i = 2; i < process.argv.length; i++) {
    const a = process.argv[i];
    const next = process.argv[i + 1];
    if (a === '--threshold' && next)        { args.threshold  = parseInt(next, 10) || args.threshold; i++; }
    else if (a === '--max-hops' && next)    { args.maxHops    = parseInt(next, 10) || args.maxHops; i++; }
    else if (a === '--year-window' && next) { args.yearWindow = parseInt(next, 10); i++; }
    else if (a === '--migrate')             { args.migrate    = true; }
    else if (a === '--batch-size' && next)  { args.batchSize  = parseInt(next, 10) || args.batchSize; i++; }
  }
  args.maxHops = Math.min(Math.max(args.maxHops, 2), 8);
  return args;
}

const args = parseArgs();

// ─── Migration ───────────────────────────────────────────────────────────────

async function migrate(client) {
  log.info('Running migration...');
  await client.query(`
    CREATE TABLE IF NOT EXISTS cra.johnson_cycles (
      id             serial PRIMARY KEY,
      hops           int NOT NULL,
      path_bns       varchar(15)[] NOT NULL,
      path_display   text NOT NULL UNIQUE,
      bottleneck_amt numeric,
      total_flow     numeric,
      min_year       int,
      max_year       int
    );
    CREATE INDEX IF NOT EXISTS idx_johnson_cycles_hops ON cra.johnson_cycles (hops);
    CREATE INDEX IF NOT EXISTS idx_johnson_cycles_display ON cra.johnson_cycles (path_display);
  `);
  log.info('Migration complete.');
}

// ─── Load Graph Into Memory ──────────────────────────────────────────────────

async function loadGraph(client) {
  log.info('\nLoading pruned edge table into memory...');

  // Read from the already-pruned edge table (built by 01-detect-all-loops.js)
  const edgeCheck = await client.query('SELECT COUNT(*) AS c FROM cra.loop_edges');
  const edgeCount = parseInt(edgeCheck.rows[0].c);

  if (edgeCount === 0) {
    log.warn('cra.loop_edges is empty. Run 01-detect-all-loops.js first to build and prune edges.');
    return null;
  }

  const res = await client.query(`
    SELECT src, dst, total_amt, min_year, max_year
    FROM cra.loop_edges
    ORDER BY src, dst
  `);

  // Build adjacency list: node -> [{dst, amt, minYear, maxYear}]
  const adj = new Map();     // src -> [{dst, amt, minYear, maxYear}]
  const nodeSet = new Set();
  const edgeMap = new Map();  // "src|dst" -> {amt, minYear, maxYear}

  for (const row of res.rows) {
    const src = row.src;
    const dst = row.dst;
    const amt = parseFloat(row.total_amt);
    const minYear = parseInt(row.min_year);
    const maxYear = parseInt(row.max_year);

    if (!adj.has(src)) adj.set(src, []);
    adj.get(src).push({ dst, amt, minYear, maxYear });

    nodeSet.add(src);
    nodeSet.add(dst);
    edgeMap.set(`${src}|${dst}`, { amt, minYear, maxYear });
  }

  const nodes = Array.from(nodeSet).sort();
  log.info(`  ${edgeCount.toLocaleString()} edges, ${nodes.length.toLocaleString()} nodes loaded`);

  return { adj, nodes, edgeMap };
}

// ─── Johnson's Algorithm (bounded length) ────────────────────────────────────
//
// Classic Johnson's finds ALL cycles. We modify it to:
//   1. Only report cycles of length 2..maxHops
//   2. Check temporal constraint (year window)
//   3. Use canonical ordering (min BN first) for dedup
//
// The algorithm works per-SCC, starting DFS from each vertex s in order.
// After processing s, it's removed from the graph (so each cycle is found
// exactly once, rooted at its smallest vertex).

function johnsonEnumerate(graph, maxHops, yearWindow) {
  const { adj, nodes } = graph;
  const cycles = [];
  let cyclesByHops = {};
  for (let h = 2; h <= maxHops; h++) cyclesByHops[h] = 0;

  // For each starting node s (in sorted order)
  const nodesInGraph = new Set(nodes);

  for (const s of nodes) {
    if (!nodesInGraph.has(s)) continue;

    const blocked = new Set();
    const blockMap = new Map(); // node -> Set of nodes to unblock when this one unblocks
    const stack = [];           // current path

    function unblock(u) {
      blocked.delete(u);
      if (blockMap.has(u)) {
        for (const w of blockMap.get(u)) {
          if (blocked.has(w)) unblock(w);
        }
        blockMap.get(u).clear();
      }
    }

    function circuit(v, depth) {
      let foundCycle = false;
      stack.push(v);
      blocked.add(v);

      const neighbors = adj.get(v) || [];
      for (const edge of neighbors) {
        const w = edge.dst;
        if (!nodesInGraph.has(w)) continue; // skip removed nodes
        if (w < s) continue; // only find cycles rooted at smallest node

        if (w === s) {
          // Found a cycle: stack contains the path, s closes it
          if (stack.length >= 2 && stack.length <= maxHops) {
            const path = [...stack];
            // Temporal check: compute year span across all edges in cycle
            let globalMin = Infinity, globalMax = -Infinity;
            let bottleneck = Infinity, totalFlow = 0;
            let valid = true;

            for (let i = 0; i < path.length; i++) {
              const from = path[i];
              const to = path[(i + 1) % path.length]; // last connects back to s
              const key = `${from}|${to}`;
              const e = graph.edgeMap.get(key);
              if (!e) { valid = false; break; }

              if (e.minYear < globalMin) globalMin = e.minYear;
              if (e.maxYear > globalMax) globalMax = e.maxYear;
              if (e.amt < bottleneck) bottleneck = e.amt;
              totalFlow += e.amt;
            }

            if (valid && (yearWindow < 0 || (globalMax - globalMin) <= yearWindow)) {
              cycles.push({
                hops: path.length,
                path,
                bottleneck,
                totalFlow,
                minYear: globalMin,
                maxYear: globalMax
              });
              cyclesByHops[path.length]++;
            }
          }
          foundCycle = true;
        } else if (!blocked.has(w) && depth < maxHops) {
          // Continue DFS (don't exceed maxHops depth)
          if (circuit(w, depth + 1)) {
            foundCycle = true;
          }
        }
      }

      if (foundCycle) {
        unblock(v);
      } else {
        // Add v to block lists of its neighbors
        for (const edge of neighbors) {
          const w = edge.dst;
          if (!nodesInGraph.has(w)) continue;
          if (w < s) continue;
          if (!blockMap.has(w)) blockMap.set(w, new Set());
          blockMap.get(w).add(v);
        }
      }

      stack.pop();
      return foundCycle;
    }

    circuit(s, 1);

    // Remove s from the subgraph for future iterations
    // (Johnson's processes nodes in order, removing each after use)
    nodesInGraph.delete(s);

    // Progress logging every 500 nodes
    if ((nodes.indexOf(s) + 1) % 500 === 0 || nodes.indexOf(s) === nodes.length - 1) {
      const idx = nodes.indexOf(s) + 1;
      const pct = ((idx / nodes.length) * 100).toFixed(1);
      const total = cycles.length;
      log.info(`  Progress: ${idx.toLocaleString()}/${nodes.length.toLocaleString()} nodes (${pct}%), ${total.toLocaleString()} cycles found`);
    }
  }

  return { cycles, cyclesByHops };
}

// ─── Write Results to DB ─────────────────────────────────────────────────────

async function writeCycles(client, cycles) {
  log.info(`\nWriting ${cycles.length.toLocaleString()} cycles to cra.johnson_cycles...`);
  await client.query('TRUNCATE cra.johnson_cycles');

  // Batch insert
  const batchSize = args.batchSize;
  let written = 0;

  for (let i = 0; i < cycles.length; i += batchSize) {
    const batch = cycles.slice(i, i + batchSize);
    const values = [];
    const params = [];
    let paramIdx = 1;

    for (const c of batch) {
      const pathDisplay = c.path.join('→') + '→' + c.path[0];
      values.push(`($${paramIdx}, $${paramIdx + 1}, $${paramIdx + 2}, $${paramIdx + 3}, $${paramIdx + 4}, $${paramIdx + 5}, $${paramIdx + 6})`);
      params.push(
        c.hops,
        `{${c.path.join(',')}}`,
        pathDisplay,
        c.bottleneck,
        c.totalFlow,
        c.minYear,
        c.maxYear
      );
      paramIdx += 7;
    }

    await client.query(`
      INSERT INTO cra.johnson_cycles (hops, path_bns, path_display, bottleneck_amt, total_flow, min_year, max_year)
      VALUES ${values.join(', ')}
      ON CONFLICT (path_display) DO NOTHING
    `, params);

    written += batch.length;
    if (written % 10000 === 0 || written === cycles.length) {
      log.info(`  Written ${written.toLocaleString()} / ${cycles.length.toLocaleString()}`);
    }
  }
}

// ─── Cross-Reference with Self-Join Results ──────────────────────────────────

async function crossReference(client) {
  log.info('\nCross-referencing with cra.loops (self-join results)...');

  const johnsonCounts = await client.query(
    'SELECT hops, COUNT(*) AS cnt FROM cra.johnson_cycles GROUP BY hops ORDER BY hops'
  );
  const selfJoinCounts = await client.query(
    'SELECT hops, COUNT(*) AS cnt FROM cra.loops GROUP BY hops ORDER BY hops'
  );

  const jMap = new Map();
  for (const r of johnsonCounts.rows) jMap.set(parseInt(r.hops), parseInt(r.cnt));
  const sMap = new Map();
  for (const r of selfJoinCounts.rows) sMap.set(parseInt(r.hops), parseInt(r.cnt));

  const allHops = new Set([...jMap.keys(), ...sMap.keys()]);

  log.info('  Hops | Johnson | Self-Join | Match?');
  log.info('  ─────┼─────────┼──────────┼───────');
  for (const h of [...allHops].sort((a, b) => a - b)) {
    const j = jMap.get(h) || 0;
    const s = sMap.get(h) || 0;
    const match = j === s ? '✓' : `✗ (diff: ${Math.abs(j - s)})`;
    log.info(`  ${String(h).padStart(4)} | ${String(j).padStart(7).toLocaleString()} | ${String(s).padStart(8).toLocaleString()} | ${match}`);
  }

  // Check for cycles in Johnson but not in self-join (and vice versa)
  const onlyJohnson = await client.query(`
    SELECT COUNT(*) AS c FROM cra.johnson_cycles j
    WHERE NOT EXISTS (SELECT 1 FROM cra.loops l WHERE l.path_display = j.path_display)
  `);
  const onlySelfJoin = await client.query(`
    SELECT COUNT(*) AS c FROM cra.loops l
    WHERE NOT EXISTS (SELECT 1 FROM cra.johnson_cycles j WHERE j.path_display = l.path_display)
  `);

  log.info(`\n  Only in Johnson:  ${parseInt(onlyJohnson.rows[0].c).toLocaleString()}`);
  log.info(`  Only in Self-Join: ${parseInt(onlySelfJoin.rows[0].c).toLocaleString()}`);
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  log.section('Step 2: Johnson\'s Algorithm — Cycle Enumeration');
  log.info(`Max hops:     ${args.maxHops}`);
  log.info(`Year window:  ${args.yearWindow}`);
  log.info(`Threshold:    $${args.threshold.toLocaleString()} (for reference — uses pre-pruned edges)`);

  const client = await db.getClient();

  try {
    // migrate() is idempotent (CREATE TABLE / INDEX IF NOT EXISTS) so we
    // always run it — no --migrate flag required, survives drop-loop-tables.
    await migrate(client);

    // Load graph
    const graph = await loadGraph(client);
    if (!graph) return;

    // Run Johnson's
    log.info('\nRunning Johnson\'s algorithm...');
    const t0 = Date.now();
    const { cycles, cyclesByHops } = johnsonEnumerate(graph, args.maxHops, args.yearWindow);
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

    log.info(`\nJohnson's complete in ${elapsed}s`);
    log.info('\n  ── Results by hop count ──');
    let total = 0;
    for (let h = 2; h <= args.maxHops; h++) {
      if (cyclesByHops[h] > 0) {
        log.info(`    ${h}-hop: ${cyclesByHops[h].toLocaleString()}`);
        total += cyclesByHops[h];
      }
    }
    log.info(`    Total: ${total.toLocaleString()} cycles`);

    // Write to DB
    await writeCycles(client, cycles);

    // Cross-reference
    await crossReference(client);

    log.section('Step 2 Complete');

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
