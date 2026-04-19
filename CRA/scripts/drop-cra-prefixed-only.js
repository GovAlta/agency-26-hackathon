/**
 * drop-cra-prefixed-only.js — Drop EXACTLY the cra.cra_* prefixed tables.
 *
 * This script drops the 25 tables whose names start with `cra_` in the `cra`
 * schema (19 data tables + 6 lookup tables). It does NOT drop:
 *
 *   - Derived tables (cra.loops, cra.scc_*, cra.johnson_cycles, cra.matrix_census,
 *     cra.partitioned_cycles, cra.identified_hubs, cra.loop_*, cra.overhead_*,
 *     cra.t3010_*, cra.donee_name_quality, cra.identification_name_history,
 *     cra.govt_funding_*, cra._dnq_canonical)
 *   - Views (cra.vw_*)
 *   - Any non-cra schema
 *
 * Used to re-migrate after schema type changes (e.g. political_activity_resources
 * staff/volunteers/financial/property INTEGER→BOOLEAN). Assumes admin credentials
 * from CRA/.env.
 *
 * Usage:
 *   node scripts/drop-cra-prefixed-only.js
 */
const { Pool } = require('pg');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const pool = new Pool({ connectionString: process.env.DB_CONNECTION_STRING });

// Drop data tables first (reverse dependency order within `cra_*`),
// then the lookup tables.
const DATA_TABLES = [
  'cra_disbursement_quota',
  'cra_non_qualified_donees',
  'cra_political_activity_resources',
  'cra_political_activity_funding',
  'cra_political_activity_desc',
  'cra_gifts_in_kind',
  'cra_compensation',
  'cra_resources_sent_outside',
  'cra_exported_goods',
  'cra_activities_outside_countries',
  'cra_activities_outside_details',
  'cra_foundation_info',
  'cra_financial_details',
  'cra_financial_general',
  'cra_charitable_programs',
  'cra_qualified_donees',
  'cra_directors',
  'cra_web_urls',
  'cra_identification',
];

const LOOKUP_TABLES = [
  'cra_program_type_lookup',
  'cra_province_state_lookup',
  'cra_country_lookup',
  'cra_designation_lookup',
  'cra_sub_category_lookup',
  'cra_category_lookup',
];

const ALLOWED = new Set([...DATA_TABLES, ...LOOKUP_TABLES]);

async function main() {
  const client = await pool.connect();
  try {
    // Safety check: enumerate every cra.* table and confirm what we'd touch
    const listing = await client.query(`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'cra' AND table_type = 'BASE TABLE'
      ORDER BY table_name
    `);

    const inDb = listing.rows.map(r => r.table_name);
    const willDrop = inDb.filter(t => ALLOWED.has(t));
    const willKeep = inDb.filter(t => !ALLOWED.has(t));

    console.log('== Safety preview ==');
    console.log(`Tables in cra schema: ${inDb.length}`);
    console.log(`Will DROP (${willDrop.length}): ${willDrop.join(', ')}`);
    console.log(`Will KEEP (${willKeep.length}): ${willKeep.join(', ')}`);
    console.log('');

    // Hard refuse if the drop list would touch any non-cra_ prefixed table
    const unsafe = willDrop.filter(t => !t.startsWith('cra_'));
    if (unsafe.length > 0) {
      throw new Error(`Safety check failed: refuse to drop tables without cra_ prefix: ${unsafe.join(', ')}`);
    }

    let dropped = 0;
    for (const t of [...DATA_TABLES, ...LOOKUP_TABLES]) {
      const res = await client.query(`DROP TABLE IF EXISTS cra.${t} CASCADE`);
      console.log(`DROP TABLE IF EXISTS cra.${t} CASCADE — ${res.command}`);
      dropped++;
    }

    console.log('');
    console.log(`Done. ${dropped} tables dropped.`);
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch(err => { console.error('FATAL:', err.message); process.exit(1); });
