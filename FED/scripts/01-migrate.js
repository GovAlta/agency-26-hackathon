/**
 * 01-migrate.js - Database Schema Migration
 *
 * Creates the 'fed' schema, main grants_contributions table, reference lookup
 * tables, indexes, and views.
 *
 * Fully idempotent - safe to run multiple times (uses IF NOT EXISTS / OR REPLACE).
 *
 * Usage: npm run migrate
 */
const db = require('../lib/db');
const log = require('../lib/logger');

async function migrate() {
  const client = await db.getClient();

  try {
    log.section('Federal Grants & Contributions Database Migration');
    log.info('Creating schema, tables, indexes, and views...');

    // ─── Schema ──────────────────────────────────────────────────
    await client.query(`CREATE SCHEMA IF NOT EXISTS fed;`);
    log.info('Ensured fed schema exists');

    // Set search path for this session
    await client.query(`SET search_path TO fed, public;`);

    // ─── Reference / Lookup Tables ───────────────────────────────

    await client.query(`
      CREATE TABLE IF NOT EXISTS fed.agreement_type_lookup (
        code VARCHAR(2) PRIMARY KEY,
        name_en TEXT NOT NULL,
        name_fr TEXT
      );
    `);
    log.info('Created fed.agreement_type_lookup');

    await client.query(`
      CREATE TABLE IF NOT EXISTS fed.recipient_type_lookup (
        code VARCHAR(2) PRIMARY KEY,
        name_en TEXT NOT NULL,
        name_fr TEXT
      );
    `);
    log.info('Created fed.recipient_type_lookup');

    await client.query(`
      CREATE TABLE IF NOT EXISTS fed.country_lookup (
        code VARCHAR(4) PRIMARY KEY,
        name_en TEXT NOT NULL,
        name_fr TEXT
      );
    `);
    log.info('Created fed.country_lookup');

    await client.query(`
      CREATE TABLE IF NOT EXISTS fed.province_lookup (
        code VARCHAR(4) PRIMARY KEY,
        name_en TEXT NOT NULL,
        name_fr TEXT
      );
    `);
    log.info('Created fed.province_lookup');

    await client.query(`
      CREATE TABLE IF NOT EXISTS fed.currency_lookup (
        code VARCHAR(4) PRIMARY KEY,
        name_en TEXT NOT NULL,
        name_fr TEXT
      );
    `);
    log.info('Created fed.currency_lookup');

    // ─── Main Data Table ─────────────────────────────────────────

    await client.query(`
      CREATE TABLE IF NOT EXISTS fed.grants_contributions (
        _id INTEGER PRIMARY KEY,
        ref_number TEXT,
        amendment_number TEXT,
        amendment_date DATE,
        agreement_type TEXT,
        agreement_number TEXT,
        recipient_type TEXT,
        recipient_business_number TEXT,
        recipient_legal_name TEXT,
        recipient_operating_name TEXT,
        research_organization_name TEXT,
        recipient_country TEXT,
        recipient_province TEXT,
        recipient_city TEXT,
        recipient_postal_code TEXT,
        federal_riding_name_en TEXT,
        federal_riding_name_fr TEXT,
        federal_riding_number TEXT,
        prog_name_en TEXT,
        prog_name_fr TEXT,
        prog_purpose_en TEXT,
        prog_purpose_fr TEXT,
        agreement_title_en TEXT,
        agreement_title_fr TEXT,
        agreement_value DECIMAL(15,2),
        foreign_currency_type TEXT,
        foreign_currency_value DECIMAL(15,2),
        agreement_start_date DATE,
        agreement_end_date DATE,
        coverage TEXT,
        description_en TEXT,
        description_fr TEXT,
        expected_results_en TEXT,
        expected_results_fr TEXT,
        additional_information_en TEXT,
        additional_information_fr TEXT,
        naics_identifier TEXT,
        owner_org TEXT,
        owner_org_title TEXT,
        -- is_amendment is populated by 06-fix-quality.js (flags amendment rows
        -- by amendment_number). Declared here so the analytical views
        -- vw_grants_by_department / vw_grants_by_province created below can
        -- reference it on a fresh install. 06-fix-quality.js still runs an
        -- idempotent ALTER TABLE ADD COLUMN that no-ops when the column
        -- already exists.
        is_amendment BOOLEAN DEFAULT false
      );
    `);
    log.info('Created fed.grants_contributions');

    // ─── Indexes ─────────────────────────────────────────────────

    // Agreement type filtering
    await client.query(`CREATE INDEX IF NOT EXISTS idx_fed_gc_agreement_type ON fed.grants_contributions(agreement_type);`);
    // Recipient type filtering
    await client.query(`CREATE INDEX IF NOT EXISTS idx_fed_gc_recipient_type ON fed.grants_contributions(recipient_type);`);
    // Province filtering
    await client.query(`CREATE INDEX IF NOT EXISTS idx_fed_gc_province ON fed.grants_contributions(recipient_province);`);
    // Country filtering
    await client.query(`CREATE INDEX IF NOT EXISTS idx_fed_gc_country ON fed.grants_contributions(recipient_country);`);
    // Date range queries
    await client.query(`CREATE INDEX IF NOT EXISTS idx_fed_gc_start_date ON fed.grants_contributions(agreement_start_date);`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_fed_gc_end_date ON fed.grants_contributions(agreement_end_date);`);
    // Value range queries
    await client.query(`CREATE INDEX IF NOT EXISTS idx_fed_gc_value ON fed.grants_contributions(agreement_value);`);
    // Owner org for department analysis
    await client.query(`CREATE INDEX IF NOT EXISTS idx_fed_gc_owner_org ON fed.grants_contributions(owner_org);`);
    // Full-text search on recipient name
    await client.query(`CREATE INDEX IF NOT EXISTS idx_fed_gc_recipient_name ON fed.grants_contributions USING gin(to_tsvector('english', COALESCE(recipient_legal_name, '')));`);
    // #68: B-tree for GROUP BY operations on recipient_legal_name
    await client.query(`CREATE INDEX IF NOT EXISTS idx_fed_gc_recipient_name_btree ON fed.grants_contributions(recipient_legal_name);`);
    // Full-text search on program name
    await client.query(`CREATE INDEX IF NOT EXISTS idx_fed_gc_program_name ON fed.grants_contributions USING gin(to_tsvector('english', COALESCE(prog_name_en, '')));`);
    // NAICS code
    await client.query(`CREATE INDEX IF NOT EXISTS idx_fed_gc_naics ON fed.grants_contributions(naics_identifier);`);
    // Federal riding
    await client.query(`CREATE INDEX IF NOT EXISTS idx_fed_gc_riding ON fed.grants_contributions(federal_riding_number);`);

    log.info('Created indexes on fed.grants_contributions');

    // ─── Views ───────────────────────────────────────────────────

    // Grants with decoded lookup values
    await client.query(`
      CREATE OR REPLACE VIEW fed.vw_grants_decoded AS
      SELECT
        gc._id,
        gc.ref_number,
        gc.amendment_number,
        gc.amendment_date,
        gc.agreement_type,
        atl.name_en AS agreement_type_name,
        gc.agreement_number,
        gc.recipient_type,
        rtl.name_en AS recipient_type_name,
        gc.recipient_business_number,
        gc.recipient_legal_name,
        gc.recipient_operating_name,
        gc.research_organization_name,
        gc.recipient_country,
        cl.name_en AS country_name,
        gc.recipient_province,
        pl.name_en AS province_name,
        gc.recipient_city,
        gc.recipient_postal_code,
        gc.federal_riding_name_en,
        gc.federal_riding_number,
        gc.prog_name_en,
        gc.prog_purpose_en,
        gc.agreement_title_en,
        gc.agreement_value,
        gc.foreign_currency_type,
        gc.foreign_currency_value,
        gc.agreement_start_date,
        gc.agreement_end_date,
        gc.coverage,
        gc.description_en,
        gc.expected_results_en,
        gc.additional_information_en,
        gc.naics_identifier,
        gc.owner_org,
        gc.owner_org_title
      FROM fed.grants_contributions gc
      LEFT JOIN fed.agreement_type_lookup atl ON gc.agreement_type = atl.code
      LEFT JOIN fed.recipient_type_lookup rtl ON gc.recipient_type = rtl.code
      LEFT JOIN fed.country_lookup cl ON gc.recipient_country = cl.code
      LEFT JOIN fed.province_lookup pl ON gc.recipient_province = pl.code;
    `);
    log.info('Created fed.vw_grants_decoded view');

    // Summary by department
    await client.query(`
      CREATE OR REPLACE VIEW fed.vw_grants_by_department AS
      SELECT
        owner_org,
        owner_org_title,
        agreement_type,
        COUNT(*) AS grant_count,
        SUM(agreement_value) AS total_value,
        AVG(agreement_value) AS avg_value,
        MIN(agreement_start_date) AS earliest_start,
        MAX(agreement_start_date) AS latest_start
      FROM fed.grants_contributions
      WHERE is_amendment = false
      GROUP BY owner_org, owner_org_title, agreement_type
      ORDER BY total_value DESC NULLS LAST;
    `);
    log.info('Created fed.vw_grants_by_department view');

    // Summary by province
    await client.query(`
      CREATE OR REPLACE VIEW fed.vw_grants_by_province AS
      SELECT
        recipient_province,
        pl.name_en AS province_name,
        COUNT(*) AS grant_count,
        SUM(agreement_value) AS total_value,
        AVG(agreement_value) AS avg_value,
        COUNT(DISTINCT owner_org) AS department_count
      FROM fed.grants_contributions gc
      LEFT JOIN fed.province_lookup pl ON gc.recipient_province = pl.code
      WHERE recipient_province IS NOT NULL AND gc.is_amendment = false
      GROUP BY recipient_province, pl.name_en
      ORDER BY total_value DESC NULLS LAST;
    `);
    log.info('Created fed.vw_grants_by_province view');

    // Current commitment per agreement.
    //
    // Per TBS Proactive Publication spec, agreement_value is "the total grant
    // or contribution value, and not the change in agreement value" — each
    // row is a cumulative snapshot. The per-row value on the highest
    // amendment_number for a given agreement is therefore the current
    // commitment.
    //
    // Partition key: (ref_number, COALESCE(bn, legal_name, _id)). ref_number
    // is spec'd unique-per-entry but publisher defects exist (≈41K ref_numbers
    // appear under >1 recipient; ≈26K (ref_number, amendment_number) pairs
    // duplicate — see DATA_DICTIONARY.md "Known source defects"). We fall back
    // from bn (often NULL — 31.5K ref_numbers have ≥2 rows all with NULL bn)
    // to legal_name, and finally to _id, so colliding distinct agreements stay
    // separated instead of silently collapsing.
    //
    // Trade-off: when a single agreement's recipient_legal_name changes across
    // amendments (e.g. bilingual renaming), this view can produce two rows
    // instead of one. Prefer accuracy on collisions over merging legitimate
    // amendments with name drift.
    //
    // amendment_number is stored as TEXT but is numeric-only in practice;
    // strip non-digits and cast to INT so "10" sorts after "2".
    await client.query(`
      CREATE OR REPLACE VIEW fed.vw_agreement_current AS
      SELECT DISTINCT ON (
               gc.ref_number,
               COALESCE(gc.recipient_business_number, gc.recipient_legal_name, gc._id::text)
             )
        gc._id,
        gc.ref_number,
        gc.amendment_number,
        gc.amendment_date,
        gc.agreement_type,
        gc.agreement_number,
        gc.recipient_type,
        gc.recipient_business_number,
        gc.recipient_legal_name,
        gc.recipient_operating_name,
        gc.recipient_country,
        gc.recipient_province,
        gc.recipient_city,
        gc.prog_name_en,
        gc.agreement_title_en,
        gc.agreement_value,
        gc.foreign_currency_type,
        gc.foreign_currency_value,
        gc.agreement_start_date,
        gc.agreement_end_date,
        gc.owner_org,
        gc.owner_org_title,
        gc.is_amendment
      FROM fed.grants_contributions gc
      WHERE gc.ref_number IS NOT NULL
      ORDER BY
        gc.ref_number,
        COALESCE(gc.recipient_business_number, gc.recipient_legal_name, gc._id::text),
        NULLIF(regexp_replace(gc.amendment_number, '\\D', '', 'g'), '')::int DESC NULLS LAST,
        gc.amendment_date DESC NULLS LAST,
        gc._id DESC;
    `);
    log.info('Created fed.vw_agreement_current view');

    // Original commitment only — rows with amendment_number = 0.
    //
    // Use this when the question is "what did the department initially
    // commit to?". For "what is the current total commitment?", use
    // vw_agreement_current above. For "every snapshot ever published,
    // including amendments" (rarely the right default), query the base
    // table directly.
    await client.query(`
      CREATE OR REPLACE VIEW fed.vw_agreement_originals AS
      SELECT
        gc._id,
        gc.ref_number,
        gc.amendment_number,
        gc.agreement_type,
        gc.agreement_number,
        gc.recipient_type,
        gc.recipient_business_number,
        gc.recipient_legal_name,
        gc.recipient_operating_name,
        gc.recipient_country,
        gc.recipient_province,
        gc.recipient_city,
        gc.prog_name_en,
        gc.agreement_title_en,
        gc.agreement_value,
        gc.foreign_currency_type,
        gc.foreign_currency_value,
        gc.agreement_start_date,
        gc.agreement_end_date,
        gc.owner_org,
        gc.owner_org_title
      FROM fed.grants_contributions gc
      WHERE gc.is_amendment = false;
    `);
    log.info('Created fed.vw_agreement_originals view');

    log.section('Migration Complete');
    log.info('5 lookup tables + 1 data table + 5 views + 12 indexes created successfully');

  } catch (err) {
    log.error(`Migration failed: ${err.message}`);
    throw err;
  } finally {
    client.release();
    await db.end();
  }
}

migrate().catch((err) => {
  console.error('Fatal migration error:', err);
  process.exit(1);
});
