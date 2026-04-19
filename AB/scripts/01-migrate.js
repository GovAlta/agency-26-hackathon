/**
 * 01-migrate.js - Create the AB schema and all tables for Alberta Open Data.
 *
 * Tables created:
 *   ab.ab_grants                  - Main grant payment records (streamed from 1.1GB JSON)
 *   ab.ab_grants_fiscal_years     - Fiscal year aggregations
 *   ab.ab_grants_ministries       - Ministry aggregations
 *   ab.ab_grants_programs         - Program aggregations
 *   ab.ab_grants_recipients       - Recipient aggregations
 *   ab.ab_contracts               - Blue Book contracts
 *   ab.ab_sole_source             - Sole-source contracts
 *   ab.ab_non_profit              - Alberta non-profit registry
 *   ab.ab_non_profit_status_lookup - Non-profit status definitions
 *
 * Idempotent: safe to re-run (CREATE IF NOT EXISTS).
 */
const { pool } = require('../lib/db');
const log = require('../lib/logger');

const migrations = [
  // ── Schema ──────────────────────────────────────────────────────────
  `CREATE SCHEMA IF NOT EXISTS ab`,

  // ── Grants: main payment records ───────────────────────────────────
  `CREATE TABLE IF NOT EXISTS ab.ab_grants (
    id SERIAL PRIMARY KEY,
    mongo_id VARCHAR(255) UNIQUE,
    ministry TEXT,
    business_unit_name TEXT,
    recipient TEXT,
    program TEXT,
    amount DECIMAL(15, 2),
    lottery TEXT,
    payment_date TIMESTAMP,
    fiscal_year TEXT,
    display_fiscal_year TEXT,
    lottery_fund TEXT,
    version INTEGER,
    created_at TIMESTAMP,
    updated_at TIMESTAMP
  )`,
  `ALTER TABLE ab.ab_grants DROP COLUMN IF EXISTS data_quality`,
  `ALTER TABLE ab.ab_grants DROP COLUMN IF EXISTS data_quality_issues`,
  `CREATE INDEX IF NOT EXISTS idx_ab_grants_ministry ON ab.ab_grants(ministry)`,
  `CREATE INDEX IF NOT EXISTS idx_ab_grants_recipient ON ab.ab_grants(recipient)`,
  `CREATE INDEX IF NOT EXISTS idx_ab_grants_fiscal_year ON ab.ab_grants(display_fiscal_year)`,
  `CREATE INDEX IF NOT EXISTS idx_ab_grants_program ON ab.ab_grants(program)`,
  `CREATE INDEX IF NOT EXISTS idx_ab_grants_payment_date ON ab.ab_grants(payment_date)`,
  `CREATE INDEX IF NOT EXISTS idx_ab_grants_amount ON ab.ab_grants(amount)`,
  `CREATE INDEX IF NOT EXISTS idx_ab_grants_recipient_tsvector ON ab.ab_grants USING GIN (to_tsvector('english', COALESCE(recipient, '')))`,

  // ── Grants: fiscal year aggregations ───────────────────────────────
  `CREATE TABLE IF NOT EXISTS ab.ab_grants_fiscal_years (
    id SERIAL PRIMARY KEY,
    mongo_id VARCHAR(255) UNIQUE,
    display_fiscal_year TEXT,
    count INTEGER,
    total_amount DECIMAL(20, 2),
    last_updated TIMESTAMP,
    version INTEGER
  )`,

  // ── Grants: ministry aggregations ──────────────────────────────────
  `CREATE TABLE IF NOT EXISTS ab.ab_grants_ministries (
    id SERIAL PRIMARY KEY,
    mongo_id VARCHAR(255) UNIQUE,
    ministry TEXT,
    display_fiscal_year TEXT,
    aggregation_type TEXT,
    count INTEGER,
    total_amount DECIMAL(20, 2),
    last_updated TIMESTAMP,
    version INTEGER
  )`,
  `CREATE INDEX IF NOT EXISTS idx_ab_grants_min_ministry ON ab.ab_grants_ministries(ministry)`,
  `CREATE INDEX IF NOT EXISTS idx_ab_grants_min_fiscal_year ON ab.ab_grants_ministries(display_fiscal_year)`,

  // ── Grants: program aggregations ───────────────────────────────────
  `CREATE TABLE IF NOT EXISTS ab.ab_grants_programs (
    id SERIAL PRIMARY KEY,
    mongo_id VARCHAR(255) UNIQUE,
    program TEXT,
    ministry TEXT,
    display_fiscal_year TEXT,
    aggregation_type TEXT,
    count INTEGER,
    total_amount DECIMAL(20, 2),
    last_updated TIMESTAMP,
    version INTEGER
  )`,
  `CREATE INDEX IF NOT EXISTS idx_ab_grants_prog_program ON ab.ab_grants_programs(program)`,
  `CREATE INDEX IF NOT EXISTS idx_ab_grants_prog_ministry ON ab.ab_grants_programs(ministry)`,
  `CREATE INDEX IF NOT EXISTS idx_ab_grants_prog_fiscal_year ON ab.ab_grants_programs(display_fiscal_year)`,

  // ── Grants: recipient aggregations ─────────────────────────────────
  `CREATE TABLE IF NOT EXISTS ab.ab_grants_recipients (
    id SERIAL PRIMARY KEY,
    mongo_id VARCHAR(255) UNIQUE,
    recipient TEXT,
    payments_count INTEGER,
    payments_amount DECIMAL(20, 2),
    programs_count INTEGER,
    ministries_count INTEGER,
    last_updated TIMESTAMP,
    version INTEGER
  )`,
  `CREATE INDEX IF NOT EXISTS idx_ab_grants_recip_recipient ON ab.ab_grants_recipients(recipient)`,
  `CREATE INDEX IF NOT EXISTS idx_ab_grants_recip_amount ON ab.ab_grants_recipients(payments_amount)`,

  // ── Contracts (Blue Book) ──────────────────────────────────────────
  `CREATE TABLE IF NOT EXISTS ab.ab_contracts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    display_fiscal_year TEXT,
    recipient TEXT,
    amount NUMERIC(15, 2),
    ministry TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_ab_contracts_fiscal_year ON ab.ab_contracts(display_fiscal_year)`,
  `CREATE INDEX IF NOT EXISTS idx_ab_contracts_recipient ON ab.ab_contracts(recipient)`,
  `CREATE INDEX IF NOT EXISTS idx_ab_contracts_ministry ON ab.ab_contracts(ministry)`,
  `CREATE INDEX IF NOT EXISTS idx_ab_contracts_amount ON ab.ab_contracts(amount)`,
  `CREATE INDEX IF NOT EXISTS idx_ab_contracts_recipient_tsvector ON ab.ab_contracts USING GIN (to_tsvector('english', COALESCE(recipient, '')))`,

  // ── Sole-Source Contracts ──────────────────────────────────────────
  `CREATE TABLE IF NOT EXISTS ab.ab_sole_source (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    ministry TEXT,
    department_street TEXT,
    department_street_2 TEXT,
    department_city TEXT,
    department_province TEXT,
    department_postal_code TEXT,
    department_country TEXT,
    vendor TEXT,
    vendor_street TEXT,
    vendor_street_2 TEXT,
    vendor_city TEXT,
    vendor_province TEXT,
    vendor_postal_code TEXT,
    vendor_country TEXT,
    start_date DATE,
    end_date DATE,
    amount NUMERIC(15, 2),
    contract_number TEXT,
    contract_services TEXT,
    permitted_situations TEXT,
    display_fiscal_year TEXT,
    special TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_ab_sole_source_fiscal_year ON ab.ab_sole_source(display_fiscal_year)`,
  `CREATE INDEX IF NOT EXISTS idx_ab_sole_source_vendor ON ab.ab_sole_source(vendor)`,
  `CREATE INDEX IF NOT EXISTS idx_ab_sole_source_ministry ON ab.ab_sole_source(ministry)`,
  `CREATE INDEX IF NOT EXISTS idx_ab_sole_source_amount ON ab.ab_sole_source(amount)`,
  `CREATE INDEX IF NOT EXISTS idx_ab_sole_source_start_date ON ab.ab_sole_source(start_date)`,
  `CREATE INDEX IF NOT EXISTS idx_ab_sole_source_vendor_tsvector ON ab.ab_sole_source USING GIN (to_tsvector('english', COALESCE(vendor, '')))`,

  // ── Non-Profit Registry ────────────────────────────────────────────
  `CREATE TABLE IF NOT EXISTS ab.ab_non_profit (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    type TEXT,
    legal_name TEXT,
    status TEXT,
    registration_date DATE,
    city TEXT,
    postal_code TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_ab_non_profit_type ON ab.ab_non_profit(type)`,
  `CREATE INDEX IF NOT EXISTS idx_ab_non_profit_legal_name ON ab.ab_non_profit(legal_name)`,
  `CREATE INDEX IF NOT EXISTS idx_ab_non_profit_status ON ab.ab_non_profit(status)`,
  `CREATE INDEX IF NOT EXISTS idx_ab_non_profit_reg_date ON ab.ab_non_profit(registration_date)`,
  `CREATE INDEX IF NOT EXISTS idx_ab_non_profit_city ON ab.ab_non_profit(city)`,
  `CREATE INDEX IF NOT EXISTS idx_ab_non_profit_postal_code ON ab.ab_non_profit(postal_code)`,
  `CREATE INDEX IF NOT EXISTS idx_ab_non_profit_name_tsvector ON ab.ab_non_profit USING GIN (to_tsvector('english', COALESCE(legal_name, '')))`,

  // ── Non-Profit Status Lookup ───────────────────────────────────────
  `CREATE TABLE IF NOT EXISTS ab.ab_non_profit_status_lookup (
    id SERIAL PRIMARY KEY,
    status TEXT UNIQUE NOT NULL,
    description TEXT
  )`,

  // ── Views ──────────────────────────────────────────────────────────
  `CREATE OR REPLACE VIEW ab.vw_grants_by_ministry AS
   SELECT display_fiscal_year, ministry,
          COUNT(*) AS payment_count,
          SUM(amount) AS total_amount,
          AVG(amount) AS avg_amount,
          MIN(amount) AS min_amount,
          MAX(amount) AS max_amount
   FROM ab.ab_grants
   GROUP BY display_fiscal_year, ministry
   ORDER BY display_fiscal_year, total_amount DESC`,

  `CREATE OR REPLACE VIEW ab.vw_grants_by_recipient AS
   SELECT recipient,
          COUNT(*) AS payment_count,
          SUM(amount) AS total_amount,
          COUNT(DISTINCT display_fiscal_year) AS fiscal_years_active,
          COUNT(DISTINCT ministry) AS ministries_count,
          COUNT(DISTINCT program) AS programs_count
   FROM ab.ab_grants
   GROUP BY recipient
   ORDER BY total_amount DESC`,

  `CREATE OR REPLACE VIEW ab.vw_non_profit_decoded AS
   SELECT np.*, sl.description AS status_description
   FROM ab.ab_non_profit np
   LEFT JOIN ab.ab_non_profit_status_lookup sl ON LOWER(np.status) = LOWER(sl.status)`,
];

async function runMigrations() {
  const client = await pool.connect();
  let succeeded = 0;
  let failed = 0;

  try {
    log.section('Alberta Open Data - Schema Migration');
    log.info(`Running ${migrations.length} migrations...`);

    for (let i = 0; i < migrations.length; i++) {
      const sql = migrations[i];
      const label = sql.trim().slice(0, 60).replace(/\s+/g, ' ');
      try {
        await client.query(sql);
        succeeded++;
        log.info(`  [${i + 1}/${migrations.length}] OK: ${label}...`);
      } catch (err) {
        failed++;
        log.error(`  [${i + 1}/${migrations.length}] FAIL: ${label}...`);
        log.error(`    ${err.message}`);
      }
    }

    log.section('Migration Summary');
    log.info(`Succeeded: ${succeeded}/${migrations.length}`);
    if (failed > 0) log.warn(`Failed: ${failed}/${migrations.length}`);
    else log.info('All migrations completed successfully.');
  } catch (err) {
    log.error(`Migration error: ${err.message}`);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

runMigrations();
