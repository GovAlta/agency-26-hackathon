#!/usr/bin/env node
/**
 * dashboard.js — End-to-end entity resolution pipeline control + observability.
 *
 * Single-page Express app (http://localhost:3800) that gives you:
 *   1. Control buttons for every pipeline phase — click to spawn the matching
 *      npm/node script server-side; no need to open a separate terminal.
 *   2. Real-time observability: row counts, LLM progress + ETA, test-entity
 *      sanity cards, recent merges, splink build status. Polls DB every 2 s.
 *   3. Streaming log tail per phase — each spawned script's stdout is captured
 *      into a ring buffer and shown inline.
 *
 * The dashboard is the single operator interface: drop/migrate/run-pipeline,
 * watch progress, and pause before the final golden-record compile.
 *
 * Usage:
 *   npm run entities:dashboard
 *   PORT=9000 npm run entities:dashboard
 */
const express = require('express');
const path = require('path');
const fs = require('fs');
const { spawn, execSync } = require('child_process');
const { pool } = require('../../lib/db');

const PORT = parseInt(process.env.PORT || '3800', 10);
const POLL_MS = parseInt(process.env.DASHBOARD_POLL_MS || '2000', 10);
const REPO = path.join(__dirname, '..', '..');    // general/
const PID_DIR = path.join(__dirname, '.phase-pids');
if (!fs.existsSync(PID_DIR)) fs.mkdirSync(PID_DIR, { recursive: true });

const app = express();
app.use(express.json());

// ────────────────────────────────────────────────────────────────────────────
// PHASE REGISTRY — what buttons appear and what each spawns
// ────────────────────────────────────────────────────────────────────────────

const PHASES = {
  reset:      { label: '[DANGER] Reset entity + splink tables', cmd: 'node', args: ['scripts/tools/reset-entities.js', '--yes'], danger: true },
  migrate:    { label: '03 · Migrate schema',                    cmd: 'node', args: ['scripts/03-migrate-entities.js'] },
  resolve:    { label: '04 · Deterministic resolve (CRA+FED+AB)', cmd: 'node', args: ['scripts/04-resolve-entities.js'] },
  splink:     { label: '05 · Splink probabilistic matching',      cmd: 'node', args: ['scripts/05-run-splink.js'] },
  detect:     { label: '06 · Detect candidates (Tiers 1-5)',       cmd: 'node', args: ['scripts/06-detect-candidates.js'] },
  smartmatch: { label: '07 · Smart-match (IDF keyword overlap)',   cmd: 'node', args: ['--max-old-space-size=6144', 'scripts/07-smart-match.js', '--skip-llm'] },
  llm_ant:    { label: '08a · LLM review (Anthropic, 100 conc)',   cmd: 'node', args: ['scripts/08-llm-golden-records.js', '--concurrency', '100', '--provider', 'anthropic'] },
  llm_vtx:    { label: '08b · LLM review (Vertex, 100 conc)',      cmd: 'node', args: ['scripts/08-llm-golden-records.js', '--concurrency', '100', '--provider', 'vertex'] },
  build:      { label: '09 · Build golden records (final compile)', cmd: 'node', args: ['scripts/09-build-golden-records.js'] },
  donee_fb:   { label: '10 · Donee-name trigram fallback (NEW)',    cmd: 'node', args: ['scripts/10-donee-trigram-fallback.js'] },
};

// Per-phase in-memory state: { child, startedAt, exitCode, lastLine, logRing }
const phaseState = Object.fromEntries(Object.keys(PHASES).map(k => [k, {
  running: false, startedAt: null, exitCode: null, logRing: [], lastLine: '',
}]));

function appendLog(key, line) {
  const st = phaseState[key];
  st.lastLine = line;
  st.logRing.push(line);
  if (st.logRing.length > 500) st.logRing.shift();
}

// Persist PID to disk on spawn so orphaned phases (dashboard restart while a
// phase is mid-run) can still be identified and killed by the next dashboard.
function writePid(key, pid) {
  fs.writeFileSync(path.join(PID_DIR, `${key}.pid`), String(pid));
}
function clearPid(key) {
  const f = path.join(PID_DIR, `${key}.pid`);
  if (fs.existsSync(f)) fs.unlinkSync(f);
}
function isAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}
function killByPid(pid) {
  if (!pid) return false;
  try {
    if (process.platform === 'win32') {
      // taskkill /T kills the whole process tree (child + descendants).
      execSync(`taskkill /PID ${pid} /T /F`, { stdio: 'ignore' });
    } else {
      process.kill(pid, 'SIGTERM');
    }
    return true;
  } catch { return false; }
}

// On startup, reattach to any orphans from a prior dashboard run.
function recoverOrphans() {
  for (const key of Object.keys(PHASES)) {
    const f = path.join(PID_DIR, `${key}.pid`);
    if (!fs.existsSync(f)) continue;
    const pid = parseInt(fs.readFileSync(f, 'utf8').trim(), 10);
    if (isAlive(pid)) {
      phaseState[key].running = true;
      phaseState[key].pid = pid;
      phaseState[key].orphan = true;          // we can kill but not read stdout
      phaseState[key].startedAt = (fs.statSync(f).mtime).toISOString();
      phaseState[key].lastLine = '[orphan recovered from prior dashboard — logs not captured]';
      phaseState[key].logRing = [phaseState[key].lastLine];
      console.log(`[dashboard] recovered orphan phase=${key} pid=${pid}`);
    } else {
      clearPid(key);
    }
  }
}

function startPhase(key) {
  const def = PHASES[key];
  if (!def) throw new Error(`unknown phase: ${key}`);
  const st = phaseState[key];
  if (st.running) throw new Error(`phase already running: ${key}`);

  st.running = true;
  st.orphan = false;
  st.startedAt = new Date().toISOString();
  st.exitCode = null;
  st.logRing = [];
  st.lastLine = 'started';

  const child = spawn(def.cmd, def.args, { cwd: REPO, shell: false });
  st.child = child;
  st.pid = child.pid;
  writePid(key, child.pid);

  const onData = (chunk) => {
    chunk.toString('utf8').split('\n').forEach(line => {
      const clean = line.trimEnd();
      if (clean) appendLog(key, clean);
    });
  };
  child.stdout.on('data', onData);
  child.stderr.on('data', onData);
  child.on('exit', (code) => {
    st.running = false;
    st.exitCode = code;
    st.child = null;
    clearPid(key);
    appendLog(key, `[exit code ${code}]`);
  });
  child.on('error', (err) => {
    st.running = false;
    st.exitCode = -1;
    clearPid(key);
    appendLog(key, `[error] ${err.message}`);
  });
  return { pid: child.pid };
}

function stopPhase(key) {
  const st = phaseState[key];
  if (!st || !st.running) return { stopped: false, reason: 'not running' };

  // Orphaned from a prior dashboard — no child handle, kill by PID.
  if (st.orphan && st.pid) {
    const ok = killByPid(st.pid);
    if (ok) {
      st.running = false;
      st.orphan = false;
      appendLog(key, `[killed orphan pid ${st.pid}]`);
      clearPid(key);
    }
    return { stopped: ok, pid: st.pid, orphan: true };
  }

  // Normal case: we own the child handle.
  if (st.child) {
    const pid = st.pid;
    // On Windows, child.kill('SIGTERM') calls TerminateProcess on the root
    // Node process only — not its grandchildren (e.g. Splink's Python). Use
    // taskkill /T to kill the whole tree.
    if (process.platform === 'win32' && pid) {
      try { execSync(`taskkill /PID ${pid} /T /F`, { stdio: 'ignore' }); } catch {}
    } else {
      try { st.child.kill('SIGTERM'); } catch {}
    }
    appendLog(key, `[kill signalled pid ${pid}]`);
    return { stopped: true, pid };
  }

  return { stopped: false, reason: 'no handle' };
}

// Global kill — taskkill any node/python process whose command line includes
// one of our pipeline scripts. Safety net if PID files got out of sync.
function killAllPipelineProcesses() {
  const killed = [];
  if (process.platform === 'win32') {
    // Enumerate node processes, match command line against our script names.
    const out = execSync(
      `wmic process where "name='node.exe' or name='python.exe'" get processid,commandline /format:list`,
      { encoding: 'utf8' }
    );
    const blocks = out.split(/\r?\n\r?\n/).filter(Boolean);
    const patterns = [
      'scripts/03-migrate-entities', 'scripts/04-resolve-entities',
      'scripts/05-run-splink', 'scripts/06-detect-candidates',
      'scripts/07-smart-match', 'scripts/08-llm-golden-records',
      'scripts/09-build-golden-records', 'scripts/tools/reset-entities',
      'splink/run_splink', 'splink/export_source_data', 'splink/backfill_aliases',
    ].map(p => p.replace(/\//g, '\\\\'));
    for (const b of blocks) {
      const cmd = (b.match(/CommandLine=(.*)/) || [])[1] || '';
      const pidS = (b.match(/ProcessId=(\d+)/) || [])[1];
      if (!pidS) continue;
      const pid = parseInt(pidS, 10);
      if (pid === process.pid) continue;
      if (patterns.some(p => cmd.includes(p))) {
        if (killByPid(pid)) killed.push({ pid, cmd: cmd.slice(0, 120) });
      }
    }
  } else {
    const out = execSync(
      `pgrep -af 'scripts/0[3-9]-|splink/run_splink|splink/export_source|splink/backfill_aliases'`,
      { encoding: 'utf8' }
    );
    for (const line of out.split('\n').filter(Boolean)) {
      const [pidS, ...rest] = line.split(' ');
      const pid = parseInt(pidS, 10);
      if (pid === process.pid) continue;
      if (killByPid(pid)) killed.push({ pid, cmd: rest.join(' ').slice(0, 120) });
    }
  }
  // Clear any PID files too.
  for (const key of Object.keys(PHASES)) clearPid(key);
  for (const key of Object.keys(phaseState)) {
    if (phaseState[key].running) {
      phaseState[key].running = false;
      phaseState[key].orphan = false;
      appendLog(key, '[killed via Kill All Pipeline Processes]');
    }
  }
  return { killed };
}

// ────────────────────────────────────────────────────────────────────────────
// STATE GATHERING FROM POSTGRES
// ────────────────────────────────────────────────────────────────────────────

// Per-query timeout guard. Race each query against a setTimeout so one slow
// table can't hang /api/state. Render free-tier DB has occasional multi-second
// stalls; we bound individual queries to 5 s and fall back to null.
const QUERY_TIMEOUT_MS = 5000;

function timed(p, ms, label) {
  return Promise.race([
    p,
    new Promise((_, rej) => setTimeout(() => rej(new Error(`timeout:${label}`)), ms)),
  ]);
}

async function safeQ(sql, params = [], label = 'q') {
  try { return await timed(pool.query(sql, params), QUERY_TIMEOUT_MS, label); }
  catch (e) {
    if (process.env.DASHBOARD_DEBUG) console.warn(`[safeQ ${label}]`, e.message);
    return null;
  }
}

// Cache table-existence for 10 s so we don't re-check schema every poll.
let _tableCache = { at: 0, tables: {} };
async function getTableMap() {
  if (Date.now() - _tableCache.at < 10_000) return _tableCache.tables;
  const r = await safeQ(
    `SELECT table_name FROM information_schema.tables WHERE table_schema = 'general'`
  );
  const t = {};
  (r?.rows || []).forEach(x => { t[x.table_name] = true; });
  _tableCache = { at: Date.now(), tables: t };
  return t;
}

async function getStage(has) {
  if (!has.entities) return { id: 0, label: 'RESET — no entity tables' };
  const r = await safeQ('SELECT COUNT(*)::int AS c FROM general.entities LIMIT 1');
  const entCount = r?.rows?.[0]?.c || 0;
  if (entCount === 0) return { id: 1, label: 'MIGRATE — schema ready, no data' };

  if (has.splink_build_metadata) {
    const s = await safeQ(`SELECT COUNT(*)::int AS c FROM general.splink_build_metadata WHERE status='completed'`);
    if (!(s?.rows?.[0]?.c > 0)) return { id: 2, label: '04 RESOLVE — deterministic done, Splink pending' };
  } else {
    return { id: 2, label: '04 RESOLVE — deterministic done, Splink pending' };
  }

  if (!has.entity_merge_candidates) return { id: 3, label: '05 SPLINK — done, detection pending' };
  const cand = await safeQ(`SELECT COUNT(*) FILTER (WHERE status='pending')::int AS pending,
                                   COUNT(*)::int AS total FROM general.entity_merge_candidates`);
  const { pending = 0, total = 0 } = cand?.rows?.[0] || {};
  if (total === 0) return { id: 3, label: '05 SPLINK — done, detection pending' };
  if (pending > 0) return { id: 6, label: `08 LLM — ${pending.toLocaleString()} pending` };

  if (has.entity_golden_records) {
    const g = await safeQ(`SELECT COUNT(*) FILTER (WHERE status='active')::int AS c FROM general.entity_golden_records`);
    if (g?.rows?.[0]?.c > 0) return { id: 8, label: `09 GOLDEN — ${g.rows[0].c.toLocaleString()} records live` };
  }
  return { id: 7, label: '08 LLM DONE — ready to compile golden' };
}

async function gatherState() {
  const t0 = Date.now();
  const tables = await getTableMap();
  const has = {
    entities: !!tables.entities,
    splink_predictions: !!tables.splink_predictions,
    splink_aliases: !!tables.splink_aliases,
    splink_build_metadata: !!tables.splink_build_metadata,
    entity_merge_candidates: !!tables.entity_merge_candidates,
    entity_merges: !!tables.entity_merges,
    entity_golden_records: !!tables.entity_golden_records,
    entity_source_links: !!tables.entity_source_links,
  };

  // Fire every query in parallel so one slow query doesn't block the dashboard.
  // Each uses safeQ which returns null on timeout/error — the UI shows a dash.
  const TEST_CASES = [
    // Configurable sanity-card test entities. Each is a real Business Number
    // exercising a different matching pattern; the card displays the entity's
    // canonical name live from the database and flags regressions when a
    // lookup returns NOT FOUND or dataset coverage drops. Replace with
    // whatever BNs make sense for the deployment.
    { label: 'Multi-dataset mid-size charity',  bn: '118814391' },  // CRA+FED+AB, many name variants
    { label: 'Corporate family: operating org', bn: '834173627' },  // part of a multi-entity family
    { label: 'Same-name distinct charity (A)',  bn: '108004664' },  // identical canonical name, different BN
    { label: 'Same-name distinct charity (B)',  bn: '108004474' },  // paired with (A) to test BN-conflict guard
    { label: 'Cross-dataset contracts/SS',      bn: '118810829' },  // exercises AB contracts + sole-source
    { label: 'Large multi-dataset institution', bn: '108102831' },  // University of Alberta
  ];

  const [
    stage, entitiesQ, linksQ, splinkPredsQ, splinkAliasesQ, splinkBuildQ,
    candMethodQ, candProvQ, candRateQ, candProgQ, mergesQ, goldenQ,
    ...testQ
  ] = await Promise.all([
    getStage(has),
    has.entities ? safeQ(`
      SELECT COUNT(*)::int AS total,
             COUNT(*) FILTER (WHERE merged_into IS NULL)::int AS active,
             COUNT(*) FILTER (WHERE merged_into IS NOT NULL)::int AS merged,
             COUNT(*) FILTER (WHERE bn_root IS NOT NULL AND merged_into IS NULL)::int AS with_bn,
             COUNT(*) FILTER (WHERE array_length(dataset_sources, 1) > 1 AND merged_into IS NULL)::int AS cross_dataset
      FROM general.entities`) : null,
    has.entity_source_links ? safeQ(`
      SELECT source_schema, source_table, COUNT(*)::int AS c
      FROM general.entity_source_links
      GROUP BY source_schema, source_table ORDER BY source_schema, source_table`) : null,
    has.splink_predictions ? safeQ(`
      SELECT COUNT(*)::int AS total,
             COUNT(*) FILTER (WHERE match_probability >= 0.95)::int AS high_conf,
             COUNT(*) FILTER (WHERE match_probability BETWEEN 0.70 AND 0.95)::int AS high_mid,
             COUNT(*) FILTER (WHERE match_probability BETWEEN 0.40 AND 0.70)::int AS review_band,
             COUNT(DISTINCT cluster_id)::int AS clusters
      FROM general.splink_predictions`) : null,
    has.splink_aliases ? safeQ(`SELECT COUNT(*)::int AS c FROM general.splink_aliases`) : null,
    has.splink_build_metadata ? safeQ(`
      SELECT id, status, started_at, completed_at, total_records, total_predictions,
             total_clusters, threshold, splink_version
      FROM general.splink_build_metadata ORDER BY id DESC LIMIT 1`) : null,
    has.entity_merge_candidates ? safeQ(`
      SELECT candidate_method, status, COUNT(*)::int AS c
      FROM general.entity_merge_candidates
      GROUP BY candidate_method, status ORDER BY candidate_method, status`) : null,
    has.entity_merge_candidates ? safeQ(`
      SELECT llm_provider, COUNT(*)::int AS c FROM general.entity_merge_candidates
      WHERE llm_provider IS NOT NULL GROUP BY llm_provider`) : null,
    has.entity_merge_candidates ? safeQ(`
      SELECT COUNT(*)::int AS reviewed_60s FROM general.entity_merge_candidates
      WHERE reviewed_at > NOW() - INTERVAL '60 seconds'`) : null,
    has.entity_merge_candidates ? safeQ(`
      SELECT COUNT(*) FILTER (WHERE status = 'pending')::int AS pending,
             COUNT(*) FILTER (WHERE status = 'llm_reviewing')::int AS reviewing,
             COUNT(*) FILTER (WHERE status = 'same')::int AS same,
             COUNT(*) FILTER (WHERE status = 'related')::int AS related,
             COUNT(*) FILTER (WHERE status = 'different')::int AS different,
             COUNT(*) FILTER (WHERE status = 'uncertain')::int AS uncertain,
             COUNT(*) FILTER (WHERE status = 'error')::int AS error,
             COUNT(*)::int AS total
      FROM general.entity_merge_candidates`) : null,
    has.entity_merges ? safeQ(`
      SELECT m.merged_at, m.survivor_id, m.absorbed_id, m.merge_method,
             s.canonical_name AS survivor_name, a.canonical_name AS absorbed_name
      FROM general.entity_merges m
      JOIN general.entities s ON s.id = m.survivor_id
      JOIN general.entities a ON a.id = m.absorbed_id
      ORDER BY m.merged_at DESC LIMIT 10`) : null,
    has.entity_golden_records ? safeQ(`
      SELECT status, COUNT(*)::int AS c FROM general.entity_golden_records
      GROUP BY status ORDER BY status`) : null,
    ...TEST_CASES.map(tc => has.entities ? safeQ(`
      SELECT e.id, e.canonical_name, e.dataset_sources,
             (SELECT COUNT(*)::int FROM general.entity_source_links WHERE entity_id = e.id) AS link_count,
             array_length(e.alternate_names, 1) AS alias_count
      FROM general.entities e
      WHERE e.bn_root = $1 AND e.merged_into IS NULL LIMIT 1`, [tc.bn]) : null),
  ]);

  const counts = {};
  counts.entities = entitiesQ?.rows?.[0] || null;
  counts.source_links = linksQ?.rows || [];
  counts.source_links_total = counts.source_links.reduce((a, b) => a + b.c, 0);
  counts.splink_predictions = splinkPredsQ?.rows?.[0] || null;
  counts.splink_aliases = splinkAliasesQ?.rows?.[0]?.c ?? null;
  counts.splink_build = splinkBuildQ?.rows?.[0] || null;
  counts.candidates = candMethodQ?.rows || [];
  counts.llm_by_provider = candProvQ?.rows || [];
  counts.llm_rate_per_sec = candRateQ?.rows?.[0]
    ? Math.round(candRateQ.rows[0].reviewed_60s / 60 * 10) / 10 : 0;
  counts.llm_progress = candProgQ?.rows?.[0] || null;
  if (counts.llm_rate_per_sec > 0 && counts.llm_progress?.pending > 0) {
    counts.llm_eta_min = Math.round(counts.llm_progress.pending / counts.llm_rate_per_sec / 60);
  }
  counts.recent_merges = mergesQ?.rows || [];
  counts.golden_records = goldenQ?.rows || [];
  counts.test_entities = TEST_CASES.map((tc, i) => ({
    ...tc,
    found: !!testQ[i]?.rows?.[0],
    entity: testQ[i]?.rows?.[0] || null,
  }));

  // Phase control state. Send the full log ring (capped at 500 lines at
  // append time) so the dashboard shows complete output and can auto-scroll
  // to the bottom as new lines arrive. `orphan` means the process was
  // recovered from a prior dashboard run — we can kill it but can't tail
  // its stdout.
  const phases = Object.fromEntries(Object.entries(phaseState).map(([k, v]) => [k, {
    running: v.running, startedAt: v.startedAt, exitCode: v.exitCode,
    lastLine: v.lastLine, logTail: v.logRing.slice(),
    label: PHASES[k].label, danger: !!PHASES[k].danger, pid: v.pid || null,
    orphan: !!v.orphan,
  }]));

  return { stage, has, counts, phases, pollMs: POLL_MS, elapsedMs: Date.now() - t0, timestamp: new Date().toISOString() };
}

// ────────────────────────────────────────────────────────────────────────────
// ROUTES
// ────────────────────────────────────────────────────────────────────────────

app.get('/api/state', async (req, res) => {
  try { res.json(await gatherState()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/run/:phase', (req, res) => {
  try { res.json(startPhase(req.params.phase)); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

app.post('/api/stop/:phase', (req, res) => {
  try { res.json(stopPhase(req.params.phase)); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

app.get('/api/log/:phase', (req, res) => {
  const st = phaseState[req.params.phase];
  if (!st) return res.status(404).json({ error: 'unknown phase' });
  res.json({ log: st.logRing, running: st.running, exitCode: st.exitCode });
});

app.post('/api/kill-all', (req, res) => {
  try { res.json(killAllPipelineProcesses()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/', (req, res) => res.type('html').send(HTML));

// Reattach to any pipeline processes that are still running from a prior
// dashboard instance. Their PID files persist across dashboard restarts.
recoverOrphans();

app.listen(PORT, () => {
  console.log(`[dashboard] http://localhost:${PORT}`);
  console.log(`[dashboard] polling DB every ${POLL_MS}ms`);
  const orphans = Object.entries(phaseState).filter(([, v]) => v.orphan);
  if (orphans.length) {
    console.log(`[dashboard] RECOVERED ${orphans.length} orphan(s): ` +
      orphans.map(([k, v]) => `${k}(pid=${v.pid})`).join(', '));
  }
});

// On SIGINT, try to kill spawned children so they don't outlive the dashboard.
process.on('SIGINT', () => {
  for (const key of Object.keys(phaseState)) {
    try { stopPhase(key); } catch {}
  }
  process.exit(0);
});

// ────────────────────────────────────────────────────────────────────────────
// HTML
// ────────────────────────────────────────────────────────────────────────────

const HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Entity Resolution Pipeline</title>
<style>
  * { box-sizing: border-box; }
  body { font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
         background: #f6f8fa; color: #1f2328; margin: 0; padding: 20px; }
  h1 { font-size: 22px; margin: 0 0 4px 0; color: #1f2328; }
  .sub { color: #57606a; font-size: 13px; margin-bottom: 20px; }
  .section-h { font-size: 12px; color: #57606a; text-transform: uppercase; letter-spacing: 0.05em; margin: 24px 0 10px; font-weight: 600; }
  .row { display: flex; gap: 14px; margin-bottom: 16px; flex-wrap: wrap; }
  .card { background: white; border: 1px solid #d0d7de; border-radius: 10px;
          padding: 16px 18px; min-width: 260px; flex: 1; box-shadow: 0 1px 2px rgba(0,0,0,0.04); }
  .card h2 { margin: 0 0 10px 0; font-size: 12px; font-weight: 600;
             text-transform: uppercase; letter-spacing: 0.05em; color: #57606a; }
  .big { font-size: 32px; font-weight: 700; color: #1f2328; line-height: 1.1; }
  .label { color: #57606a; font-size: 12px; }
  .kv { display: grid; grid-template-columns: auto 1fr; gap: 5px 14px; font-size: 13px; }
  .kv .k { color: #57606a; }
  .kv .v { color: #1f2328; text-align: right; font-variant-numeric: tabular-nums; font-weight: 500; }

  .stage { display: flex; gap: 6px; overflow-x: auto; padding-bottom: 6px; }
  .step { background: white; border: 1px solid #d0d7de; padding: 10px 14px; border-radius: 8px;
          white-space: nowrap; font-size: 12px; color: #57606a; flex-shrink: 0; font-weight: 500; }
  .step.active { background: #0969da; color: white; border-color: #0969da; font-weight: 700; }
  .step.done { background: #1a7f37; color: white; border-color: #1a7f37; }

  .phase { background: white; border: 1px solid #d0d7de; border-radius: 10px;
           padding: 14px 16px; display: flex; flex-direction: column; gap: 8px;
           min-width: 260px; flex: 1 1 280px; box-shadow: 0 1px 2px rgba(0,0,0,0.04); }
  .phase .lbl { font-size: 13px; font-weight: 600; color: #1f2328; }
  .phase .last { font-size: 11px; color: #57606a; font-family: ui-monospace, Menlo, monospace;
                 height: 16px; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
  .phase button { padding: 8px 14px; border: 1px solid #d0d7de; background: #f6f8fa;
                  color: #1f2328; border-radius: 6px; cursor: pointer; font-size: 13px;
                  font-weight: 600; }
  .phase button:hover { background: #eff2f5; }
  .phase button.run { border-color: #0969da; background: #0969da; color: white; }
  .phase button.run:hover { background: #0860ca; }
  .phase button.running { background: #bf8700; color: white; border-color: #bf8700; }
  .phase button.done { background: #1a7f37; color: white; border-color: #1a7f37; }
  .phase button.danger { background: #cf222e; border-color: #cf222e; color: white; }
  .phase button.danger:hover { background: #b1232c; }
  .phase.log-open { flex: 1 1 100%; }
  .phase .controls { display: flex; gap: 6px; }
  .phase .logview { background: #1f2328; border: 1px solid #21262d; border-radius: 6px;
                    padding: 10px; font-family: ui-monospace, Menlo, monospace; font-size: 11px;
                    color: #d0d7de; max-height: 520px; min-height: 220px; overflow-y: auto; line-height: 1.5;
                    white-space: pre-wrap; margin-top: 6px; }
  .phase .logview .lastline { color: #7ee787; font-weight: 600; }

  .test { background: white; border: 1px solid #d0d7de; padding: 12px 14px;
          border-radius: 8px; flex: 1 1 280px; min-width: 280px;
          box-shadow: 0 1px 2px rgba(0,0,0,0.04); }
  .test .name { font-weight: 600; color: #1f2328; font-size: 13px; margin-bottom: 4px; }
  .test .bn { color: #57606a; font-size: 11px; font-family: monospace; }
  .test .stats { display: flex; gap: 12px; margin-top: 10px; font-size: 12px; color: #57606a; }
  .test .stats b { color: #1f2328; font-weight: 600; }
  .test.missing { border-color: #cf222e; background: #ffebe9; }
  .test.missing::after { content: "NOT FOUND"; color: #cf222e; font-size: 11px; font-weight: 700; }

  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th, td { text-align: left; padding: 6px 10px; border-bottom: 1px solid #eaeef2; }
  th { color: #57606a; font-weight: 600; text-transform: uppercase; font-size: 11px; letter-spacing: 0.05em; }
  td.num { text-align: right; font-variant-numeric: tabular-nums; }

  .progress { width: 100%; height: 10px; background: #eaeef2; border-radius: 5px; margin: 10px 0; overflow: hidden; }
  .progress .bar { height: 100%; background: linear-gradient(90deg, #0969da, #8250df); border-radius: 5px; transition: width 0.5s; }
  .mini { font-size: 11px; color: #57606a; font-variant-numeric: tabular-nums; }
  .eta { color: #1a7f37; font-weight: 700; }
  .warn { color: #bf8700; }
  .err { color: #cf222e; }
  .ok { color: #1a7f37; }
  .badge { display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 11px;
           background: #eaeef2; color: #1f2328; margin-right: 4px; font-weight: 500; }
  .badge.cra { background: #0969da; color: white; }
  .badge.fed { background: #8250df; color: white; }
  .badge.ab { background: #1a7f37; color: white; }
  #status { position: fixed; top: 12px; right: 18px; font-size: 11px; color: #57606a;
            background: white; padding: 4px 10px; border-radius: 4px; border: 1px solid #d0d7de; }
  #status.fresh { border-color: #1a7f37; color: #1a7f37; }
  #status.fresh::before { content: "● "; }
  #status.err { border-color: #cf222e; color: #cf222e; background: #ffebe9; }
  .merge-row { font-family: monospace; font-size: 11px; color: #57606a; padding: 3px 0; }
  .merge-row .survivor { color: #1a7f37; font-weight: 600; }
  .merge-row .absorbed { color: #cf222e; text-decoration: line-through; }
</style>
</head>
<body>
<div id="status">loading...</div>
<h1>Entity Resolution Pipeline — Dashboard</h1>
<div class="sub">CRA + FED + AB cross-dataset resolution · <span id="stage-label">-</span></div>

<div class="section-h">Pipeline stage</div>
<div class="stage" id="stages"></div>

<div class="section-h" style="display:flex; justify-content:space-between; align-items:baseline">
  <span>Control panel — click to run a phase (output streams inline)</span>
  <button id="kill-all-btn" onclick="killAll()"
    style="padding:6px 12px; border:1px solid #cf222e; background:#ffebe9; color:#cf222e; border-radius:6px; cursor:pointer; font-size:12px; font-weight:600">
    Kill all pipeline processes
  </button>
</div>
<div class="row" id="phases"></div>

<div class="row">
  <div class="card">
    <h2>Entities</h2>
    <div class="big" id="ent-active">-</div>
    <div class="label">active (merged: <span id="ent-merged">-</span>)</div>
    <div class="kv" style="margin-top:8px">
      <div class="k">with BN</div><div class="v" id="ent-with-bn">-</div>
      <div class="k">cross-dataset</div><div class="v" id="ent-cross">-</div>
      <div class="k">total</div><div class="v" id="ent-total">-</div>
    </div>
  </div>
  <div class="card">
    <h2>Source links</h2>
    <div class="big" id="links-total">-</div>
    <div class="label">across datasets</div>
    <div id="links-breakdown" class="kv" style="margin-top:8px"></div>
  </div>
  <div class="card">
    <h2>Splink</h2>
    <div class="big" id="splink-preds">-</div>
    <div class="label"><span id="splink-status">-</span> · <span id="splink-total-clusters">-</span> total canonical entities</div>
    <div class="kv" style="margin-top:8px">
      <div class="k">multi-member clusters</div><div class="v" id="splink-clusters">-</div>
      <div class="k">singletons (implied)</div><div class="v" id="splink-singletons">-</div>
      <div class="k">high conf (≥.95)</div><div class="v" id="splink-high">-</div>
      <div class="k">mid (.70-.95)</div><div class="v" id="splink-mid">-</div>
      <div class="k">review (.40-.70)</div><div class="v" id="splink-rev">-</div>
      <div class="k">aliases</div><div class="v" id="splink-aliases">-</div>
    </div>
  </div>
  <div class="card">
    <h2>Golden records</h2>
    <div class="big" id="gr-active">-</div>
    <div class="label">active records</div>
    <div class="kv" style="margin-top:8px" id="gr-status"></div>
  </div>
</div>

<div class="row">
  <div class="card" style="flex:2">
    <h2>LLM progress</h2>
    <div class="big" id="llm-reviewed">-</div>
    <div class="label">reviewed of <span id="llm-total">-</span> · <span id="llm-rate" class="eta">- /s</span> · ETA <span id="llm-eta" class="eta">-</span></div>
    <div class="progress"><div class="bar" id="llm-bar" style="width: 0%"></div></div>
    <div class="kv">
      <div class="k">pending</div><div class="v" id="llm-pending">-</div>
      <div class="k">reviewing</div><div class="v" id="llm-reviewing">-</div>
      <div class="k"><span class="ok">SAME</span></div><div class="v" id="llm-same">-</div>
      <div class="k"><span class="warn">RELATED</span></div><div class="v" id="llm-related">-</div>
      <div class="k">DIFFERENT</div><div class="v" id="llm-different">-</div>
      <div class="k"><span class="err">errors</span></div><div class="v" id="llm-error">-</div>
    </div>
    <div style="margin-top:10px" class="mini">By provider: <span id="llm-providers">-</span></div>
  </div>
  <div class="card" style="flex:2">
    <h2>Candidates by method</h2>
    <table id="candidate-table">
      <thead><tr><th>method</th><th class="num">pending</th><th class="num">same</th><th class="num">related</th><th class="num">different</th></tr></thead>
      <tbody></tbody>
    </table>
  </div>
</div>

<div class="section-h">Test entities (sanity cards)</div>
<div class="row" id="tests"></div>

<div class="section-h">Recent merges</div>
<div class="card" style="padding: 10px 16px"><div id="merge-feed"></div></div>

<script>
const $ = (id) => document.getElementById(id);
const fmt = (n) => n === null || n === undefined ? '-' : Number(n).toLocaleString();
const openLogs = new Set();

async function tick() {
  try {
    const r = await fetch('/api/state');
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const s = await r.json();
    render(s);
    $('status').className = 'fresh';
    $('status').textContent = 'updated ' + new Date().toLocaleTimeString();
  } catch (e) {
    $('status').className = 'err';
    $('status').textContent = 'error: ' + e.message;
  }
}

async function runPhase(key) {
  const r = await fetch('/api/run/' + key, { method: 'POST' });
  const j = await r.json();
  if (j.error) alert(j.error);
  openLogs.add(key);
  tick();
}
async function stopPhase(key) {
  await fetch('/api/stop/' + key, { method: 'POST' });
  tick();
}
async function killAll() {
  if (!confirm('Kill ALL running pipeline processes (including orphans from prior dashboard runs)? This cannot be undone.')) return;
  const r = await fetch('/api/kill-all', { method: 'POST' });
  const j = await r.json();
  alert('Killed ' + (j.killed || []).length + ' process(es).\\n\\n' +
    (j.killed || []).map(k => 'pid ' + k.pid + ': ' + (k.cmd || '')).join('\\n'));
  tick();
}
function toggleLog(key) {
  if (openLogs.has(key)) openLogs.delete(key); else openLogs.add(key);
  tick();
}

function render(s) {
  $('stage-label').textContent = s.stage.label;

  const STEPS = ['Reset', 'Migrate', 'Resolve', 'Splink', 'Detect', 'Smart', 'LLM', 'LLM done', 'Golden'];
  $('stages').innerHTML = STEPS.map((label, i) => {
    let cls = 'step';
    if (i < s.stage.id) cls += ' done';
    else if (i === s.stage.id) cls += ' active';
    return '<div class="' + cls + '">' + i + '. ' + label + '</div>';
  }).join('');

  // Phase control cards — preserve per-log scroll position so the user can
  // scroll up to read history without the poll snapping them back down.
  // Auto-scroll to bottom ONLY when they were already near the bottom
  // (within 40px). This matches how Slack / terminal log tails feel.
  const prevScroll = {};
  document.querySelectorAll('.phase .logview').forEach(el => {
    const k = el.dataset.phase;
    if (!k) return;
    const nearBottom = (el.scrollHeight - el.scrollTop - el.clientHeight) < 40;
    prevScroll[k] = { top: el.scrollTop, nearBottom };
  });

  const esc = (l) => l.replace(/[<>&]/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;'}[c]));
  $('phases').innerHTML = Object.entries(s.phases).map(([k, p]) => {
    const logOpen = openLogs.has(k);
    let btnCls = p.danger ? 'danger' : 'run';
    let btnLabel = p.danger ? 'Drop tables' : 'Run';
    if (p.running) { btnCls = 'running'; btnLabel = 'Running...'; }
    else if (p.exitCode === 0) { btnCls = 'done'; btnLabel = 'Run again'; }
    else if (p.exitCode !== null) { btnCls = ''; btnLabel = 'Retry (exit ' + p.exitCode + ')'; }
    const pid = p.pid ? ' pid:' + p.pid : '';
    const orphanBadge = p.orphan ? ' <span class="badge" style="background:#bf8700;color:white">ORPHAN</span>' : '';
    const log = p.logTail || [];
    // Render each line on its own — last line highlighted green (latest output).
    const logBody = log.map((l, i) => {
      const cls = i === log.length - 1 ? 'lastline' : '';
      return '<div class="' + cls + '">' + esc(l) + '</div>';
    }).join('');
    return '<div class="phase ' + (logOpen ? 'log-open' : '') + '">' +
      '<div class="lbl">' + p.label + orphanBadge + '</div>' +
      '<div class="last">' + esc(p.lastLine || '') + pid + '</div>' +
      '<div class="controls">' +
        '<button class="' + btnCls + '" onclick="runPhase(\\'' + k + '\\')">' + btnLabel + '</button>' +
        (p.running ? '<button onclick="stopPhase(\\'' + k + '\\')">Stop</button>' : '') +
        '<button onclick="toggleLog(\\'' + k + '\\')">' + (logOpen ? 'Hide log' : 'Show log') + '</button>' +
      '</div>' +
      (logOpen ? '<div class="logview" data-phase="' + k + '">' + logBody + '</div>' : '') +
    '</div>';
  }).join('');

  // Restore scroll position (or snap to bottom if user was at bottom).
  document.querySelectorAll('.phase .logview').forEach(el => {
    const k = el.dataset.phase;
    const prev = prevScroll[k];
    if (!prev || prev.nearBottom) {
      el.scrollTop = el.scrollHeight;   // snap to newest line
    } else {
      el.scrollTop = prev.top;          // preserve user's scroll position
    }
  });

  // Entities panel
  const e = s.counts.entities || {};
  $('ent-active').textContent = fmt(e.active);
  $('ent-merged').textContent = fmt(e.merged);
  $('ent-with-bn').textContent = fmt(e.with_bn);
  $('ent-cross').textContent = fmt(e.cross_dataset);
  $('ent-total').textContent = fmt(e.total);

  $('links-total').textContent = fmt(s.counts.source_links_total);
  $('links-breakdown').innerHTML = (s.counts.source_links || []).map(r =>
    '<div class="k">' + r.source_schema + '.' + r.source_table + '</div><div class="v">' + fmt(r.c) + '</div>'
  ).join('');

  const sp = s.counts.splink_predictions;
  const sb = s.counts.splink_build;
  $('splink-preds').textContent = sp ? fmt(sp.total) : '-';
  $('splink-clusters').textContent = sp ? fmt(sp.clusters) : '-';
  // total_clusters from build_metadata includes singletons (records that matched
  // nothing above threshold — each is its own 1-member canonical entity).
  const totalClusters = sb ? sb.total_clusters : null;
  $('splink-total-clusters').textContent = fmt(totalClusters);
  $('splink-singletons').textContent = (totalClusters && sp)
    ? fmt(totalClusters - sp.clusters) : '-';
  $('splink-status').textContent = sb ? sb.status : 'not run';
  $('splink-high').textContent = sp ? fmt(sp.high_conf) : '-';
  $('splink-mid').textContent = sp ? fmt(sp.high_mid) : '-';
  $('splink-rev').textContent = sp ? fmt(sp.review_band) : '-';
  $('splink-aliases').textContent = fmt(s.counts.splink_aliases);

  $('gr-active').textContent = fmt(
    (s.counts.golden_records || []).find(r => r.status === 'active')?.c || 0
  );
  $('gr-status').innerHTML = (s.counts.golden_records || []).map(r =>
    '<div class="k">' + r.status + '</div><div class="v">' + fmt(r.c) + '</div>'
  ).join('');

  const p = s.counts.llm_progress;
  if (p) {
    const reviewed = p.same + p.related + p.different + p.uncertain + p.error;
    const pct = p.total > 0 ? reviewed / p.total * 100 : 0;
    $('llm-reviewed').textContent = fmt(reviewed);
    $('llm-total').textContent = fmt(p.total);
    $('llm-rate').textContent = (s.counts.llm_rate_per_sec || 0).toFixed(1) + ' /s';
    $('llm-eta').textContent = p.pending === 0 ? 'done' :
      (s.counts.llm_eta_min
        ? (s.counts.llm_eta_min >= 60
            ? Math.floor(s.counts.llm_eta_min / 60) + 'h ' + (s.counts.llm_eta_min % 60) + 'm'
            : s.counts.llm_eta_min + 'm')
        : '-');
    $('llm-bar').style.width = pct + '%';
    $('llm-pending').textContent = fmt(p.pending);
    $('llm-reviewing').textContent = fmt(p.reviewing);
    $('llm-same').textContent = fmt(p.same);
    $('llm-related').textContent = fmt(p.related);
    $('llm-different').textContent = fmt(p.different);
    $('llm-error').textContent = fmt(p.error);
    $('llm-providers').innerHTML = (s.counts.llm_by_provider || []).map(r =>
      '<span class="badge">' + r.llm_provider + ': ' + fmt(r.c) + '</span>'
    ).join('') || '-';
  }

  const tbl = $('candidate-table').querySelector('tbody');
  const byMethod = {};
  (s.counts.candidates || []).forEach(r => {
    if (!byMethod[r.candidate_method]) byMethod[r.candidate_method] = {};
    byMethod[r.candidate_method][r.status] = r.c;
  });
  tbl.innerHTML = Object.entries(byMethod).map(([m, st]) =>
    '<tr><td>' + m + '</td>' +
    '<td class="num">' + fmt(st.pending || 0) + '</td>' +
    '<td class="num ok">' + fmt(st.same || 0) + '</td>' +
    '<td class="num warn">' + fmt(st.related || 0) + '</td>' +
    '<td class="num">' + fmt(st.different || 0) + '</td></tr>'
  ).join('') || '<tr><td colspan="5" class="mini">no candidates yet</td></tr>';

  $('tests').innerHTML = (s.counts.test_entities || []).map(t => {
    const ent = t.entity;
    const datasets = ent && ent.dataset_sources
      ? ent.dataset_sources.map(d => '<span class="badge ' + d.replace('_', '') + '">' + d + '</span>').join('')
      : '';
    return '<div class="test ' + (t.found ? '' : 'missing') + '">' +
      '<div class="name">' + t.label + '</div>' +
      '<div class="bn">BN ' + t.bn + '</div>' +
      (ent ? (
        '<div class="stats">' +
          '<span>links: <b>' + fmt(ent.link_count) + '</b></span>' +
          '<span>aliases: <b>' + fmt(ent.alias_count) + '</b></span>' +
        '</div>' +
        '<div style="margin-top:6px">' + datasets + '</div>'
      ) : '') +
    '</div>';
  }).join('') || '<div class="mini">entity table not created yet</div>';

  const merges = s.counts.recent_merges || [];
  $('merge-feed').innerHTML = merges.length
    ? merges.map(m => {
        const when = new Date(m.merged_at).toLocaleTimeString();
        return '<div class="merge-row">' +
          '<span style="color:#7d8590">' + when + '</span> ' +
          '<span class="absorbed">#' + m.absorbed_id + ' ' + (m.absorbed_name || '').slice(0, 40) + '</span> -> ' +
          '<span class="survivor">#' + m.survivor_id + ' ' + (m.survivor_name || '').slice(0, 40) + '</span> ' +
          '<span class="mini">[' + m.merge_method + ']</span>' +
        '</div>';
      }).join('')
    : '<div class="mini">no merges yet</div>';
}

tick();
setInterval(tick, ${POLL_MS});
</script>
</body>
</html>`;
