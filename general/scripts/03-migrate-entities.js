#!/usr/bin/env node
/**
 * 03-migrate-entities.js - Create golden record tables for cross-dataset entity resolution.
 *
 * Creates a 3NF schema in `general` for unified entity records ("golden records")
 * that link organisations across CRA, FED, and AB datasets. Each entity gets a
 * canonical name, alternate names, flexible JSONB metadata with provenance, and
 * links back to every source row that contributed to it.
 *
 * Tables:
 *   general.entities              - One row per resolved entity (golden record)
 *   general.entity_source_links   - FK links from golden record → source rows
 *   general.entity_resolution_log - Per-name progress tracking (resumability)
 *   general.resolution_batches    - Batch-run metadata
 *
 * Views:
 *   general.vw_entity_search      - Searchable entity directory
 *   general.vw_entity_funding     - Cross-dataset funding aggregation
 *
 * Usage:
 *   node scripts/03-migrate-entities.js
 *   npm run migrate:entities
 */
const fs = require('fs');
const path = require('path');
const { pool } = require('../lib/db');

const migrations = [
  // ═══════════════════════════════════════════════════════════════════
  //  TABLES
  // ═══════════════════════════════════════════════════════════════════

  // Golden record: one row per resolved real-world entity
  `CREATE TABLE IF NOT EXISTS general.entities (
    id SERIAL PRIMARY KEY,
    canonical_name TEXT NOT NULL,
    alternate_names TEXT[] DEFAULT '{}',
    entity_type TEXT DEFAULT 'unknown',
    bn_root VARCHAR(9),
    bn_variants TEXT[] DEFAULT '{}',
    metadata JSONB DEFAULT '{}',
    source_count INTEGER DEFAULT 0,
    dataset_sources TEXT[] DEFAULT '{}',
    confidence NUMERIC(4,3) DEFAULT 0,
    status TEXT DEFAULT 'draft',
    reviewed_by TEXT,
    llm_review JSONB,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
  )`,

  // Links from golden record back to individual source rows
  `CREATE TABLE IF NOT EXISTS general.entity_source_links (
    id SERIAL PRIMARY KEY,
    entity_id INTEGER NOT NULL REFERENCES general.entities(id) ON DELETE CASCADE,
    source_schema TEXT NOT NULL,
    source_table TEXT NOT NULL,
    source_pk JSONB NOT NULL,
    source_name TEXT,
    match_confidence NUMERIC(4,3),
    match_method TEXT,
    link_status TEXT DEFAULT 'confirmed',
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
  )`,

  // Per-name resolution progress (key resumability table)
  `CREATE TABLE IF NOT EXISTS general.entity_resolution_log (
    id SERIAL PRIMARY KEY,
    source_schema TEXT NOT NULL,
    source_table TEXT NOT NULL,
    source_name TEXT NOT NULL,
    original_names TEXT[],
    bn TEXT,
    record_count INTEGER DEFAULT 1,
    status TEXT DEFAULT 'pending',
    entity_id INTEGER REFERENCES general.entities(id),
    match_confidence NUMERIC(4,3),
    match_method TEXT,
    candidates JSONB,
    llm_response JSONB,
    error_message TEXT,
    batch_id INTEGER,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
  )`,

  // Batch-run tracking
  `CREATE TABLE IF NOT EXISTS general.resolution_batches (
    id SERIAL PRIMARY KEY,
    started_at TIMESTAMP DEFAULT NOW(),
    completed_at TIMESTAMP,
    source_description TEXT,
    status TEXT DEFAULT 'running',
    total_records INTEGER DEFAULT 0,
    processed_records INTEGER DEFAULT 0,
    matched_records INTEGER DEFAULT 0,
    created_records INTEGER DEFAULT 0,
    llm_reviewed INTEGER DEFAULT 0,
    error_records INTEGER DEFAULT 0,
    config JSONB DEFAULT '{}'
  )`,

  // Merge candidate pairs (staging for LLM review)
  `CREATE TABLE IF NOT EXISTS general.entity_merge_candidates (
    id SERIAL PRIMARY KEY,
    entity_id_a INTEGER NOT NULL REFERENCES general.entities(id),
    entity_id_b INTEGER NOT NULL REFERENCES general.entities(id),
    candidate_method TEXT NOT NULL,
    similarity_score NUMERIC(4,3),
    status TEXT DEFAULT 'pending',
    llm_verdict TEXT,
    llm_confidence NUMERIC(4,3),
    llm_reasoning TEXT,
    llm_response JSONB,
    llm_provider TEXT,
    llm_tokens_in INTEGER,
    llm_tokens_out INTEGER,
    batch_id INTEGER,
    reviewed_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT NOW()
  )`,

  // Unique index: treat pair (A,B) same as (B,A)
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_merge_cand_pair
     ON general.entity_merge_candidates (LEAST(entity_id_a, entity_id_b), GREATEST(entity_id_a, entity_id_b))`,

  // Merge audit trail
  `CREATE TABLE IF NOT EXISTS general.entity_merges (
    id SERIAL PRIMARY KEY,
    survivor_id INTEGER NOT NULL REFERENCES general.entities(id),
    absorbed_id INTEGER NOT NULL REFERENCES general.entities(id),
    candidate_id INTEGER,
    merge_method TEXT NOT NULL,
    names_added TEXT[],
    bns_added TEXT[],
    metadata_merged JSONB,
    links_redirected INTEGER DEFAULT 0,
    merged_at TIMESTAMP DEFAULT NOW(),
    merged_by TEXT DEFAULT 'pipeline'
  )`,

  // Add merged_into column to entities (soft delete for merges)
  `ALTER TABLE general.entities ADD COLUMN IF NOT EXISTS merged_into INTEGER REFERENCES general.entities(id)`,
  // Add materialized norm_canonical for fast joins
  `ALTER TABLE general.entities ADD COLUMN IF NOT EXISTS norm_canonical TEXT`,

  // ═══════════════════════════════════════════════════════════════════
  //  GOLDEN RECORDS — the final unified, authoritative table
  //  Populated by: 09-build-golden-records.js (SQL formula pass)
  //                08-llm-golden-records.js (LLM author + merge pass)
  // ═══════════════════════════════════════════════════════════════════

  `CREATE TABLE IF NOT EXISTS general.entity_golden_records (
    id INTEGER PRIMARY KEY,
    canonical_name TEXT NOT NULL,
    norm_name TEXT,
    entity_type TEXT,
    bn_root VARCHAR(9),
    bn_variants TEXT[] DEFAULT '{}',
    aliases JSONB DEFAULT '[]',
    dataset_sources TEXT[] DEFAULT '{}',
    source_summary JSONB DEFAULT '{}',
    source_link_count INTEGER DEFAULT 0,
    addresses JSONB DEFAULT '[]',
    cra_profile JSONB,
    fed_profile JSONB,
    ab_profile JSONB,
    related_entities JSONB DEFAULT '[]',
    merge_history JSONB DEFAULT '[]',
    llm_authored JSONB,
    confidence NUMERIC(4,3) DEFAULT 0,
    status TEXT DEFAULT 'active',
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
  )`,

  // Ensure llm_authored column exists on pre-existing tables (upgrade path).
  `ALTER TABLE general.entity_golden_records ADD COLUMN IF NOT EXISTS llm_authored JSONB`,

  `CREATE INDEX IF NOT EXISTS idx_gr_canonical ON general.entity_golden_records(canonical_name)`,
  `CREATE INDEX IF NOT EXISTS idx_gr_bn ON general.entity_golden_records(bn_root)`,
  `CREATE INDEX IF NOT EXISTS idx_gr_norm ON general.entity_golden_records(norm_name)`,
  `CREATE INDEX IF NOT EXISTS idx_gr_type ON general.entity_golden_records(entity_type)`,
  `CREATE INDEX IF NOT EXISTS idx_gr_status ON general.entity_golden_records(status)`,
  `CREATE INDEX IF NOT EXISTS idx_gr_ds ON general.entity_golden_records USING GIN (dataset_sources)`,
  `CREATE INDEX IF NOT EXISTS idx_gr_trgm ON general.entity_golden_records USING GIN (UPPER(canonical_name) gin_trgm_ops)`,

  // ═══════════════════════════════════════════════════════════════════
  //  NORMALIZATION FUNCTION (for fuzzy-free dedup matching)
  //  Handles: THE/trailing (THE), pipe-separated, ", .", whitespace,
  //  TRADE NAME OF, O/A, DBA, common punctuation
  // ═══════════════════════════════════════════════════════════════════

  // norm_name function is created separately below (needs $$ quoting that's awkward in JS)

  // ═══════════════════════════════════════════════════════════════════
  //  INDEXES: entities
  // ═══════════════════════════════════════════════════════════════════

  `CREATE INDEX IF NOT EXISTS idx_entities_canonical_name ON general.entities(canonical_name)`,
  `CREATE INDEX IF NOT EXISTS idx_entities_bn_root ON general.entities(bn_root)`,
  `CREATE INDEX IF NOT EXISTS idx_entities_status ON general.entities(status)`,
  `CREATE INDEX IF NOT EXISTS idx_entities_type ON general.entities(entity_type)`,
  `CREATE INDEX IF NOT EXISTS idx_entities_confidence ON general.entities(confidence)`,
  `CREATE INDEX IF NOT EXISTS idx_entities_trgm_name
     ON general.entities USING GIN (UPPER(canonical_name) gin_trgm_ops)`,
  `CREATE INDEX IF NOT EXISTS idx_entities_upper_canonical
     ON general.entities(UPPER(canonical_name))`,
  `CREATE INDEX IF NOT EXISTS idx_entities_alt_names
     ON general.entities USING GIN (alternate_names)`,
  `CREATE INDEX IF NOT EXISTS idx_entities_bn_variants
     ON general.entities USING GIN (bn_variants)`,
  `CREATE INDEX IF NOT EXISTS idx_entities_dataset_sources
     ON general.entities USING GIN (dataset_sources)`,
  `CREATE INDEX IF NOT EXISTS idx_entities_metadata
     ON general.entities USING GIN (metadata jsonb_path_ops)`,

  // ═══════════════════════════════════════════════════════════════════
  //  INDEXES: source links
  // ═══════════════════════════════════════════════════════════════════

  `CREATE INDEX IF NOT EXISTS idx_source_links_entity
     ON general.entity_source_links(entity_id)`,
  `CREATE INDEX IF NOT EXISTS idx_source_links_source
     ON general.entity_source_links(source_schema, source_table)`,
  `CREATE INDEX IF NOT EXISTS idx_source_links_status
     ON general.entity_source_links(link_status)`,
  `CREATE INDEX IF NOT EXISTS idx_source_links_pk
     ON general.entity_source_links USING GIN (source_pk jsonb_path_ops)`,

  // ═══════════════════════════════════════════════════════════════════
  //  INDEXES: resolution log
  // ═══════════════════════════════════════════════════════════════════

  `CREATE UNIQUE INDEX IF NOT EXISTS idx_resolution_log_unique
     ON general.entity_resolution_log(source_schema, source_table, source_name)`,
  `CREATE INDEX IF NOT EXISTS idx_resolution_log_status
     ON general.entity_resolution_log(status)`,
  `CREATE INDEX IF NOT EXISTS idx_resolution_log_batch
     ON general.entity_resolution_log(batch_id)`,
  `CREATE INDEX IF NOT EXISTS idx_resolution_log_entity
     ON general.entity_resolution_log(entity_id)`,

  // ═══════════════════════════════════════════════════════════════════
  //  INDEXES: merge candidates
  // ═══════════════════════════════════════════════════════════════════

  `CREATE INDEX IF NOT EXISTS idx_merge_cand_status ON general.entity_merge_candidates(status)`,
  `CREATE INDEX IF NOT EXISTS idx_merge_cand_a ON general.entity_merge_candidates(entity_id_a)`,
  `CREATE INDEX IF NOT EXISTS idx_merge_cand_b ON general.entity_merge_candidates(entity_id_b)`,
  `CREATE INDEX IF NOT EXISTS idx_merge_cand_batch ON general.entity_merge_candidates(batch_id)`,

  // ═══════════════════════════════════════════════════════════════════
  //  INDEXES: merges + entities additions
  // ═══════════════════════════════════════════════════════════════════

  `CREATE INDEX IF NOT EXISTS idx_merges_survivor ON general.entity_merges(survivor_id)`,
  `CREATE INDEX IF NOT EXISTS idx_merges_absorbed ON general.entity_merges(absorbed_id)`,
  `CREATE INDEX IF NOT EXISTS idx_entities_merged_into ON general.entities(merged_into)`,
  `CREATE INDEX IF NOT EXISTS idx_entities_norm_canonical ON general.entities(norm_canonical)`,

  // CRITICAL: trigram GIN on norm_canonical is the index 06-detect-candidates
  // Tier 4 uses for similarity search (a.norm_canonical % b.norm_canonical).
  // Without it, the tier does a sequential scan of ~800K entities per 20K-entity
  // batch partition, which takes hours instead of minutes.
  `CREATE INDEX IF NOT EXISTS idx_entities_norm_canonical_trgm
     ON general.entities USING GIN (norm_canonical gin_trgm_ops)`,

  // ═══════════════════════════════════════════════════════════════════
  //  DOSSIER SEARCH-SPEED INDEXES
  //
  //  The dossier search needs case-insensitive substring search across
  //  canonical_name AND every alternate_name, plus partial-BN lookups.
  //  The existing GIN (alternate_names) index only supports array-
  //  containment ops (@>), not case-insensitive LIKE.
  //
  //  These three indexes make a typical "BOYLE" or "118814" search
  //  return in well under a second on an 850K-row entities table instead
  //  of a multi-second scan over every alternate_names array.
  // ═══════════════════════════════════════════════════════════════════

  // Trigram GIN on upper-cased, space-joined alternate_names. The dossier
  // search can then do general.array_upper_join(alternate_names) LIKE
  // '%TERM%' and hit an index.
  //
  // Why a helper function: Postgres marks array_to_string() STABLE, which is
  // rejected in index expressions. general.array_upper_join() is a plain-SQL
  // IMMUTABLE wrapper defined in bn_helpers.sql that does the same thing.
  `CREATE INDEX IF NOT EXISTS idx_entities_alt_names_trgm
     ON general.entities
     USING GIN (general.array_upper_join(alternate_names) gin_trgm_ops)`,

  // Trigram GIN on bn_root for partial-BN search (user types "1188" and
  // gets every entity whose BN starts with 1188). Cheap — bn_root is 9
  // chars and many are NULL. ~5 MB.
  `CREATE INDEX IF NOT EXISTS idx_entities_bn_root_trgm
     ON general.entities USING GIN (bn_root gin_trgm_ops)
     WHERE bn_root IS NOT NULL`,

  // Partial trigram index for active-only canonical-name search. The main
  // dossier search filters WHERE merged_into IS NULL; this partial index
  // skips the ~7% merged rows so scans are smaller + faster.
  `CREATE INDEX IF NOT EXISTS idx_entities_active_name_trgm
     ON general.entities USING GIN (UPPER(canonical_name) gin_trgm_ops)
     WHERE merged_into IS NULL`,

  // ═══════════════════════════════════════════════════════════════════
  //  HELPER INDEXES on source tables for efficient bulk linking
  //  (UPPER(TRIM(name)) B-tree for equality joins during link phase)
  // ═══════════════════════════════════════════════════════════════════

  `CREATE INDEX IF NOT EXISTS idx_fed_gc_upper_trim_name
     ON fed.grants_contributions(UPPER(TRIM(recipient_legal_name)))`,
  `CREATE INDEX IF NOT EXISTS idx_ab_grants_upper_trim_recipient
     ON ab.ab_grants(UPPER(TRIM(recipient)))`,
  `CREATE INDEX IF NOT EXISTS idx_ab_contracts_upper_trim_recipient
     ON ab.ab_contracts(UPPER(TRIM(recipient)))`,
  `CREATE INDEX IF NOT EXISTS idx_ab_sole_source_upper_trim_vendor
     ON ab.ab_sole_source(UPPER(TRIM(vendor)))`,
  `CREATE INDEX IF NOT EXISTS idx_ab_non_profit_upper_trim_name
     ON ab.ab_non_profit(UPPER(TRIM(legal_name)))`,

  // ═══════════════════════════════════════════════════════════════════
  //  SPLINK PROBABILISTIC MATCHES
  //  Populated by: splink/run_splink.py (Python subprocess)
  //  Consumed by: 06-detect-candidates.js Tier 5 (splink_match)
  // ═══════════════════════════════════════════════════════════════════

  // Pairwise probabilistic match predictions from Splink's Fellegi-Sunter model.
  // Each row is a candidate match between two source records with an EM-learned
  // probability. The source records join back to our entities via entity_source_links
  // on (source_schema, source_table, source_pk), letting us promote Splink-identified
  // pairs into our merge candidate queue for LLM review.
  `CREATE TABLE IF NOT EXISTS general.splink_predictions (
    id SERIAL PRIMARY KEY,
    source_l TEXT NOT NULL,              -- dataset of left record
    record_l TEXT NOT NULL,              -- source_id of left record
    source_r TEXT NOT NULL,              -- dataset of right record
    record_r TEXT NOT NULL,              -- source_id of right record
    match_probability NUMERIC(6,5) NOT NULL,
    match_weight NUMERIC(10,6),          -- log-odds weight from Splink
    features JSONB DEFAULT '{}',         -- per-comparison gamma values
    cluster_id TEXT,                     -- Splink's connected-components cluster label
    build_id INTEGER,                    -- FK to splink_build_metadata.id
    created_at TIMESTAMP DEFAULT NOW()
  )`,

  `CREATE INDEX IF NOT EXISTS idx_splink_pred_l
     ON general.splink_predictions(source_l, record_l)`,
  `CREATE INDEX IF NOT EXISTS idx_splink_pred_r
     ON general.splink_predictions(source_r, record_r)`,
  `CREATE INDEX IF NOT EXISTS idx_splink_pred_prob
     ON general.splink_predictions(match_probability)`,
  `CREATE INDEX IF NOT EXISTS idx_splink_pred_cluster
     ON general.splink_predictions(cluster_id)`,

  // Splink-derived aliases: additional name variants Splink picked up via
  // probabilistic matching that we missed with deterministic cascade. Joined
  // into entity_golden_records at the compile step.
  `CREATE TABLE IF NOT EXISTS general.splink_aliases (
    id SERIAL PRIMARY KEY,
    cluster_id TEXT NOT NULL,
    alias TEXT NOT NULL,
    source_dataset TEXT,
    source_id TEXT,
    match_probability NUMERIC(6,5),
    build_id INTEGER,
    UNIQUE (cluster_id, alias, source_dataset, source_id)
  )`,

  `CREATE INDEX IF NOT EXISTS idx_splink_alias_cluster
     ON general.splink_aliases(cluster_id)`,

  // Build metadata — one row per Splink run
  `CREATE TABLE IF NOT EXISTS general.splink_build_metadata (
    id SERIAL PRIMARY KEY,
    started_at TIMESTAMP DEFAULT NOW(),
    completed_at TIMESTAMP,
    splink_version TEXT,
    backend TEXT DEFAULT 'duckdb',
    threshold NUMERIC(3,2),
    total_records INTEGER,
    total_predictions INTEGER,
    total_clusters INTEGER,
    config JSONB DEFAULT '{}',
    status TEXT DEFAULT 'running'
  )`,

  // ═══════════════════════════════════════════════════════════════════
  //  TIER 6 — donee_name trigram fallback staging
  //  Populated by scripts/10-donee-trigram-fallback.js Phase A. One row
  //  per distinct unlinked donee_name with its best primary-source
  //  trigram neighbour. Phase B updates verdict via LLM; Phase C applies
  //  SAME verdicts as new entity_source_links + alias enrichment.
  // ═══════════════════════════════════════════════════════════════════
  `CREATE TABLE IF NOT EXISTS general.donee_trigram_candidates (
    id SERIAL PRIMARY KEY,
    donee_name TEXT NOT NULL,
    donee_name_norm TEXT NOT NULL UNIQUE,
    candidate_entity_id INTEGER NOT NULL REFERENCES general.entities(id),
    candidate_canonical_name TEXT NOT NULL,
    candidate_bn_root VARCHAR(9),
    similarity NUMERIC(4,3) NOT NULL,
    citations INTEGER NOT NULL DEFAULT 0,
    total_gifts NUMERIC(18,2),
    status TEXT NOT NULL DEFAULT 'pending',
    llm_verdict TEXT,
    llm_confidence NUMERIC(3,2),
    llm_reasoning TEXT,
    reviewed_at TIMESTAMP,
    applied_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT NOW()
  )`,

  `CREATE INDEX IF NOT EXISTS idx_donee_trigram_status
     ON general.donee_trigram_candidates(status)`,
  `CREATE INDEX IF NOT EXISTS idx_donee_trigram_entity
     ON general.donee_trigram_candidates(candidate_entity_id)`,

  // ═══════════════════════════════════════════════════════════════════
  //  VIEWS
  // ═══════════════════════════════════════════════════════════════════

  // Simple entity directory view
  `CREATE OR REPLACE VIEW general.vw_entity_search AS
   SELECT
     e.id,
     e.canonical_name,
     e.alternate_names,
     e.entity_type,
     e.bn_root,
     e.bn_variants,
     e.metadata,
     e.source_count,
     e.dataset_sources,
     e.confidence,
     e.status
   FROM general.entities e`,

  // Cross-dataset funding aggregation view.
  // CRA data joins via bn_root (inherent link). FED and AB join via source_links.
  // Fast for single-entity lookups; full-table scan is expensive (use MATERIALIZED if needed).
  `CREATE OR REPLACE VIEW general.vw_entity_funding AS
   WITH cra_funds AS (
     SELECT
       e.id AS entity_id,
       SUM(fd.field_4700) AS total_revenue,
       SUM(fd.field_5100) AS total_expenditures,
       SUM(fd.field_5050) AS gifts_to_donees,
       SUM(fd.field_5000) AS program_spending,
       COUNT(DISTINCT fd.fpe) AS filing_count,
       MIN(EXTRACT(YEAR FROM fd.fpe))::int AS earliest_year,
       MAX(EXTRACT(YEAR FROM fd.fpe))::int AS latest_year
     FROM general.entities e
     JOIN cra.cra_financial_details fd ON LEFT(fd.bn, 9) = e.bn_root
     WHERE e.bn_root IS NOT NULL
     GROUP BY e.id
   ),
   fed_funds AS (
     SELECT
       esl.entity_id,
       SUM(gc.agreement_value) AS total_grants,
       COUNT(*) AS grant_count,
       MIN(gc.agreement_start_date) AS earliest_grant,
       MAX(gc.agreement_start_date) AS latest_grant
     FROM general.entity_source_links esl
     JOIN fed.grants_contributions gc ON gc._id = (esl.source_pk->>'_id')::int
     WHERE esl.source_schema = 'fed' AND esl.source_table = 'grants_contributions'
     GROUP BY esl.entity_id
   ),
   ab_grants_funds AS (
     SELECT
       esl.entity_id,
       SUM(g.amount) AS total_grants,
       COUNT(*) AS payment_count
     FROM general.entity_source_links esl
     JOIN ab.ab_grants g ON g.id = (esl.source_pk->>'id')::int
     WHERE esl.source_schema = 'ab' AND esl.source_table = 'ab_grants'
     GROUP BY esl.entity_id
   ),
   ab_contracts_funds AS (
     SELECT
       esl.entity_id,
       SUM(c.amount) AS total_contracts,
       COUNT(*) AS contract_count
     FROM general.entity_source_links esl
     JOIN ab.ab_contracts c ON c.id = (esl.source_pk->>'id')::uuid
     WHERE esl.source_schema = 'ab' AND esl.source_table = 'ab_contracts'
     GROUP BY esl.entity_id
   ),
   ab_sole_source_funds AS (
     SELECT
       esl.entity_id,
       SUM(ss.amount) AS total_sole_source,
       COUNT(*) AS sole_source_count
     FROM general.entity_source_links esl
     JOIN ab.ab_sole_source ss ON ss.id = (esl.source_pk->>'id')::uuid
     WHERE esl.source_schema = 'ab' AND esl.source_table = 'ab_sole_source'
     GROUP BY esl.entity_id
   )
   SELECT
     e.id AS entity_id,
     e.canonical_name,
     e.bn_root,
     e.entity_type,
     e.dataset_sources,
     e.source_count,
     e.confidence,
     e.status,
     COALESCE(cf.total_revenue, 0) AS cra_total_revenue,
     COALESCE(cf.total_expenditures, 0) AS cra_total_expenditures,
     COALESCE(cf.gifts_to_donees, 0) AS cra_gifts_to_donees,
     COALESCE(cf.program_spending, 0) AS cra_program_spending,
     cf.filing_count AS cra_filing_count,
     cf.earliest_year AS cra_earliest_year,
     cf.latest_year AS cra_latest_year,
     COALESCE(ff.total_grants, 0) AS fed_total_grants,
     ff.grant_count AS fed_grant_count,
     ff.earliest_grant AS fed_earliest_grant,
     ff.latest_grant AS fed_latest_grant,
     COALESCE(agf.total_grants, 0) AS ab_total_grants,
     agf.payment_count AS ab_grant_payment_count,
     COALESCE(acf.total_contracts, 0) AS ab_total_contracts,
     acf.contract_count AS ab_contract_count,
     COALESCE(assf.total_sole_source, 0) AS ab_total_sole_source,
     assf.sole_source_count AS ab_sole_source_count,
     COALESCE(cf.total_revenue, 0) + COALESCE(ff.total_grants, 0)
       + COALESCE(agf.total_grants, 0) + COALESCE(acf.total_contracts, 0)
       + COALESCE(assf.total_sole_source, 0) AS total_all_funding
   FROM general.entities e
   LEFT JOIN cra_funds cf ON cf.entity_id = e.id
   LEFT JOIN fed_funds ff ON ff.entity_id = e.id
   LEFT JOIN ab_grants_funds agf ON agf.entity_id = e.id
   LEFT JOIN ab_contracts_funds acf ON acf.entity_id = e.id
   LEFT JOIN ab_sole_source_funds assf ON assf.entity_id = e.id
   WHERE e.merged_into IS NULL`,
];

async function run() {
  const client = await pool.connect();
  try {
    console.log('Running entity resolution schema migrations...\n');
    for (let i = 0; i < migrations.length; i++) {
      try {
        await client.query(migrations[i]);
        console.log(`  [${i + 1}/${migrations.length}] OK`);
      } catch (err) {
        if (err.message.includes('already exists')) {
          console.log(`  [${i + 1}/${migrations.length}] Already exists (OK)`);
        } else {
          console.error(`  [${i + 1}/${migrations.length}] ERROR: ${err.message}`);
          throw err;
        }
      }
    }
    // Install SQL-defined helper functions (avoid $$-quoting issues in JS literals).
    console.log('\n  Creating norm_name function...');
    const normSql = fs.readFileSync(path.join(__dirname, 'norm_name.sql'), 'utf-8');
    await client.query(normSql);
    console.log('  norm_name function: OK');

    console.log('  Creating bn_helpers (is_valid_bn_root + extract_bn_root)...');
    const bnSql = fs.readFileSync(path.join(__dirname, 'bn_helpers.sql'), 'utf-8');
    await client.query(bnSql);
    console.log('  bn_helpers: OK');

    // Functional index for norm_canonical equality joins.
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_entities_norm_name
        ON general.entities(general.norm_name(canonical_name))
    `);
    console.log('  idx_entities_norm_name: OK');

    console.log('\nEntity resolution migrations completed.');
  } finally {
    client.release();
    await pool.end();
  }
}

run();
