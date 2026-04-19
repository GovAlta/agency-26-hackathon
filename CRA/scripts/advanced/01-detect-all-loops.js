/**
 * 01-detect-all-loops.js  (v2 — pruned self-join)
 *
 * Detects circular gifting loops of 2–8 hops in CRA charity data.
 *
 * ─── KEY OPTIMIZATION: ITERATIVE GRAPH PRUNING ─────────────────────────────
 *
 * A node can only be in a cycle if it has both in-edges and out-edges.
 * Removing dead-end nodes creates new dead-ends, so we iterate until stable.
 * In charity giving graphs most gifts flow one-way (foundation → charity),
 * so this typically prunes 70–90% of edges.
 *
 * If pruning takes 237K edges down to 30K, the self-join cost for an 8-hop
 * query drops by a factor of roughly (237/30)^8 ≈ 16 million.
 *
 * ─── TEMPORAL CONSTRAINT ────────────────────────────────────────────────────
 *
 * Edges carry min_year/max_year. During cycle detection:
 *   GREATEST(all edge max_years) - LEAST(all edge min_years) <= yearWindow
 * Enforces "the entire loop completes within the same FY + N years."
 *
 * ─── USAGE ──────────────────────────────────────────────────────────────────
 *
 *   node 01-detect-all-loops.js --migrate          # first run
 *   node 01-detect-all-loops.js                    # defaults: 5K threshold, 8 hops, 1yr window
 *   node 01-detect-all-loops.js --threshold 10000 --max-hops 6 --year-window 0
 */

const db = require('../../lib/db');
const log = require('../../lib/logger');

// ─── CLI Args ────────────────────────────────────────────────────────────────

function parseArgs() {
  const args = { threshold: 5000, minHops: 2, maxHops: 6, yearWindow: 1, migrate: false };
  for (let i = 2; i < process.argv.length; i++) {
    const a = process.argv[i];
    const next = process.argv[i + 1];
    if (a === '--threshold' && next)        { args.threshold  = parseInt(next, 10) || args.threshold; i++; }
    else if (a === '--min-hops' && next)    { args.minHops    = parseInt(next, 10) || args.minHops; i++; }
    else if (a === '--max-hops' && next)    { args.maxHops    = parseInt(next, 10) || args.maxHops; i++; }
    else if (a === '--year-window' && next) { args.yearWindow = parseInt(next, 10); i++; }
    else if (a === '--migrate')             { args.migrate    = true; }
  }
  args.maxHops = Math.min(Math.max(args.maxHops, 2), 8);
  return args;
}

const args = parseArgs();

// ─── Migration ───────────────────────────────────────────────────────────────

async function migrate(client) {
  log.info('Running migration...');
  await client.query(`
    CREATE TABLE IF NOT EXISTS cra.loop_edges (
      src         varchar(15) NOT NULL,
      dst         varchar(15) NOT NULL,
      total_amt   numeric     NOT NULL DEFAULT 0,
      edge_count  int         NOT NULL DEFAULT 0,
      min_year    int,
      max_year    int,
      years       int[],
      PRIMARY KEY (src, dst)
    );

    CREATE TABLE IF NOT EXISTS cra.loops (
      id             serial PRIMARY KEY,
      hops           int NOT NULL,
      path_bns       varchar(15)[] NOT NULL,
      path_display   text NOT NULL UNIQUE,
      bottleneck_amt numeric,
      total_flow     numeric,
      min_year       int,
      max_year       int
    );

    CREATE TABLE IF NOT EXISTS cra.loop_participants (
      bn               varchar(15) NOT NULL,
      loop_id          int NOT NULL REFERENCES cra.loops(id) ON DELETE CASCADE,
      position_in_loop int NOT NULL,
      sends_to         varchar(15),
      receives_from    varchar(15),
      PRIMARY KEY (loop_id, position_in_loop)
    );

    CREATE TABLE IF NOT EXISTS cra.loop_universe (
      bn                 varchar(15) PRIMARY KEY,
      legal_name         text,
      total_loops        int DEFAULT 0,
      loops_2hop         int DEFAULT 0,
      loops_3hop         int DEFAULT 0,
      loops_4hop         int DEFAULT 0,
      loops_5hop         int DEFAULT 0,
      loops_6hop         int DEFAULT 0,
      loops_7plus        int DEFAULT 0,
      max_bottleneck     numeric DEFAULT 0,
      total_circular_amt numeric DEFAULT 0,
      -- Filled in by 02-score-universe.js. Declared here so the column
      -- exists on a fresh install (CREATE TABLE IF NOT EXISTS). On
      -- pre-existing DBs that were created before these fields were
      -- added, the ALTER TABLE below backfills them idempotently.
      score              int,
      scored_at          timestamptz
    );
    ALTER TABLE cra.loop_universe ADD COLUMN IF NOT EXISTS score     int;
    ALTER TABLE cra.loop_universe ADD COLUMN IF NOT EXISTS scored_at timestamptz;
  `);

  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_loop_edges_src     ON cra.loop_edges (src);
    CREATE INDEX IF NOT EXISTS idx_loop_edges_dst     ON cra.loop_edges (dst);
    CREATE INDEX IF NOT EXISTS idx_loop_edges_dst_src ON cra.loop_edges (dst, src);
    CREATE INDEX IF NOT EXISTS idx_loops_hops         ON cra.loops (hops);
    CREATE INDEX IF NOT EXISTS idx_loop_part_bn       ON cra.loop_participants (bn);
  `);

  log.info('Migration complete.');
}

// ─── Phase 1: Build & Prune Edge Table ───────────────────────────────────────

async function buildAndPruneEdges(client) {
  log.info('\nPhase 1a: Building raw edge table...');
  await client.query('TRUNCATE cra.loop_edges');

  await client.query(`
    INSERT INTO cra.loop_edges (src, dst, total_amt, edge_count, min_year, max_year, years)
    SELECT
      bn, donee_bn,
      SUM(total_gifts),
      COUNT(*),
      MIN(EXTRACT(YEAR FROM fpe)::int),
      MAX(EXTRACT(YEAR FROM fpe)::int),
      ARRAY_AGG(DISTINCT EXTRACT(YEAR FROM fpe)::int ORDER BY EXTRACT(YEAR FROM fpe)::int)
    FROM cra.cra_qualified_donees
    WHERE donee_bn IS NOT NULL
      AND TRIM(donee_bn) != ''
      AND LENGTH(TRIM(donee_bn)) = 15
      AND bn != donee_bn
      AND total_gifts >= $1
    GROUP BY bn, donee_bn
  `, [args.threshold]);

  let edgeCount = await getCount(client, 'cra.loop_edges');
  let nodeCount = await getDistinctNodeCount(client);
  const rawEdges = edgeCount;
  log.info(`  ${edgeCount.toLocaleString()} raw edges, ${nodeCount.toLocaleString()} nodes`);

  // ── Iterative dead-end pruning ─────────────────────────────────
  log.info('\nPhase 1b: Iterative dead-end pruning...');

  let round = 0;
  let prevCount = edgeCount;

  while (true) {
    round++;

    // Remove edges where src has no in-edges (no one sends TO src)
    await client.query(`
      DELETE FROM cra.loop_edges e
      WHERE NOT EXISTS (
        SELECT 1 FROM cra.loop_edges e2 WHERE e2.dst = e.src AND e2.src != e.src
      )
    `);

    // Remove edges where dst has no out-edges (dst never sends onward)
    await client.query(`
      DELETE FROM cra.loop_edges e
      WHERE NOT EXISTS (
        SELECT 1 FROM cra.loop_edges e2 WHERE e2.src = e.dst AND e2.dst != e.dst
      )
    `);

    edgeCount = await getCount(client, 'cra.loop_edges');
    const pruned = prevCount - edgeCount;

    if (pruned === 0) {
      log.info(`  Round ${round}: stable at ${edgeCount.toLocaleString()} edges`);
      break;
    }

    log.info(`  Round ${round}: pruned ${pruned.toLocaleString()} → ${edgeCount.toLocaleString()} edges`);
    prevCount = edgeCount;
  }

  nodeCount = await getDistinctNodeCount(client);
  const reductionPct = rawEdges > 0 ? ((1 - edgeCount / rawEdges) * 100).toFixed(1) : 0;
  log.info(`  Final: ${edgeCount.toLocaleString()} edges, ${nodeCount.toLocaleString()} nodes (${reductionPct}% pruned)`);

  await client.query('ANALYZE cra.loop_edges');
  return edgeCount;
}

// ─── Phase 2: Cycle Detection ────────────────────────────────────────────────

function buildCycleQuery(hops, yearWindow) {
  const a = (i) => `e${i}`;

  const from = Array.from({ length: hops }, (_, i) =>
    `cra.loop_edges ${a(i + 1)}`
  ).join(', ');

  const where = [];

  // Chain: e1.dst = e2.src, ..., eN.dst = e1.src
  for (let i = 1; i < hops; i++) {
    where.push(`${a(i)}.dst = ${a(i + 1)}.src`);
  }
  where.push(`${a(hops)}.dst = ${a(1)}.src`);

  // All nodes distinct
  const nodes = Array.from({ length: hops }, (_, i) => `${a(i + 1)}.src`);
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      where.push(`${nodes[i]} <> ${nodes[j]}`);
    }
  }

  // Canonical: e1.src is lex-min
  for (let i = 2; i <= hops; i++) {
    where.push(`${a(1)}.src < ${a(i)}.src`);
  }

  // Temporal constraint
  if (yearWindow >= 0) {
    const maxYears = Array.from({ length: hops }, (_, i) => `${a(i + 1)}.max_year`);
    const minYears = Array.from({ length: hops }, (_, i) => `${a(i + 1)}.min_year`);
    where.push(`GREATEST(${maxYears.join(', ')}) - LEAST(${minYears.join(', ')}) <= ${yearWindow}`);
  }

  const pathArray = `ARRAY[${nodes.join(', ')}]`;
  const pathDisplay = nodes.join(` || '→' || `) + ` || '→' || ${a(1)}.src`;
  const amounts = Array.from({ length: hops }, (_, i) => `${a(i + 1)}.total_amt`);
  const bottleneck = `LEAST(${amounts.join(', ')})`;
  const totalFlow = amounts.join(' + ');
  const globalMin = `LEAST(${Array.from({ length: hops }, (_, i) => `${a(i + 1)}.min_year`).join(', ')})`;
  const globalMax = `GREATEST(${Array.from({ length: hops }, (_, i) => `${a(i + 1)}.max_year`).join(', ')})`;

  return `
    INSERT INTO cra.loops (hops, path_bns, path_display, bottleneck_amt, total_flow, min_year, max_year)
    SELECT ${hops}, ${pathArray}, ${pathDisplay},
           ${bottleneck}, ${totalFlow}, ${globalMin}, ${globalMax}
    FROM ${from}
    WHERE ${where.join('\n      AND ')}
    ON CONFLICT (path_display) DO NOTHING
  `;
}

// ─── Phase 3 & 4 ────────────────────────────────────────────────────────────

async function buildParticipants(client) {
  log.info('\nPhase 3: Building participant index...');
  await client.query('TRUNCATE cra.loop_participants');
  await client.query(`
    INSERT INTO cra.loop_participants (bn, loop_id, position_in_loop, sends_to, receives_from)
    SELECT
      path_bns[i],
      id,
      i,
      path_bns[CASE WHEN i = array_length(path_bns, 1) THEN 1 ELSE i + 1 END],
      path_bns[CASE WHEN i = 1 THEN array_length(path_bns, 1) ELSE i - 1 END]
    FROM cra.loops, generate_series(1, array_length(path_bns, 1)) AS i
    ON CONFLICT DO NOTHING
  `);
  const cnt = await getCount(client, 'cra.loop_participants');
  log.info(`  ${cnt.toLocaleString()} participant entries`);
}

async function buildUniverse(client) {
  log.info('\nPhase 4: Building universe...');
  await client.query('TRUNCATE cra.loop_universe');
  await client.query(`
    INSERT INTO cra.loop_universe (bn, legal_name, total_loops, loops_2hop, loops_3hop,
                                    loops_4hop, loops_5hop, loops_6hop, loops_7plus,
                                    max_bottleneck, total_circular_amt)
    SELECT
      lp.bn,
      (SELECT legal_name FROM cra.cra_identification ci
       WHERE ci.bn = lp.bn ORDER BY fiscal_year DESC LIMIT 1),
      COUNT(DISTINCT lp.loop_id),
      COUNT(DISTINCT lp.loop_id) FILTER (WHERE l.hops = 2),
      COUNT(DISTINCT lp.loop_id) FILTER (WHERE l.hops = 3),
      COUNT(DISTINCT lp.loop_id) FILTER (WHERE l.hops = 4),
      COUNT(DISTINCT lp.loop_id) FILTER (WHERE l.hops = 5),
      COUNT(DISTINCT lp.loop_id) FILTER (WHERE l.hops = 6),
      COUNT(DISTINCT lp.loop_id) FILTER (WHERE l.hops >= 7),
      MAX(l.bottleneck_amt),
      SUM(l.bottleneck_amt)
    FROM cra.loop_participants lp
    JOIN cra.loops l ON lp.loop_id = l.id
    GROUP BY lp.bn
  `);
  const cnt = await getCount(client, 'cra.loop_universe');
  log.info(`  ${cnt.toLocaleString()} unique charities in loops`);
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function getCount(client, table) {
  const res = await client.query(`SELECT COUNT(*) AS c FROM ${table}`);
  return parseInt(res.rows[0].c);
}

async function getDistinctNodeCount(client) {
  const res = await client.query(`
    SELECT COUNT(DISTINCT n) AS c FROM (
      SELECT src AS n FROM cra.loop_edges
      UNION ALL
      SELECT dst AS n FROM cra.loop_edges
    ) t
  `);
  return parseInt(res.rows[0].c);
}

function handleQueryError(err, hops, elapsedMs) {
  const elapsed = (elapsedMs / 1000).toFixed(1);
  if (err.message.includes('timeout') || err.message.includes('cancel')) {
    log.warn(`    Timed out after ${elapsed}s — skipping`);
    return true;
  } else if (err.message.includes('ECONNRESET') || err.message.includes('terminated')) {
    log.warn(`    Connection lost after ${elapsed}s — stopping`);
    return false;
  } else {
    log.error(`    Error after ${elapsed}s: ${err.message}`);
    throw err;
  }
}

function timeoutForHops(hops) {
  // Generous timeouts scaled to complexity. 6-hop gets 12 hours
  // because the pruned 52K-edge self-join is expensive but completes.
  const minutes = { 2: 5, 3: 10, 4: 30, 5: 120, 6: 720, 7: 1440, 8: 1440 };
  return (minutes[hops] || 1440) * 60 * 1000;
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  log.section('Step 1: Detect All Circular Giving Loops');
  log.info(`Threshold:    >= $${args.threshold.toLocaleString()} per hop`);
  log.info(`Hops:         ${args.minHops} to ${args.maxHops}`);
  log.info(`Year window:  ${args.yearWindow} (same FY${args.yearWindow > 0 ? ` + ${args.yearWindow} year(s)` : ' only'})`);

  const client = await db.getClient();

  try {
    // migrate() is idempotent (CREATE TABLE / INDEX IF NOT EXISTS) so we
    // always run it. This makes the script self-bootstrapping for fresh
    // DBs or after a drop-loop-tables wipe — no --migrate flag required.
    await migrate(client);

    // Phase 1
    const edgeCount = await buildAndPruneEdges(client);
    if (edgeCount === 0) {
      log.warn('No edges survive pruning. Check threshold or data.');
      return;
    }

    // Phase 2
    log.info('\nPhase 2: Detecting cycles...');
    if (args.minHops <= 2) {
      await client.query('TRUNCATE cra.loops CASCADE');
      log.info('  Truncated existing loops (full run from hop 2).');
    } else {
      log.info('  Preserving existing loops (starting from hop ' + args.minHops + ').');
    }

    for (let hops = args.minHops; hops <= args.maxHops; hops++) {
      const timeout = timeoutForHops(hops);
      log.info(`\n  ${hops}-hop (timeout: ${(timeout / 60000).toFixed(0)} min):`);

      const query = buildCycleQuery(hops, args.yearWindow);
      const t0 = Date.now();

      try {
        await client.query(`SET statement_timeout = ${timeout}`);
        const res = await client.query(query);
        await client.query('SET statement_timeout = 0');
        const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
        log.info(`    ${(res.rowCount || 0).toLocaleString()} cycles (${elapsed}s)`);
      } catch (err) {
        await client.query('SET statement_timeout = 0').catch(() => {});
        const cont = handleQueryError(err, hops, Date.now() - t0);
        if (!cont) break;
      }
    }

    // Summary
    const loopCounts = await client.query(
      'SELECT hops, COUNT(*) AS cnt FROM cra.loops GROUP BY hops ORDER BY hops'
    );
    log.info('\n  ── Summary ──');
    let totalLoops = 0;
    for (const r of loopCounts.rows) {
      log.info(`    ${r.hops}-hop: ${parseInt(r.cnt).toLocaleString()}`);
      totalLoops += parseInt(r.cnt);
    }
    log.info(`    Total: ${totalLoops.toLocaleString()} unique cycles`);

    if (totalLoops > 0) {
      await buildParticipants(client);
      await buildUniverse(client);
    }

    log.section('Step 1 Complete');

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
