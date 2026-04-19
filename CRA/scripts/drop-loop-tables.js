/**
 * drop-loop-tables.js
 *
 * Drops every table produced by the scripts/advanced/0[1-7] loop-detection
 * pipeline so the next `analyze:full` run repopulates from scratch.
 *
 * Intended use: when upstream CRA data has changed, when a pipeline run
 * was interrupted leaving orphan rollup rows (see KNOWN-DATA-ISSUES.md
 * C-9), or when you simply want a clean-slate re-run.
 *
 * Safe to run against a partially-populated DB: every DROP uses
 * IF EXISTS. The advanced scripts recreate what they need via
 * CREATE TABLE IF NOT EXISTS on their next invocation, so this is a
 * strictly additive undo.
 *
 * Usage:
 *   node scripts/drop-loop-tables.js             # with confirmation prompt
 *   node scripts/drop-loop-tables.js --yes       # skip the prompt
 */

const db = require('../lib/db');
const log = require('../lib/logger');

// Ordered so child/dependent tables drop before parents even though CASCADE
// would handle it — easier for future readers to see the dependency graph.
const TABLES = [
  'cra.loop_charity_financials',
  'cra.loop_financials',
  'cra.loop_edge_year_flows',
  'cra.partitioned_cycles',
  'cra.identified_hubs',
  'cra.johnson_cycles',
  'cra.matrix_census',
  'cra.loop_participants',
  'cra.loop_universe',
  'cra.loops',
  'cra.loop_edges',
  'cra.scc_components',
  'cra.scc_summary',
];

async function confirm() {
  if (process.argv.includes('--yes') || process.argv.includes('-y')) return true;
  const readline = require('readline');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise(resolve => {
    rl.question(`About to DROP ${TABLES.length} loop-related tables in cra schema. Type "yes" to proceed: `, resolve);
  });
  rl.close();
  return answer.trim().toLowerCase() === 'yes';
}

async function main() {
  log.section('Dropping CRA loop-detection tables');
  log.info(`Target DB: ${(process.env.DB_CONNECTION_STRING || '').replace(/:[^:@]+@/, ':[redacted]@')}`);

  if (!(await confirm())) {
    log.warn('Cancelled.');
    process.exit(1);
  }

  const client = await db.getClient();
  try {
    for (const t of TABLES) {
      await client.query(`DROP TABLE IF EXISTS ${t} CASCADE`);
      log.info(`  dropped ${t}`);
    }
    log.info('\nAll loop tables dropped. Run `npm run analyze:full` to repopulate.');
  } finally {
    client.release();
    await db.end();
  }
}

main().catch(err => {
  log.error(`Drop failed: ${err.message}`);
  process.exit(1);
});
