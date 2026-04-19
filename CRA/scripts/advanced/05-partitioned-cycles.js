/**
 * 05-partitioned-cycles.js
 *
 * Partitioned cycle detection: fast complete results by SCC size.
 *
 * ─── STRATEGY ───────────────────────────────────────────────────────────────
 *
 * The giant SCC (8,971 nodes, mostly JW denominational network) is what
 * kills both Johnson's and self-joins at higher hop counts. But the 338
 * small SCCs (2-50 nodes each) are trivial to enumerate.
 *
 * This script:
 *
 *   TIER 1 — Small SCCs (< threshold size, default 500 nodes):
 *     Run Johnson's at full depth (2-8 hops). Completes in seconds.
 *     These are the forensically interesting networks — small clusters
 *     of charities passing money in circles with no obvious denominational
 *     relationship.
 *
 *   TIER 2 — Giant SCC(s) (>= threshold size):
 *     Option A: Re-prune with a higher gift threshold ($50K, $100K) to
 *               thin the graph, then decompose into smaller SCCs and
 *               run Johnson's on those.
 *     Option B: Identify hub nodes (top N by degree) and temporarily
 *               remove them, fragmenting the giant SCC into smaller
 *               pieces, then enumerate cycles in each fragment.
 *     Option C: Run Johnson's at reduced depth (e.g., max 5 hops).
 *
 * Results go to cra.partitioned_cycles with a tier/source label so you
 * can distinguish which method found each cycle.
 *
 * ─── USAGE ──────────────────────────────────────────────────────────────────
 *
 *   node 05-partitioned-cycles.js --migrate
 *   node 05-partitioned-cycles.js                          # default: tier1 + tier2 at higher threshold
 *   node 05-partitioned-cycles.js --scc-cap 200            # treat SCCs > 200 nodes as "giant"
 *   node 05-partitioned-cycles.js --tier2-threshold 50000  # re-prune giant SCCs at $50K
 *   node 05-partitioned-cycles.js --tier2-max-hops 5       # cap giant SCC depth
 *   node 05-partitioned-cycles.js --tier1-only             # skip giant SCCs entirely
 */

const db = require('../../lib/db');
const log = require('../../lib/logger');

// ─── CLI Args ────────────────────────────────────────────────────────────────

function parseArgs() {
  const args = {
    migrate: false,
    maxHops: 8,
    yearWindow: 1,
    threshold: 5000,          // base threshold (used for tier 1, reads existing edges)
    sccCap: 500,              // SCCs above this size go to tier 2
    tier2Threshold: 50000,    // re-prune giant SCCs at this higher threshold
    tier2MaxHops: 6,          // max depth for giant SCC analysis
    tier1Only: false,         // skip tier 2 entirely
    tier2HubRemoval: true,    // remove top-degree hubs from giant SCCs
    hubRemoveCount: 20,       // how many top hubs to remove
  };
  for (let i = 2; i < process.argv.length; i++) {
    const a = process.argv[i];
    const next = process.argv[i + 1];
    if (a === '--migrate')                   { args.migrate = true; }
    else if (a === '--max-hops' && next)     { args.maxHops = parseInt(next, 10) || args.maxHops; i++; }
    else if (a === '--year-window' && next)  { args.yearWindow = parseInt(next, 10); i++; }
    else if (a === '--scc-cap' && next)      { args.sccCap = parseInt(next, 10) || args.sccCap; i++; }
    else if (a === '--tier2-threshold' && next) { args.tier2Threshold = parseInt(next, 10) || args.tier2Threshold; i++; }
    else if (a === '--tier2-max-hops' && next)  { args.tier2MaxHops = parseInt(next, 10) || args.tier2MaxHops; i++; }
    else if (a === '--tier1-only')           { args.tier1Only = true; }
    else if (a === '--no-hub-removal')       { args.tier2HubRemoval = false; }
    else if (a === '--hub-count' && next)    { args.hubRemoveCount = parseInt(next, 10) || args.hubRemoveCount; i++; }
  }
  return args;
}

const args = parseArgs();

// ─── Migration ───────────────────────────────────────────────────────────────

async function migrate(client) {
  log.info('Running migration...');
  await client.query(`
    CREATE TABLE IF NOT EXISTS cra.partitioned_cycles (
      id             serial PRIMARY KEY,
      hops           int NOT NULL,
      path_bns       varchar(15)[] NOT NULL,
      path_display   text NOT NULL UNIQUE,
      bottleneck_amt numeric,
      total_flow     numeric,
      min_year       int,
      max_year       int,
      tier           varchar(20) NOT NULL,
      source_scc_id  int,
      source_scc_size int
    );
    CREATE INDEX IF NOT EXISTS idx_part_cycles_hops ON cra.partitioned_cycles (hops);
    CREATE INDEX IF NOT EXISTS idx_part_cycles_tier ON cra.partitioned_cycles (tier);
    CREATE INDEX IF NOT EXISTS idx_part_cycles_display ON cra.partitioned_cycles (path_display);

    -- Hub charities identified during analysis
    CREATE TABLE IF NOT EXISTS cra.identified_hubs (
      bn              varchar(15) PRIMARY KEY,
      legal_name      text,
      scc_id          int,
      in_degree       int DEFAULT 0,
      out_degree      int DEFAULT 0,
      total_degree    int DEFAULT 0,
      total_inflow    numeric DEFAULT 0,
      total_outflow   numeric DEFAULT 0,
      hub_type        varchar(50)
    );
  `);
  log.info('Migration complete.');
}

// ─── Load Graph from Edge Table ──────────────────────────────────────────────

async function loadEdges(client, extraWhereClause) {
  const where = extraWhereClause ? `WHERE ${extraWhereClause}` : '';
  const res = await client.query(`
    SELECT src, dst, total_amt, min_year, max_year
    FROM cra.loop_edges
    ${where}
    ORDER BY src, dst
  `);

  const adj = new Map();
  const nodeSet = new Set();
  const edgeMap = new Map();

  for (const row of res.rows) {
    if (!adj.has(row.src)) adj.set(row.src, []);
    adj.get(row.src).push({
      dst: row.dst,
      amt: parseFloat(row.total_amt),
      minYear: parseInt(row.min_year),
      maxYear: parseInt(row.max_year)
    });
    nodeSet.add(row.src);
    nodeSet.add(row.dst);
    edgeMap.set(`${row.src}|${row.dst}`, {
      amt: parseFloat(row.total_amt),
      minYear: parseInt(row.min_year),
      maxYear: parseInt(row.max_year)
    });
  }

  for (const n of nodeSet) {
    if (!adj.has(n)) adj.set(n, []);
  }

  return { adj, nodes: Array.from(nodeSet).sort(), edgeMap, edgeCount: res.rows.length };
}

// ─── Load SCC assignments ────────────────────────────────────────────────────

async function loadSCCs(client) {
  const res = await client.query(`
    SELECT scc_id, scc_size, array_agg(bn ORDER BY bn) AS members
    FROM cra.scc_components
    WHERE scc_size >= 2
    GROUP BY scc_id, scc_size
    ORDER BY scc_size DESC
  `);

  return res.rows.map(r => ({
    id: parseInt(r.scc_id),
    size: parseInt(r.scc_size),
    members: new Set(r.members)
  }));
}

// ─── Subgraph Extraction ─────────────────────────────────────────────────────

function extractSubgraph(fullGraph, nodeSet) {
  const adj = new Map();
  const edgeMap = new Map();
  const nodes = [];

  for (const n of nodeSet) {
    nodes.push(n);
    const neighbors = fullGraph.adj.get(n) || [];
    const filtered = neighbors.filter(e => nodeSet.has(e.dst));
    adj.set(n, filtered);
    for (const e of filtered) {
      edgeMap.set(`${n}|${e.dst}`, { amt: e.amt, minYear: e.minYear, maxYear: e.maxYear });
    }
  }

  nodes.sort();
  return { adj, nodes, edgeMap };
}

// ─── Tarjan's SCC (iterative) ────────────────────────────────────────────────

function tarjanSCC(adj, nodes) {
  let index = 0;
  const indices = new Map();
  const lowlinks = new Map();
  const onStack = new Set();
  const stack = [];
  const sccs = [];

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
        const w = typeof neighbors[frame.neighborIdx] === 'object'
          ? neighbors[frame.neighborIdx].dst
          : neighbors[frame.neighborIdx];
        frame.neighborIdx++;

        if (!indices.has(w)) {
          indices.set(w, index);
          lowlinks.set(w, index);
          index++;
          stack.push(w);
          onStack.add(w);
          callStack.push({ node: w, neighborIdx: 0 });
        } else if (onStack.has(w)) {
          lowlinks.set(v, Math.min(lowlinks.get(v), indices.get(w)));
        }
      } else {
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

// ─── Johnson's Algorithm (bounded) ───────────────────────────────────────────

function johnsonOnSubgraph(graph, maxHops, yearWindow) {
  const { adj, nodes, edgeMap } = graph;
  const cycles = [];
  const nodesInGraph = new Set(nodes);

  for (const s of nodes) {
    if (!nodesInGraph.has(s)) continue;

    const blocked = new Set();
    const blockMap = new Map();
    const stack = [];

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
        if (!nodesInGraph.has(w)) continue;
        if (w < s) continue;

        if (w === s && stack.length >= 2 && stack.length <= maxHops) {
          const path = [...stack];
          let globalMin = Infinity, globalMax = -Infinity;
          let bottleneck = Infinity, totalFlow = 0;
          let valid = true;

          for (let i = 0; i < path.length; i++) {
            const from = path[i];
            const to = path[(i + 1) % path.length];
            const e = edgeMap.get(`${from}|${to}`);
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
          }
          foundCycle = true;
        } else if (w === s) {
          foundCycle = true;
        } else if (!blocked.has(w) && depth < maxHops) {
          if (circuit(w, depth + 1)) foundCycle = true;
        }
      }

      if (foundCycle) {
        unblock(v);
      } else {
        for (const edge of neighbors) {
          const w = edge.dst;
          if (!nodesInGraph.has(w) || w < s) continue;
          if (!blockMap.has(w)) blockMap.set(w, new Set());
          blockMap.get(w).add(v);
        }
      }

      stack.pop();
      return foundCycle;
    }

    circuit(s, 1);
    nodesInGraph.delete(s);
  }

  return cycles;
}

// ─── Identify Hub Nodes ──────────────────────────────────────────────────────

function identifyHubs(graph, sccMembers, count) {
  const degrees = new Map();

  for (const [src, neighbors] of graph.adj) {
    if (!sccMembers.has(src)) continue;
    for (const edge of neighbors) {
      if (!sccMembers.has(edge.dst)) continue;

      const srcD = degrees.get(src) || { inDeg: 0, outDeg: 0, inFlow: 0, outFlow: 0 };
      srcD.outDeg++;
      srcD.outFlow += edge.amt;
      degrees.set(src, srcD);

      const dstD = degrees.get(edge.dst) || { inDeg: 0, outDeg: 0, inFlow: 0, outFlow: 0 };
      dstD.inDeg++;
      dstD.inFlow += edge.amt;
      degrees.set(edge.dst, dstD);
    }
  }

  // Rank by total degree
  const ranked = Array.from(degrees.entries())
    .map(([bn, d]) => ({ bn, ...d, totalDeg: d.inDeg + d.outDeg, totalFlow: d.inFlow + d.outFlow }))
    .sort((a, b) => b.totalDeg - a.totalDeg);

  return ranked.slice(0, count);
}

// ─── Batch Write Cycles ──────────────────────────────────────────────────────

async function writeCycles(client, cycles, tier, sccId, sccSize) {
  if (cycles.length === 0) return;

  const batchSize = 2000;
  for (let i = 0; i < cycles.length; i += batchSize) {
    const batch = cycles.slice(i, i + batchSize);
    const values = [];
    const params = [];
    let p = 1;

    for (const c of batch) {
      const pathDisplay = c.path.join('→') + '→' + c.path[0];
      values.push(`($${p},$${p+1},$${p+2},$${p+3},$${p+4},$${p+5},$${p+6},$${p+7},$${p+8},$${p+9})`);
      params.push(
        c.hops,
        `{${c.path.join(',')}}`,
        pathDisplay,
        c.bottleneck,
        c.totalFlow,
        c.minYear,
        c.maxYear,
        tier,
        sccId || null,
        sccSize || null
      );
      p += 10;
    }

    await client.query(`
      INSERT INTO cra.partitioned_cycles
        (hops, path_bns, path_display, bottleneck_amt, total_flow, min_year, max_year, tier, source_scc_id, source_scc_size)
      VALUES ${values.join(', ')}
      ON CONFLICT (path_display) DO NOTHING
    `, params);
  }
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  log.section('Step 5: Partitioned Cycle Detection');
  log.info(`SCC size cap:      ${args.sccCap} (SCCs above this → tier 2)`);
  log.info(`Max hops (tier 1): ${args.maxHops}`);
  log.info(`Year window:       ${args.yearWindow}`);
  if (!args.tier1Only) {
    log.info(`Tier 2 threshold:  $${args.tier2Threshold.toLocaleString()}`);
    log.info(`Tier 2 max hops:   ${args.tier2MaxHops}`);
    log.info(`Hub removal:       ${args.tier2HubRemoval ? `yes (top ${args.hubRemoveCount})` : 'no'}`);
  } else {
    log.info(`Tier 2:            SKIPPED (--tier1-only)`);
  }

  const client = await db.getClient();

  try {
    // migrate() is idempotent (CREATE TABLE / INDEX IF NOT EXISTS) so we
    // always run it — no --migrate flag required, survives drop-loop-tables.
    await migrate(client);

    // Load full graph and SCC assignments
    const fullGraph = await loadEdges(client);
    log.info(`\nLoaded ${fullGraph.edgeCount.toLocaleString()} edges, ${fullGraph.nodes.length.toLocaleString()} nodes`);

    const sccs = await loadSCCs(client);
    log.info(`Loaded ${sccs.length} non-trivial SCCs`);

    await client.query('TRUNCATE cra.partitioned_cycles');
    await client.query('TRUNCATE cra.identified_hubs');

    const tier1SCCs = sccs.filter(s => s.size < args.sccCap);
    const tier2SCCs = sccs.filter(s => s.size >= args.sccCap);

    log.info(`\n  Tier 1 (< ${args.sccCap} nodes): ${tier1SCCs.length} SCCs, ${tier1SCCs.reduce((s, c) => s + c.size, 0).toLocaleString()} nodes`);
    log.info(`  Tier 2 (>= ${args.sccCap} nodes): ${tier2SCCs.length} SCCs, ${tier2SCCs.reduce((s, c) => s + c.size, 0).toLocaleString()} nodes`);

    // ═══════════════════════════════════════════════════════════════════
    // TIER 1: Full Johnson's on small SCCs
    // ═══════════════════════════════════════════════════════════════════

    log.info('\n══════════════════════════════════════');
    log.info('  TIER 1: Small/Medium SCCs');
    log.info('══════════════════════════════════════');

    let tier1Total = 0;
    const tier1Hops = {};
    for (let h = 2; h <= args.maxHops; h++) tier1Hops[h] = 0;

    const t1Start = Date.now();

    for (let i = 0; i < tier1SCCs.length; i++) {
      const scc = tier1SCCs[i];
      const subgraph = extractSubgraph(fullGraph, scc.members);

      // Skip if subgraph has no edges (all edges were inter-SCC)
      let edgeCount = 0;
      for (const [, neighbors] of subgraph.adj) edgeCount += neighbors.length;
      if (edgeCount === 0) continue;

      const cycles = johnsonOnSubgraph(subgraph, args.maxHops, args.yearWindow);

      if (cycles.length > 0) {
        await writeCycles(client, cycles, 'tier1_small_scc', scc.id, scc.size);
        tier1Total += cycles.length;
        for (const c of cycles) tier1Hops[c.hops]++;
      }

      // Progress every 50 SCCs
      if ((i + 1) % 50 === 0 || i === tier1SCCs.length - 1) {
        log.info(`  Processed ${i + 1}/${tier1SCCs.length} small SCCs, ${tier1Total.toLocaleString()} cycles so far`);
      }
    }

    const t1Elapsed = ((Date.now() - t1Start) / 1000).toFixed(1);
    log.info(`\n  Tier 1 complete: ${tier1Total.toLocaleString()} cycles in ${t1Elapsed}s`);
    for (let h = 2; h <= args.maxHops; h++) {
      if (tier1Hops[h] > 0) log.info(`    ${h}-hop: ${tier1Hops[h].toLocaleString()}`);
    }

    // ═══════════════════════════════════════════════════════════════════
    // TIER 2: Giant SCCs — re-threshold + hub removal + re-decompose
    // ═══════════════════════════════════════════════════════════════════

    if (!args.tier1Only && tier2SCCs.length > 0) {
      log.info('\n══════════════════════════════════════');
      log.info('  TIER 2: Giant SCCs');
      log.info('══════════════════════════════════════');

      for (const giantSCC of tier2SCCs) {
        log.info(`\n  Processing giant SCC #${giantSCC.id}: ${giantSCC.size.toLocaleString()} nodes`);

        // Step A: Identify hubs
        const hubs = identifyHubs(fullGraph, giantSCC.members, args.hubRemoveCount);
        log.info(`  Top ${hubs.length} hubs by degree:`);
        for (const h of hubs.slice(0, 10)) {
          log.info(`    ${h.bn}: degree=${h.totalDeg}, flow=$${h.totalFlow.toLocaleString()}`);
        }

        // Save hubs to DB
        for (const h of hubs) {
          await client.query(`
            INSERT INTO cra.identified_hubs (bn, scc_id, in_degree, out_degree, total_degree, total_inflow, total_outflow, hub_type)
            VALUES ($1, $2, $3, $4, $5, $6, $7, 'degree_top_n')
            ON CONFLICT (bn) DO UPDATE SET
              in_degree = EXCLUDED.in_degree, out_degree = EXCLUDED.out_degree,
              total_degree = EXCLUDED.total_degree, total_inflow = EXCLUDED.total_inflow,
              total_outflow = EXCLUDED.total_outflow
          `, [h.bn, giantSCC.id, h.inDeg, h.outDeg, h.totalDeg, h.inFlow, h.outFlow]);
        }

        // Backfill hub names
        await client.query(`
          UPDATE cra.identified_hubs ih
          SET legal_name = sub.legal_name
          FROM (
            SELECT DISTINCT ON (bn) bn, legal_name
            FROM cra.cra_identification ORDER BY bn, fiscal_year DESC
          ) sub
          WHERE ih.bn = sub.bn AND ih.legal_name IS NULL
        `);

        // Log hub names
        const hubNames = await client.query(`
          SELECT bn, legal_name, total_degree FROM cra.identified_hubs
          WHERE scc_id = $1 ORDER BY total_degree DESC LIMIT 10
        `, [giantSCC.id]);
        log.info(`\n  Identified hubs (with names):`);
        for (const r of hubNames.rows) {
          log.info(`    ${r.bn}: ${(r.legal_name || 'Unknown').substring(0, 50)} (degree: ${r.total_degree})`);
        }

        // Step B: Build subgraph with hubs removed + higher threshold
        const hubSet = new Set(hubs.map(h => h.bn));
        const remainingMembers = new Set([...giantSCC.members].filter(n => !hubSet.has(n)));
        log.info(`\n  After hub removal: ${remainingMembers.size.toLocaleString()} nodes (removed ${hubSet.size})`);

        // Extract subgraph, also filter by higher threshold
        const subAdj = new Map();
        const subEdgeMap = new Map();
        const subNodes = [];

        for (const n of remainingMembers) {
          subNodes.push(n);
          const neighbors = (fullGraph.adj.get(n) || [])
            .filter(e => remainingMembers.has(e.dst) && e.amt >= args.tier2Threshold);
          subAdj.set(n, neighbors);
          for (const e of neighbors) {
            subEdgeMap.set(`${n}|${e.dst}`, { amt: e.amt, minYear: e.minYear, maxYear: e.maxYear });
          }
        }
        subNodes.sort();

        // Count remaining edges
        let subEdgeCount = 0;
        for (const [, neighbors] of subAdj) subEdgeCount += neighbors.length;
        log.info(`  After $${args.tier2Threshold.toLocaleString()} threshold: ${subEdgeCount.toLocaleString()} edges`);

        // Step C: Re-decompose into new SCCs
        const subSCCs = tarjanSCC(subAdj, subNodes);
        const nonTrivialSub = subSCCs.filter(s => s.length >= 2);
        log.info(`  Re-decomposed into ${nonTrivialSub.length} non-trivial sub-SCCs`);

        if (nonTrivialSub.length > 0) {
          const maxSubSize = Math.max(...nonTrivialSub.map(s => s.length));
          log.info(`  Largest sub-SCC: ${maxSubSize} nodes`);
        }

        // Step D: Run Johnson's on each sub-SCC
        let tier2Total = 0;
        const tier2Hops = {};
        for (let h = 2; h <= args.tier2MaxHops; h++) tier2Hops[h] = 0;

        const t2Start = Date.now();

        for (let i = 0; i < nonTrivialSub.length; i++) {
          const subSccNodes = new Set(nonTrivialSub[i]);
          const fragment = {
            adj: new Map(),
            nodes: nonTrivialSub[i].sort(),
            edgeMap: new Map()
          };

          for (const n of subSccNodes) {
            const neighbors = (subAdj.get(n) || []).filter(e => subSccNodes.has(e.dst));
            fragment.adj.set(n, neighbors);
            for (const e of neighbors) {
              fragment.edgeMap.set(`${n}|${e.dst}`, subEdgeMap.get(`${n}|${e.dst}`));
            }
          }

          const maxHopsForThis = fragment.nodes.length > 500
            ? Math.min(args.tier2MaxHops, 5)  // extra safety for large fragments
            : args.tier2MaxHops;

          const cycles = johnsonOnSubgraph(fragment, maxHopsForThis, args.yearWindow);

          if (cycles.length > 0) {
            await writeCycles(client, cycles, 'tier2_giant_scc', giantSCC.id, giantSCC.size);
            tier2Total += cycles.length;
            for (const c of cycles) {
              if (tier2Hops[c.hops] !== undefined) tier2Hops[c.hops]++;
            }
          }

          if ((i + 1) % 100 === 0 || i === nonTrivialSub.length - 1) {
            log.info(`    Sub-SCCs: ${i + 1}/${nonTrivialSub.length}, ${tier2Total.toLocaleString()} cycles`);
          }
        }

        const t2Elapsed = ((Date.now() - t2Start) / 1000).toFixed(1);
        log.info(`\n  Tier 2 for SCC #${giantSCC.id}: ${tier2Total.toLocaleString()} cycles in ${t2Elapsed}s`);
        for (let h = 2; h <= args.tier2MaxHops; h++) {
          if (tier2Hops[h] > 0) log.info(`    ${h}-hop: ${tier2Hops[h].toLocaleString()}`);
        }
      }
    }

    // ═══════════════════════════════════════════════════════════════════
    // SUMMARY
    // ═══════════════════════════════════════════════════════════════════

    const summary = await client.query(`
      SELECT tier, hops, COUNT(*) AS cnt
      FROM cra.partitioned_cycles
      GROUP BY tier, hops
      ORDER BY tier, hops
    `);

    log.info('\n══════════════════════════════════════');
    log.info('  FINAL SUMMARY');
    log.info('══════════════════════════════════════');

    let grandTotal = 0;
    let currentTier = '';
    for (const r of summary.rows) {
      if (r.tier !== currentTier) {
        currentTier = r.tier;
        log.info(`\n  ${currentTier}:`);
      }
      const cnt = parseInt(r.cnt);
      log.info(`    ${r.hops}-hop: ${cnt.toLocaleString()}`);
      grandTotal += cnt;
    }
    log.info(`\n  Grand total: ${grandTotal.toLocaleString()} unique cycles`);

    // Cross-reference with self-join results
    log.info('\n  ── Cross-reference with cra.loops ──');
    const overlap = await client.query(`
      SELECT
        (SELECT COUNT(*) FROM cra.partitioned_cycles) AS partitioned,
        (SELECT COUNT(*) FROM cra.loops) AS selfjoin,
        (SELECT COUNT(*) FROM cra.partitioned_cycles p
         WHERE EXISTS (SELECT 1 FROM cra.loops l WHERE l.path_display = p.path_display)) AS both
    `).catch(() => ({ rows: [{ partitioned: 0, selfjoin: 0, both: 0 }] }));

    const o = overlap.rows[0];
    log.info(`  Partitioned: ${parseInt(o.partitioned).toLocaleString()}`);
    log.info(`  Self-join:   ${parseInt(o.selfjoin).toLocaleString()}`);
    log.info(`  In both:     ${parseInt(o.both).toLocaleString()}`);

    log.section('Step 5 Complete');

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
