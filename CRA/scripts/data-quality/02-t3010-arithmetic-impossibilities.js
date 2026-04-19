/**
 * 02-t3010-arithmetic-impossibilities.js   (part of scripts/data-quality/)
 *
 * Arithmetic-impossibility detector for T3010 filings. Flags filings
 * whose reported numbers are structurally inconsistent with the T3010
 * form text or the CRA Open Data Dictionary v2.0.
 *
 * Four design principles, applied without exception:
 *
 *   1. NULL-AS-0 FOR IDENTITY RULES. Every field in an identity equation
 *      is coerced to 0 when NULL. The form's own design makes NULL = 0
 *      for most optional fields (T3010 page 4: "All relevant fields
 *      must be filled out" — blank means "not relevant to this charity"),
 *      so treating them arithmetically as zero matches filer intent.
 *
 *      An identity rule fires when:
 *        (a) At least one value in the equation is non-zero (so we don't
 *            flag trivially-all-zero filings that have no data to
 *            reconcile), AND
 *        (b) |LHS - SUM(addends)| > tolerance, with NULLs coalesced to 0.
 *
 *      This captures three failure modes in one check per identity:
 *        • MISSING TOTAL: 4950 = $50 but 5100 = 0 or NULL → mismatch
 *        • RECONCILIATION FAILURE: 5100 = $100, 4950 = $50 → mismatch
 *        • EMPTY BREAKDOWN: 5100 = $569 but every addend NULL/0 → mismatch
 *
 *   2. EVERY RULE TRACEABLE TO FORM TEXT. No magnitude thresholds,
 *      no sign conventions the form doesn't assert, no plausibility
 *      heuristics. A negative field_4950 is uncommon but the form
 *      permits it (reversals, refunds) — so 5050 > 5100 is NOT an
 *      impossibility, it is an arithmetic consequence of a negative
 *      4950. Plausibility flags live in a separate table.
 *
 *   3. SECTION AWARE. T3010 filings use either Section D (simplified,
 *      for charities with revenue < $100K — only aggregate totals
 *      reported) or Schedule 6 (detailed, full breakdown). The
 *      cra_financial_details table has a `section_used` column
 *      ('D' or '6') and a `form_id` column (form version).
 *      Balance-sheet IDENTITY_4200 and IDENTITY_4350 apply ONLY to
 *      section_used = '6' filings — Section D filers do not report
 *      the component lines (4100-4170, 4300-4330), so evaluating
 *      those identities on Section D is nonsensical.
 *      Expenditure IDENTITY_5100 applies to both sections (per form
 *      line 268 for Section D and line 657 for Schedule 6).
 *
 *   4. COMPLETENESS AND PLAUSIBILITY ARE SEPARATE. The schema includes
 *      a completeness table for future use, but no current rule writes
 *      to it — every identity failure is classified as an impossibility
 *      because under the NULL-as-0 convention, the three failure modes
 *      (missing total, reconciliation mismatch, empty breakdown) are
 *      mathematically indistinguishable. The plausibility table holds
 *      editorial flags (magnitude ceilings, exp/rev ratios, comp >
 *      total) that are not structural impossibilities.
 *
 * ─── TABLES PRODUCED ─────────────────────────────────────────────────────
 *
 *   cra.t3010_impossibilities        — identities that fail with all
 *                                      required operands populated
 *   cra.t3010_completeness_issues    — required operands missing
 *                                      (section-aware: only fields
 *                                      the charity's form version
 *                                      actually asks for)
 *   cra.t3010_plausibility_flags     — values exceeding editorial
 *                                      thresholds
 *
 * ─── RULES ───────────────────────────────────────────────────────────────
 *
 * EXPENDITURE-TREE IDENTITIES (form text references are to T3010.md)
 *
 *   IDENTITY_5100            field_5100 = field_4950 + field_5045 + field_5050
 *                            Form line 657 (Schedule 6) / line 281
 *                            (Section D): "Total expenditures (add lines
 *                            4950, 5045 and 5050)". Applies to both
 *                            sections.
 *                            STRICT: fires only when field_5100 AND
 *                            field_4950 are both populated (the two
 *                            required totals).
 *                            field_5045 and field_5050 are treated as
 *                            semantically-zero when NULL — per principle
 *                            4 in the header, both fields represent
 *                            "gifts the charity did not make" and the
 *                            form's own design makes NULL = "none" = 0.
 *                            E.g. BN 852026368RR0001 reports 5100 = 4950
 *                            exactly in FY21–FY24 with 5050 NULL every
 *                            year — that's a clean filing, not an error.
 *
 *   PARTITION_4950           field_5000 + field_5010 + field_5020 + field_5040
 *                                > field_4950
 *                            Form line 644: "Of the amounts at lines 4950".
 *                            One-sided: only over-partitions are flagged
 *                            (v24+ removed field_5030, making strict
 *                            equality version-sensitive). STRICT: fires
 *                            only when field_4950 is populated AND at
 *                            least one of 5000/5010/5020/5040 is populated.
 *
 * BALANCE-SHEET IDENTITIES
 *
 *   IDENTITY_4200            field_4200 = field_4100 + field_4110 +
 *                            field_4120 + field_4130 + field_4140 +
 *                            field_4150 + field_4155 + field_4160 +
 *                            field_4165 + field_4166 + field_4170
 *                            Form line 584: "Total assets (add lines 4100,
 *                            4110 to 4155, and 4160 to 4170)". Excludes:
 *                            — field_4101/4102 (sub-splits of 4100)
 *                            — field_4157/4158 (sub-splits of 4155)
 *                            — field_4180 (removed in v27)
 *                            — field_4190 (impact investments — Dictionary
 *                              line 249 describes this as "including those
 *                              reported in any other line"; memo cross-cut,
 *                              not additive)
 *                            SECTION-AWARE: fires ONLY for
 *                            section_used = '6' filings. Section D
 *                            simplified filers don't report the asset
 *                            breakdown — those lines don't exist on
 *                            their form. Running this rule across all
 *                            filings indiscriminately produced ~2.5M
 *                            spurious completeness rows (one per
 *                            Section D filing × 11 asset components).
 *                            STRICT: for Schedule 6 filings, fires
 *                            only when field_4200 AND all eleven
 *                            components are populated. NULL components
 *                            on Schedule 6 → completeness row.
 *                            Section D filings are skipped entirely.
 *
 *   IDENTITY_4350            field_4350 = field_4300 + field_4310 +
 *                            field_4320 + field_4330
 *                            Form line 572: "Total liabilities (add lines
 *                            4300 to 4330)". SECTION-AWARE: Schedule 6
 *                            only, same rationale as IDENTITY_4200.
 *                            STRICT: fires only when all five fields
 *                            populated on a section_used = '6' filing.
 *
 * CROSS-SCHEDULE EQUALITIES
 *
 *   COMP_4880_EQ_390         field_4880 (Schedule 6) = field_390 (Schedule 3)
 *                            Form line 631. Only fires when both are
 *                            populated.
 *
 *   DQ_845_EQ_5000           Schedule 8 line 845 = field_5000 (Schedule 6)
 *                            Dictionary line 1023: "Must be pre-populated
 *                            with the amount from line 5000".
 *
 *   DQ_850_EQ_5045           Schedule 8 line 850 = field_5045 (Schedule 6)
 *                            Dictionary line 1024.
 *
 *   DQ_855_EQ_5050           Schedule 8 line 855 = field_5050 (Schedule 6)
 *                            Dictionary line 1025.
 *
 * SCHEDULE DEPENDENCIES
 *
 *   SCH3_DEP_FORWARD         field_3400 (C9) = TRUE → Schedule 3 row
 *                            must exist. Form line 133.
 *
 *   SCH3_DEP_REVERSE         Schedule 3 row exists → field_3400 must
 *                            = TRUE. Form line 467.
 *
 * ─── RULES EXPLICITLY RETIRED IN THIS VERSION ───────────────────────────
 *
 *   I1_COMPONENT_EXCEEDS_PARENT / gifts_gt_total_exp  (was: flag when
 *       field_5050 > field_5100).  The rationale given was "5050 is a
 *       component of 5100 by T3010 definition". The form text at line
 *       657 says 5100 is the SUM of 4950, 5045, and 5050. 5050 is an
 *       addend, not a partitioned component. When field_4950 is
 *       reported as negative (permitted by the form), 5050 > 5100 is
 *       an arithmetic necessity, not an impossibility. Validation of
 *       the first 100 flagged rows found:
 *         — 70% of flags are actually NULL-5100 (completeness, not math)
 *         — 11 of the 25 non-NULL rows pass the 5100 identity exactly
 *           (they just have negative 4950, which is legal)
 *         — Only ~14 of 100 are real violations, and all of those
 *           are already caught by IDENTITY_5100.
 *       The rule is therefore subsumed by IDENTITY_5100 and is removed.
 *
 *   R1_MAGNITUDE_OUTLIER (was: flag money fields > $50B). This is a
 *       plausibility heuristic, not an arithmetic impossibility. A
 *       $222B filing is almost certainly a reporting error, but the
 *       form does not set an upper bound on any money field. This
 *       rule moves to cra.t3010_plausibility_flags.
 *
 *   R2_RECONCILIATION_FAILURE (was: 5100 ≠ 4950 + 5045 + 5050 with
 *       NULL-as-zero). This is identical in intent to IDENTITY_5100
 *       but used the old COALESCE(..., 0) approach that misclassified
 *       missing-data filings as identity violations. Subsumed by the
 *       stricter IDENTITY_5100 below, with the NULL addend cases now
 *       routed to t3010_completeness_issues.
 *
 * Outputs:
 *   cra.t3010_impossibilities
 *   cra.t3010_completeness_issues
 *   cra.t3010_plausibility_flags
 *   data/reports/data-quality/t3010-arithmetic-impossibilities.{json,md}
 *
 * Usage:
 *   npm run data-quality:arithmetic
 *   node scripts/data-quality/02-t3010-arithmetic-impossibilities.js
 *   node scripts/data-quality/02-t3010-arithmetic-impossibilities.js --top 40
 */

const fs = require('fs');
const path = require('path');
const db = require('../../lib/db');
const log = require('../../lib/logger');

function parseArgs() {
  const args = { top: 20 };
  for (let i = 2; i < process.argv.length; i++) {
    const a = process.argv[i];
    const next = process.argv[i + 1];
    if (a === '--top' && next) { args.top = parseInt(next, 10) || args.top; i++; }
  }
  return args;
}
const args = parseArgs();
const REPORT_DIR = path.join(__dirname, '..', '..', 'data', 'reports', 'data-quality');

const TOLERANCE = 1;                              // dollars — rounding-only differences below this are not flagged
const PLAUSIBILITY_MONEY_CEILING = 10_000_000_000; // $10B — absolute magnitude ceiling
const PLAUSIBILITY_EXP_REV_RATIO = 100;            // flag when field_5100 / field_4700 exceeds this

// ─── Identity rule sub-rule controls ────────────────────────────────────────
//
// The three identity rules (IDENTITY_5100, IDENTITY_4200, IDENTITY_4350)
// can fire on three distinct failure modes. Each is controlled by a
// boolean flag so they can be toggled independently as the dataset's
// characteristics are explored.
//
// RECONCILIATION FAILURE (always on; the real target)
//   LHS is non-zero AND at least one addend is non-zero AND the math
//   doesn't reconcile. Example: field_5100 = $5296, field_4950 = $3596,
//   others NULL → component sum is $3596, mismatch is $1700. Both
//   sides were populated with real values; they don't add up.
//
// MISSING TOTAL (off)
//   LHS is 0 or NULL AND at least one addend is non-zero. Example:
//   field_5100 = NULL, field_4950 = $325480. The charity reported
//   component data but didn't report the grand total. Clerical —
//   CRA accepts this pattern routinely.
//
// EMPTY BREAKDOWN (off)
//   LHS is non-zero AND every addend is NULL or 0. Example: field_5100
//   = $3963 but 4950/5045/5050 all NULL. The charity reported a total
//   without any component breakdown. Clerical — the form's "all
//   relevant fields must be filled out" instruction means blank =
//   not applicable, and CRA accepts these.
//
// To re-audit either disabled mode, flip the flag to `true` and
// re-run. No other changes needed; the rule SQL respects these flags.
const IDENTITY_FLAG_RECONCILIATION_FAILURE = true;
const IDENTITY_FLAG_MISSING_TOTAL          = false;
const IDENTITY_FLAG_EMPTY_BREAKDOWN        = false;

// Emit an info line so each run's log records which sub-rules fired.
function logIdentityFlagState() {
  log.info('    Identity sub-rule flags:');
  log.info(`      RECONCILIATION_FAILURE: ${IDENTITY_FLAG_RECONCILIATION_FAILURE ? 'ON' : 'off'}`);
  log.info(`      MISSING_TOTAL:          ${IDENTITY_FLAG_MISSING_TOTAL ? 'ON' : 'off'}`);
  log.info(`      EMPTY_BREAKDOWN:        ${IDENTITY_FLAG_EMPTY_BREAKDOWN ? 'ON' : 'off'}`);
}

// Build the WHERE-clause fragment that encodes which sub-rule modes are
// currently active, given:
//   lhsExpr       — SQL expression for the identity's LHS (total),
//                   e.g. "COALESCE(fd.field_5100, 0)"
//   sumExpr       — SQL expression for the SUM of addends, with NULLs
//                   coalesced to 0, e.g. "COALESCE(fd.field_4950,0) + ..."
//   addendNonZero — SQL expression that's TRUE when at least one addend
//                   is non-zero, e.g. "COALESCE(fd.field_4950,0) <> 0 OR ..."
//   tolParam      — 1-based parameter index for TOLERANCE, e.g. "$1"
//
// Returns a string that evaluates to TRUE for rows the identity rule
// should flag, or 'FALSE' if all three flags are off (so the query
// correctly returns zero rows without blowing up).
function buildIdentityPredicate(lhsExpr, sumExpr, addendNonZero, tolParam) {
  const clauses = [];
  if (IDENTITY_FLAG_RECONCILIATION_FAILURE) {
    // LHS non-zero AND at least one addend non-zero AND math fails
    clauses.push(
      `(${lhsExpr} <> 0 AND (${addendNonZero}) AND ABS(${lhsExpr} - (${sumExpr})) > ${tolParam})`
    );
  }
  if (IDENTITY_FLAG_MISSING_TOTAL) {
    // LHS is zero/NULL AND at least one addend is non-zero
    clauses.push(
      `(${lhsExpr} = 0 AND (${addendNonZero}))`
    );
  }
  if (IDENTITY_FLAG_EMPTY_BREAKDOWN) {
    // LHS non-zero AND every addend is zero/NULL (i.e. addendNonZero is false)
    clauses.push(
      `(${lhsExpr} <> 0 AND NOT (${addendNonZero}))`
    );
  }
  if (clauses.length === 0) return 'FALSE';
  return '(' + clauses.join(' OR ') + ')';
}

// ─── Phase 1: migration ──────────────────────────────────────────────────────

async function migrate(client) {
  log.info('Phase 1: Creating the three output tables...');

  await client.query(`
    DROP TABLE IF EXISTS cra.t3010_impossibilities        CASCADE;
    DROP TABLE IF EXISTS cra.t3010_completeness_issues    CASCADE;
    DROP TABLE IF EXISTS cra.t3010_plausibility_flags     CASCADE;

    -- Legacy table; drop so downstream consumers must migrate to the
    -- three new tables and can't accidentally read stale results.
    DROP TABLE IF EXISTS cra.t3010_arithmetic_violations  CASCADE;

    CREATE TABLE cra.t3010_impossibilities (
      bn            varchar(15) NOT NULL,
      fpe           date        NOT NULL,
      fiscal_year   int         NOT NULL,
      legal_name    text,
      rule_code     text        NOT NULL,
      rule_family   text        NOT NULL,   -- EXPENDITURE | BALANCE_SHEET | CROSS_SCHEDULE | DEPENDENCY
      details       text,
      severity      numeric,
      PRIMARY KEY (bn, fpe, rule_code)
    );
    CREATE INDEX idx_imp_rule     ON cra.t3010_impossibilities (rule_code);
    CREATE INDEX idx_imp_family   ON cra.t3010_impossibilities (rule_family);
    CREATE INDEX idx_imp_year     ON cra.t3010_impossibilities (fiscal_year);
    CREATE INDEX idx_imp_severity ON cra.t3010_impossibilities (severity DESC);

    CREATE TABLE cra.t3010_completeness_issues (
      bn            varchar(15) NOT NULL,
      fpe           date        NOT NULL,
      fiscal_year   int         NOT NULL,
      legal_name    text,
      rule_code     text        NOT NULL,   -- reserved for future completeness rules (currently unused; all identity rules live in t3010_impossibilities)
      missing_field text        NOT NULL,   -- e.g. 'field_4950' or 'field_5100'
      context_rule  text        NOT NULL,   -- which identity could not be verified
      details       text,
      PRIMARY KEY (bn, fpe, rule_code, missing_field)
    );
    CREATE INDEX idx_comp_rule  ON cra.t3010_completeness_issues (rule_code);
    CREATE INDEX idx_comp_field ON cra.t3010_completeness_issues (missing_field);
    CREATE INDEX idx_comp_year  ON cra.t3010_completeness_issues (fiscal_year);

    CREATE TABLE cra.t3010_plausibility_flags (
      bn              varchar(15) NOT NULL,
      fpe             date        NOT NULL,
      fiscal_year     int         NOT NULL,
      legal_name      text,
      rule_code       text        NOT NULL,
      offending_field text        NOT NULL,   -- which specific field tripped the flag
      details         text,
      severity        numeric,
      PRIMARY KEY (bn, fpe, rule_code, offending_field)
    );
    CREATE INDEX idx_plaus_rule  ON cra.t3010_plausibility_flags (rule_code);
    CREATE INDEX idx_plaus_year  ON cra.t3010_plausibility_flags (fiscal_year);
    CREATE INDEX idx_plaus_field ON cra.t3010_plausibility_flags (offending_field);
  `);
}

// ─── Phase 2: run every rule, writing to the correct table per rule ──────────

async function runChecks(client) {
  log.info('\nPhase 2: Running strict identity / consistency / dependency checks...');

  const joinId = `
    LEFT JOIN cra.cra_identification ci
      ON ci.bn = fd.bn AND ci.fiscal_year = EXTRACT(YEAR FROM fd.fpe)::int
  `;

  // ─── IDENTITY_5100 ────────────────────────────────────────────────────────
  //
  // Form line 657 (Schedule 6): "Total expenditures (add lines 4950, 5045
  // and 5050) — 5100". Same identity at line 281 (Section D). Applies to
  // both sections regardless of form_id.
  //
  // Treats NULL as 0 in arithmetic. Which failure modes fire is controlled
  // by the IDENTITY_FLAG_* constants at the top of the file:
  //
  //   RECONCILIATION_FAILURE (default ON): LHS non-zero AND at least one
  //     addend non-zero AND |LHS - sum| > tolerance. This is the real
  //     signal — both sides have real values and they don't add up.
  //     Example: 5100 = $5,296, 4950 = $3,596 → mismatch of $1,700.
  //
  //   MISSING_TOTAL (default off): LHS = 0 or NULL AND at least one
  //     addend non-zero. Example: 5100 = NULL, 4950 = $325,480.
  //     Clerical — the charity reported component data but not the
  //     grand total.
  //
  //   EMPTY_BREAKDOWN (default off): LHS non-zero AND every addend is
  //     0 or NULL. Example: 5100 = $3,963, 4950/5045/5050 all NULL.
  //     Clerical — total reported with no breakdown.
  logIdentityFlagState();
  {
    const lhsExpr = 'COALESCE(fd.field_5100, 0)';
    const sumExpr = 'COALESCE(fd.field_4950, 0) + COALESCE(fd.field_5045, 0) + COALESCE(fd.field_5050, 0)';
    const addendNonZero = 'COALESCE(fd.field_4950, 0) <> 0 OR COALESCE(fd.field_5045, 0) <> 0 OR COALESCE(fd.field_5050, 0) <> 0';
    const predicate = buildIdentityPredicate(lhsExpr, sumExpr, addendNonZero, '$1');

    await client.query(`
      INSERT INTO cra.t3010_impossibilities
        (bn, fpe, fiscal_year, legal_name, rule_code, rule_family, details, severity)
      SELECT
        fd.bn, fd.fpe, EXTRACT(YEAR FROM fd.fpe)::int, ci.legal_name,
        'IDENTITY_5100', 'EXPENDITURE',
        'field_5100 = ' || COALESCE('$' || ROUND(fd.field_5100)::text, 'NULL') ||
          ' but field_4950 = ' || COALESCE('$' || ROUND(fd.field_4950)::text, 'NULL') ||
          ', field_5045 = ' || COALESCE('$' || ROUND(fd.field_5045)::text, 'NULL') ||
          ', field_5050 = ' || COALESCE('$' || ROUND(fd.field_5050)::text, 'NULL') ||
          '; component sum (treating NULL as 0) = $' || ROUND(${sumExpr})::text ||
          ', mismatch of $' || ROUND(ABS(${lhsExpr} - (${sumExpr})))::text ||
          '. Form line 657: "Total expenditures (add lines 4950, 5045 and 5050)"',
        ABS(${lhsExpr} - (${sumExpr}))
      FROM cra.cra_financial_details fd ${joinId}
      WHERE ${predicate}
      ON CONFLICT DO NOTHING
    `, [TOLERANCE]);
  }

  // ─── PARTITION_4950 ───────────────────────────────────────────────────────
  //
  // Form line 644: "Of the amounts at lines 4950: (a) 5000 (b) 5010
  // (c) 5020 (d) 5040". One-sided — only over-partitions are mathematically
  // impossible. Under-partitions could be legitimate (version differences,
  // blank optional lines).
  //
  // STRICT: fires only when 4950 is populated AND at least one of
  // 5000/5010/5020/5040 is populated. NULL components on a populated
  // 4950 are not over-partitions; they're just blanks.

  await client.query(`
    INSERT INTO cra.t3010_impossibilities
      (bn, fpe, fiscal_year, legal_name, rule_code, rule_family, details, severity)
    SELECT
      fd.bn, fd.fpe, EXTRACT(YEAR FROM fd.fpe)::int, ci.legal_name,
      'PARTITION_4950', 'EXPENDITURE',
      'field_5000 ($' || COALESCE(ROUND(fd.field_5000)::text, '0') ||
        ') + field_5010 ($' || COALESCE(ROUND(fd.field_5010)::text, '0') ||
        ') + field_5020 ($' || COALESCE(ROUND(fd.field_5020)::text, '0') ||
        ') + field_5040 ($' || COALESCE(ROUND(fd.field_5040)::text, '0') ||
        ') = $' ||
        ROUND(COALESCE(fd.field_5000,0)+COALESCE(fd.field_5010,0)+COALESCE(fd.field_5020,0)+COALESCE(fd.field_5040,0))::text ||
        ' exceeds field_4950 = $' || ROUND(fd.field_4950)::text ||
        '. Form line 644: "Of the amounts at lines 4950"',
      (COALESCE(fd.field_5000,0)+COALESCE(fd.field_5010,0)+COALESCE(fd.field_5020,0)+COALESCE(fd.field_5040,0))
        - fd.field_4950
    FROM cra.cra_financial_details fd ${joinId}
    WHERE fd.field_4950 IS NOT NULL
      AND (fd.field_5000 IS NOT NULL OR fd.field_5010 IS NOT NULL OR fd.field_5020 IS NOT NULL OR fd.field_5040 IS NOT NULL)
      AND (COALESCE(fd.field_5000,0)+COALESCE(fd.field_5010,0)+COALESCE(fd.field_5020,0)+COALESCE(fd.field_5040,0))
          > fd.field_4950 + $1
    ON CONFLICT DO NOTHING
  `, [TOLERANCE]);

  // ─── IDENTITY_4200 (total assets) ─────────────────────────────────────────
  //
  // Form line 584: "Total assets (add lines 4100, 4110 to 4155, and
  // 4160 to 4170)". Strict reading:
  //   4200 = 4100 + 4110 + 4120 + 4130 + 4140 + 4150 + 4155
  //               + 4160 + 4165 + 4166 + 4170
  // Excluded: 4101/4102 (sub-splits of 4100); 4157/4158 (sub-splits of 4155);
  //           4180 (removed v27); 4190 (impact investments, a memo
  //           cross-cut per Dictionary line 249).
  //
  // SECTION-AWARE: fires ONLY for section_used = '6' filings.
  // Section D simplified filers (revenue < $100K) report only the
  // 4200 total, not the component breakdown — demanding those
  // components on a Section D filing is nonsensical and was the
  // main source of millions of spurious completeness rows. Per
  // Dictionary section 3.7 line 592: "Section Used: D=Section D,
  // 6=Schedule 6".
  //
  // STRICT: for section_used = '6' filings, fires only when
  // field_4200 AND all eleven component fields are populated.
  // If any component is NULL on a Schedule 6 filing, that's a
  // completeness issue (the Schedule 6 form does ask for that
  // component). Section D filings are skipped entirely by this
  // rule — no impossibility, no completeness row.
  //
  // NOTE on field_4166 (accumulated amortization): this is a contra-
  // asset in accounting, but the form literally says "add" for lines
  // 4160 to 4170, and 4166 is in that range. We take the form text
  // at face value. Filings where the filer reported 4166 as a
  // positive magnitude expecting CRA to subtract it will trigger this
  // rule — that's a real data inconsistency with the form's stated
  // arithmetic, not a script bug.

  const ASSET_COMPONENTS = [
    '4100','4110','4120','4130','4140','4150',
    '4155','4160','4165','4166','4170'
  ];
  const assetSumSql = ASSET_COMPONENTS.map(c => `COALESCE(fd.field_${c}, 0)`).join(' + ');
  const assetAnyNonZero = ASSET_COMPONENTS.map(c => `COALESCE(fd.field_${c}, 0) <> 0`).join(' OR ');
  const assetDetailSql = ASSET_COMPONENTS.map(c => `'${c}=' || COALESCE('$' || ROUND(fd.field_${c})::text, 'NULL')`).join(` || ', ' || `);

  // Schedule 6 only. Which failure modes fire is controlled by
  // IDENTITY_FLAG_* at the top of the file; see IDENTITY_5100 for
  // the full explanation of each mode.
  {
    const lhsExpr = 'COALESCE(fd.field_4200, 0)';
    const predicate = buildIdentityPredicate(lhsExpr, assetSumSql, assetAnyNonZero, '$1');
    await client.query(`
      INSERT INTO cra.t3010_impossibilities
        (bn, fpe, fiscal_year, legal_name, rule_code, rule_family, details, severity)
      SELECT
        fd.bn, fd.fpe, EXTRACT(YEAR FROM fd.fpe)::int, ci.legal_name,
        'IDENTITY_4200', 'BALANCE_SHEET',
        'Schedule 6 filing: field_4200 (total assets) = ' ||
          COALESCE('$' || ROUND(fd.field_4200)::text, 'NULL') ||
          ' but component sum (treating NULL as 0) = $' || ROUND(${assetSumSql})::text ||
          ' (' || ${assetDetailSql} || '). Mismatch of $' ||
          ROUND(ABS(${lhsExpr} - (${assetSumSql})))::text ||
          '. Form line 584: "Total assets (add lines 4100, 4110 to 4155, and 4160 to 4170)"',
        ABS(${lhsExpr} - (${assetSumSql}))
      FROM cra.cra_financial_details fd ${joinId}
      WHERE fd.section_used = '6'
        AND ${predicate}
      ON CONFLICT DO NOTHING
    `, [TOLERANCE]);
  }

  // ─── IDENTITY_4350 (total liabilities) ────────────────────────────────────
  //
  // Form line 572: "Total liabilities (add lines 4300 to 4330)".
  // SECTION-AWARE: Schedule 6 only. Same unified NULL-as-0 approach
  // as IDENTITY_4200 and IDENTITY_5100.

  const LIAB_COMPONENTS = ['4300','4310','4320','4330'];
  const liabSumSql = LIAB_COMPONENTS.map(c => `COALESCE(fd.field_${c}, 0)`).join(' + ');
  const liabAnyNonZero = LIAB_COMPONENTS.map(c => `COALESCE(fd.field_${c}, 0) <> 0`).join(' OR ');
  const liabDetailSql = LIAB_COMPONENTS.map(c => `'${c}=' || COALESCE('$' || ROUND(fd.field_${c})::text, 'NULL')`).join(` || ', ' || `);

  // Schedule 6 only. Which failure modes fire is controlled by
  // IDENTITY_FLAG_* at the top of the file; see IDENTITY_5100 for
  // the full explanation of each mode.
  {
    const lhsExpr = 'COALESCE(fd.field_4350, 0)';
    const predicate = buildIdentityPredicate(lhsExpr, liabSumSql, liabAnyNonZero, '$1');
    await client.query(`
      INSERT INTO cra.t3010_impossibilities
        (bn, fpe, fiscal_year, legal_name, rule_code, rule_family, details, severity)
      SELECT
        fd.bn, fd.fpe, EXTRACT(YEAR FROM fd.fpe)::int, ci.legal_name,
        'IDENTITY_4350', 'BALANCE_SHEET',
        'Schedule 6 filing: field_4350 (total liabilities) = ' ||
          COALESCE('$' || ROUND(fd.field_4350)::text, 'NULL') ||
          ' but component sum (treating NULL as 0) = $' || ROUND(${liabSumSql})::text ||
          ' (' || ${liabDetailSql} || '). Mismatch of $' ||
          ROUND(ABS(${lhsExpr} - (${liabSumSql})))::text ||
          '. Form line 572: "Total liabilities (add lines 4300 to 4330)"',
        ABS(${lhsExpr} - (${liabSumSql}))
      FROM cra.cra_financial_details fd ${joinId}
      WHERE fd.section_used = '6'
        AND ${predicate}
      ON CONFLICT DO NOTHING
    `, [TOLERANCE]);
  }

  // ─── CROSS-SCHEDULE EQUALITIES ─────────────────────────────────────────────

  // COMP_4880_EQ_390 — strict (both sides populated)
  await client.query(`
    INSERT INTO cra.t3010_impossibilities
      (bn, fpe, fiscal_year, legal_name, rule_code, rule_family, details, severity)
    SELECT
      fd.bn, fd.fpe, EXTRACT(YEAR FROM fd.fpe)::int, ci.legal_name,
      'COMP_4880_EQ_390', 'CROSS_SCHEDULE',
      'Schedule 6 field_4880 = $' || ROUND(fd.field_4880)::text ||
        ' but Schedule 3 field_390 = $' || ROUND(cc.field_390)::text ||
        '. Form line 631: "enter the amount reported at line 390 in Schedule 3"',
      ABS(fd.field_4880 - cc.field_390)
    FROM cra.cra_financial_details fd
    JOIN cra.cra_compensation cc ON cc.bn = fd.bn AND cc.fpe = fd.fpe
    ${joinId}
    WHERE fd.field_4880 IS NOT NULL AND cc.field_390 IS NOT NULL
      AND ABS(fd.field_4880 - cc.field_390) > $1
    ON CONFLICT DO NOTHING
  `, [TOLERANCE]);

  // DQ_845_EQ_5000
  await client.query(`
    INSERT INTO cra.t3010_impossibilities
      (bn, fpe, fiscal_year, legal_name, rule_code, rule_family, details, severity)
    SELECT
      fd.bn, fd.fpe, EXTRACT(YEAR FROM fd.fpe)::int, ci.legal_name,
      'DQ_845_EQ_5000', 'CROSS_SCHEDULE',
      'Schedule 8 line 845 = $' || ROUND(dq.field_845)::text ||
        ' but field_5000 (Schedule 6) = $' || ROUND(fd.field_5000)::text ||
        '. Dictionary line 1023: line 845 "must be pre-populated with the amount from line 5000"',
      ABS(dq.field_845 - fd.field_5000)
    FROM cra.cra_disbursement_quota dq
    JOIN cra.cra_financial_details fd ON dq.bn = fd.bn AND dq.fpe = fd.fpe
    ${joinId}
    WHERE dq.field_845 IS NOT NULL AND fd.field_5000 IS NOT NULL
      AND ABS(dq.field_845 - fd.field_5000) > $1
    ON CONFLICT DO NOTHING
  `, [TOLERANCE]);

  // DQ_850_EQ_5045
  await client.query(`
    INSERT INTO cra.t3010_impossibilities
      (bn, fpe, fiscal_year, legal_name, rule_code, rule_family, details, severity)
    SELECT
      fd.bn, fd.fpe, EXTRACT(YEAR FROM fd.fpe)::int, ci.legal_name,
      'DQ_850_EQ_5045', 'CROSS_SCHEDULE',
      'Schedule 8 line 850 = $' || ROUND(dq.field_850)::text ||
        ' but field_5045 (Schedule 6) = $' || ROUND(fd.field_5045)::text ||
        '. Dictionary line 1024: line 850 "must be pre-populated with the amount from line 5045"',
      ABS(dq.field_850 - fd.field_5045)
    FROM cra.cra_disbursement_quota dq
    JOIN cra.cra_financial_details fd ON dq.bn = fd.bn AND dq.fpe = fd.fpe
    ${joinId}
    WHERE dq.field_850 IS NOT NULL AND fd.field_5045 IS NOT NULL
      AND ABS(dq.field_850 - fd.field_5045) > $1
    ON CONFLICT DO NOTHING
  `, [TOLERANCE]);

  // DQ_855_EQ_5050
  await client.query(`
    INSERT INTO cra.t3010_impossibilities
      (bn, fpe, fiscal_year, legal_name, rule_code, rule_family, details, severity)
    SELECT
      fd.bn, fd.fpe, EXTRACT(YEAR FROM fd.fpe)::int, ci.legal_name,
      'DQ_855_EQ_5050', 'CROSS_SCHEDULE',
      'Schedule 8 line 855 = $' || ROUND(dq.field_855)::text ||
        ' but field_5050 (Schedule 6) = $' || ROUND(fd.field_5050)::text ||
        '. Dictionary line 1025: line 855 "must be pre-populated with the amount from line 5050"',
      ABS(dq.field_855 - fd.field_5050)
    FROM cra.cra_disbursement_quota dq
    JOIN cra.cra_financial_details fd ON dq.bn = fd.bn AND dq.fpe = fd.fpe
    ${joinId}
    WHERE dq.field_855 IS NOT NULL AND fd.field_5050 IS NOT NULL
      AND ABS(dq.field_855 - fd.field_5050) > $1
    ON CONFLICT DO NOTHING
  `, [TOLERANCE]);

  // ─── SCHEDULE DEPENDENCIES ────────────────────────────────────────────────

  // SCH3_DEP_FORWARD — C9 = TRUE but no Schedule 3 row exists
  await client.query(`
    INSERT INTO cra.t3010_impossibilities
      (bn, fpe, fiscal_year, legal_name, rule_code, rule_family, details, severity)
    SELECT
      g.bn, g.fpe, EXTRACT(YEAR FROM g.fpe)::int, ci.legal_name,
      'SCH3_DEP_FORWARD', 'DEPENDENCY',
      'field_3400 (C9) = TRUE but no Schedule 3 row exists for this (bn,fpe). ' ||
      'Form line 133: "Did the charity incur any expenses for compensation ' ||
      'of employees? ... If yes, you must complete Schedule 3"',
      1
    FROM cra.cra_financial_general g
    LEFT JOIN cra.cra_compensation cc ON cc.bn = g.bn AND cc.fpe = g.fpe
    LEFT JOIN cra.cra_identification ci
      ON ci.bn = g.bn AND ci.fiscal_year = EXTRACT(YEAR FROM g.fpe)::int
    WHERE g.field_3400 = TRUE AND cc.bn IS NULL
    ON CONFLICT DO NOTHING
  `);

  // SCH3_DEP_REVERSE — Schedule 3 row exists but C9 ≠ TRUE
  await client.query(`
    INSERT INTO cra.t3010_impossibilities
      (bn, fpe, fiscal_year, legal_name, rule_code, rule_family, details, severity)
    SELECT
      cc.bn, cc.fpe, EXTRACT(YEAR FROM cc.fpe)::int, ci.legal_name,
      'SCH3_DEP_REVERSE', 'DEPENDENCY',
      'Schedule 3 row exists but field_3400 (C9) = FALSE or NULL. ' ||
      'Form line 467: "If you complete this section, you must answer yes to question C9"',
      COALESCE(cc.field_390, 0)
    FROM cra.cra_compensation cc
    JOIN cra.cra_financial_general g ON g.bn = cc.bn AND g.fpe = cc.fpe
    LEFT JOIN cra.cra_identification ci
      ON ci.bn = cc.bn AND ci.fiscal_year = EXTRACT(YEAR FROM cc.fpe)::int
    WHERE (g.field_3400 IS NULL OR g.field_3400 = FALSE)
    ON CONFLICT DO NOTHING
  `);

  // ─── PLAUSIBILITY (separate table — not an impossibility) ─────────────────
  //
  // The plausibility layer surfaces filings that are legal per the form
  // text but numerically strange enough to warrant a human look. Three
  // rules, each targeting a different failure mode:
  //
  // PLAUS_MAGNITUDE_OUTLIER — money field exceeds the absolute ceiling
  //   ($10B). Catches obvious unit errors (reporting in cents, adding
  //   extra zeros) but would otherwise over-flag legitimate very-large
  //   foundations (Mastercard Foundation's $55B+ long-term investments
  //   is a real value, not an error).
  //   FOUNDATION EXCLUSION: this rule SKIPS filings where designation
  //   is 'A' (Public Foundation) or 'B' (Private Foundation). The
  //   rationale is that the ~50 largest foundations in Canada have
  //   legitimate single-line items in the tens of billions — they hold
  //   long-term investment portfolios that dwarf a typical charity's
  //   total assets. For charitable organizations (designation 'C'),
  //   a $10B+ money field is almost always a unit error.
  //
  // PLAUS_EXP_FAR_EXCEEDS_REV — field_5100 > field_4700 * 100.
  //   A charity spending more than 100× its revenue in a single fiscal
  //   year usually indicates a unit error somewhere in the expenditure
  //   tree. But foundations drawing down endowment can legitimately
  //   spend many multiples of their reported revenue — a private
  //   foundation with $500M assets, $1M of investment income in a
  //   bad market year, and $30M in annual grants has a 30× ratio that
  //   could easily cross 100× in a zero-income year or a wind-down.
  //   FOUNDATION EXCLUSION: same — skip designations 'A' and 'B'.
  //   Charitable organizations (designation 'C') don't have endowment
  //   spenddown as a normal pattern, so the 100× ratio remains a
  //   strong unit-error signal for them.
  //
  // PLAUS_COMP_EXCEEDS_TOTAL_EXP — field_4880 (compensation) > field_5100
  //   (total expenditures). Since 4880 is mathematically a component of
  //   5100 (appearing in the 4800-4920 ledger that forms 4950), comp
  //   exceeding total expenditures is a unit or sign error regardless
  //   of charity type. NO FOUNDATION EXCLUSION — this rule fires for
  //   all designations, because there is no legitimate reason for any
  //   charity, foundation or otherwise, to report compensation greater
  //   than total expenditures.

  const BIG_MONEY_FIELDS = [
    '4100','4110','4120','4130','4140','4150','4155','4160','4165','4166','4170','4200',
    '4300','4310','4320','4330','4350',
    '4500','4510','4540','4550','4560','4570','4700',
    '4800','4810','4820','4830','4840','4850','4860','4870','4880','4890','4891',
    '4900','4910','4920','4950',
    '5000','5010','5020','5040','5045','5050','5100'
  ];

  // Foundation-exclusion clause used in rules 1 and 2. Filings whose
  // designation is 'A' (Public Foundation) or 'B' (Private Foundation)
  // are skipped. Filings where the designation is NULL (missing from
  // cra_identification) are INCLUDED — we don't silently drop them.
  // Filings where designation = 'C' (Charitable Organization) are
  // included. This is the inverse of "exclude foundations":
  //   NOT (designation IN ('A','B'))  ==  designation IS NULL OR designation NOT IN ('A','B')
  const notFoundation = `(ci.designation IS NULL OR ci.designation NOT IN ('A', 'B'))`;

  // Rule 1: absolute magnitude (foundation-excluded)
  for (const f of BIG_MONEY_FIELDS) {
    await client.query(`
      INSERT INTO cra.t3010_plausibility_flags
        (bn, fpe, fiscal_year, legal_name, rule_code, offending_field, details, severity)
      SELECT
        fd.bn, fd.fpe, EXTRACT(YEAR FROM fd.fpe)::int, ci.legal_name,
        'PLAUS_MAGNITUDE_OUTLIER',
        'field_${f}',
        'field_${f} = $' || ROUND(fd.field_${f})::text ||
          ' exceeds editorial plausibility ceiling ($' ||
          ROUND(${PLAUSIBILITY_MONEY_CEILING})::text ||
          '). Not an impossibility — the form imposes no upper bound — but ' ||
          'very likely a units error (reporting cents as dollars, etc.). ' ||
          'Foundations (designation A/B) are excluded from this rule; ' ||
          'this filing is designation ' || COALESCE(ci.designation, 'NULL') || '.',
        ABS(fd.field_${f})
      FROM cra.cra_financial_details fd ${joinId}
      WHERE fd.field_${f} IS NOT NULL
        AND ABS(fd.field_${f}) > ${PLAUSIBILITY_MONEY_CEILING}
        AND ${notFoundation}
      ON CONFLICT DO NOTHING
    `);
  }

  // Rule 2: total expenditures runaway vs. revenue (foundation-excluded)
  //
  // Uses offending_field = 'field_5100' since 5100 is the field
  // whose magnitude is suspicious relative to the yardstick (4700).
  // Only fires when 4700 > 0 (can't divide by zero or flag charities
  // with legitimate zero revenue in a given year).
  await client.query(`
    INSERT INTO cra.t3010_plausibility_flags
      (bn, fpe, fiscal_year, legal_name, rule_code, offending_field, details, severity)
    SELECT
      fd.bn, fd.fpe, EXTRACT(YEAR FROM fd.fpe)::int, ci.legal_name,
      'PLAUS_EXP_FAR_EXCEEDS_REV',
      'field_5100',
      'field_5100 (total expenditures, $' || ROUND(fd.field_5100)::text ||
        ') exceeds field_4700 (total revenue, $' || ROUND(fd.field_4700)::text ||
        ') by a factor of ' ||
        ROUND((fd.field_5100::numeric / NULLIF(fd.field_4700, 0))::numeric, 1)::text ||
        '× — threshold is ${PLAUSIBILITY_EXP_REV_RATIO}×. Foundations (designation ' ||
        'A/B) are excluded because endowment spenddown can legitimately produce ' ||
        'extreme ratios; this filing is designation ' || COALESCE(ci.designation, 'NULL') || '.',
      fd.field_5100
    FROM cra.cra_financial_details fd ${joinId}
    WHERE fd.field_5100 IS NOT NULL
      AND fd.field_4700 IS NOT NULL
      AND fd.field_4700 > 0
      AND fd.field_5100 > fd.field_4700 * ${PLAUSIBILITY_EXP_REV_RATIO}
      AND ${notFoundation}
    ON CONFLICT DO NOTHING
  `);

  // Rule 3: compensation (4880) exceeds total expenditures (5100).
  // NO FOUNDATION EXCLUSION — this rule applies to all designations.
  //
  // 4880 is part of the 4800-4920 expense ledger that sums to 4950,
  // and 5100 = 4950 + 5045 + 5050 ≥ 4950 ≥ 4880 (since 4880 is one
  // addend of 4950 and the others are non-negative in the usual case).
  // So 4880 > 5100 means either a sign error on a non-comp expense,
  // a unit error on 4880 specifically, or both. Small overruns
  // (< $100 or < 1%) can occur with rounding and are not flagged —
  // we require 4880 > 5100 * 1.01 AND the gap exceeds $100 to avoid
  // flagging rounding-scale noise.
  await client.query(`
    INSERT INTO cra.t3010_plausibility_flags
      (bn, fpe, fiscal_year, legal_name, rule_code, offending_field, details, severity)
    SELECT
      fd.bn, fd.fpe, EXTRACT(YEAR FROM fd.fpe)::int, ci.legal_name,
      'PLAUS_COMP_EXCEEDS_TOTAL_EXP',
      'field_4880',
      'field_4880 (compensation, $' || ROUND(fd.field_4880)::text ||
        ') exceeds field_5100 (total expenditures, $' || ROUND(fd.field_5100)::text ||
        ') by $' || ROUND(fd.field_4880 - fd.field_5100)::text ||
        '. Compensation should be a component of total expenditures ' ||
        '(it appears in the 4800-4920 ledger that sums to 4950, and ' ||
        '5100 = 4950 + 5045 + 5050). Overage suggests a unit or sign error.',
      fd.field_4880 - fd.field_5100
    FROM cra.cra_financial_details fd ${joinId}
    WHERE fd.field_4880 IS NOT NULL
      AND fd.field_5100 IS NOT NULL
      AND fd.field_5100 > 0
      AND fd.field_4880 > fd.field_5100 * 1.01
      AND fd.field_4880 - fd.field_5100 > 100
    ON CONFLICT DO NOTHING
  `);

  // ─── Summary log ─────────────────────────────────────────────────────────

  const impCounts = await client.query(`
    SELECT rule_code, rule_family,
           COUNT(*)::int           AS rows,
           COUNT(DISTINCT bn)::int AS bns
    FROM cra.t3010_impossibilities
    GROUP BY rule_code, rule_family
    ORDER BY rule_family, rule_code
  `);
  log.info('\n  Impossibilities by rule:');
  for (const r of impCounts.rows) {
    log.info(`    ${(r.rule_family + ' / ' + r.rule_code).padEnd(42)} ${String(r.rows).padStart(7)} rows   ${String(r.bns).padStart(7)} BNs`);
  }

  const compCounts = await client.query(`
    SELECT rule_code, context_rule,
           COUNT(*)::int           AS rows,
           COUNT(DISTINCT bn)::int AS bns
    FROM cra.t3010_completeness_issues
    GROUP BY rule_code, context_rule
    ORDER BY context_rule, rule_code
  `);
  log.info('\n  Completeness issues by rule:');
  for (const r of compCounts.rows) {
    log.info(`    ${(r.context_rule + ' / ' + r.rule_code).padEnd(42)} ${String(r.rows).padStart(7)} rows   ${String(r.bns).padStart(7)} BNs`);
  }

  const plausCounts = await client.query(`
    SELECT rule_code,
           COUNT(*)::int           AS rows,
           COUNT(DISTINCT bn)::int AS bns
    FROM cra.t3010_plausibility_flags
    GROUP BY rule_code
  `);
  log.info('\n  Plausibility flags by rule:');
  for (const r of plausCounts.rows) {
    log.info(`    ${r.rule_code.padEnd(42)} ${String(r.rows).padStart(7)} rows   ${String(r.bns).padStart(7)} BNs`);
  }
}

// ─── Phase 3: Reporting ──────────────────────────────────────────────────────

async function report(client) {
  log.info('\nPhase 3: Building report...');

  const scope = await client.query(`
    SELECT
      (SELECT COUNT(*)::int FROM cra.cra_financial_details)                                   AS total_filings,
      (SELECT COUNT(*)::int FROM cra.t3010_impossibilities)                                   AS total_impossibilities,
      (SELECT COUNT(DISTINCT bn)::int FROM cra.t3010_impossibilities)                         AS distinct_bns_imp,
      (SELECT COUNT(DISTINCT (bn, fpe))::int FROM cra.t3010_impossibilities)                  AS distinct_charity_years_imp,
      (SELECT COUNT(*)::int FROM cra.t3010_completeness_issues)                               AS total_completeness,
      (SELECT COUNT(DISTINCT bn)::int FROM cra.t3010_completeness_issues)                     AS distinct_bns_comp,
      (SELECT COUNT(*)::int FROM cra.t3010_plausibility_flags)                                AS total_plausibility,
      (SELECT COUNT(DISTINCT bn)::int FROM cra.t3010_plausibility_flags)                      AS distinct_bns_plaus
  `);

  const byRule = await client.query(`
    SELECT rule_family, rule_code,
           COUNT(*)::int              AS rows,
           COUNT(DISTINCT bn)::int    AS distinct_bns,
           SUM(severity)::numeric     AS sum_severity,
           MAX(severity)::numeric     AS max_severity
    FROM cra.t3010_impossibilities
    GROUP BY rule_family, rule_code ORDER BY rule_family, rule_code
  `);

  const byYear = await client.query(`
    SELECT fiscal_year, rule_code, COUNT(*)::int AS n
    FROM cra.t3010_impossibilities
    GROUP BY fiscal_year, rule_code
    ORDER BY fiscal_year, rule_code
  `);

  const topPerRule = {};
  for (const row of byRule.rows) {
    const r = await client.query(`
      SELECT bn, fiscal_year, legal_name, details, severity
      FROM cra.t3010_impossibilities
      WHERE rule_code = $1
      ORDER BY severity DESC NULLS LAST
      LIMIT $2
    `, [row.rule_code, args.top]);
    topPerRule[row.rule_code] = r.rows;
  }

  return { scope: scope.rows[0], byRule: byRule.rows, byYear: byYear.rows, topPerRule };
}

const $ = (n) => n === null || n === undefined ? '—' : '$' + Math.round(Number(n)).toLocaleString();

async function emit(r) {
  log.section('RESULTS');

  const s = r.scope;
  console.log('');
  console.log('── Scope');
  console.log(`  Financial filings scanned:                    ${Number(s.total_filings).toLocaleString()}`);
  console.log('');
  console.log(`  Impossibilities recorded:                     ${Number(s.total_impossibilities).toLocaleString()}`);
  console.log(`  Distinct BNs with ≥1 impossibility:           ${Number(s.distinct_bns_imp).toLocaleString()}`);
  console.log(`  Distinct charity-years with ≥1 impossibility: ${Number(s.distinct_charity_years_imp).toLocaleString()}`);
  console.log('');
  console.log(`  Completeness issues recorded:                 ${Number(s.total_completeness).toLocaleString()}`);
  console.log(`  Distinct BNs with ≥1 completeness issue:      ${Number(s.distinct_bns_comp).toLocaleString()}`);
  console.log('');
  console.log(`  Plausibility flags recorded:                  ${Number(s.total_plausibility).toLocaleString()}`);
  console.log(`  Distinct BNs with ≥1 plausibility flag:       ${Number(s.distinct_bns_plaus).toLocaleString()}`);

  console.log('');
  console.log('── Impossibilities by rule family and rule');
  let lastFamily = '';
  for (const row of r.byRule) {
    if (row.rule_family !== lastFamily) {
      console.log(`\n  ${row.rule_family}`);
      lastFamily = row.rule_family;
    }
    console.log(
      `    ${row.rule_code.padEnd(22)} ` +
      `${String(row.rows).padStart(6)} rows   ` +
      `${String(row.distinct_bns).padStart(6)} BNs   ` +
      `Σ sev ${$(row.sum_severity).padStart(15)}   ` +
      `max ${$(row.max_severity).padStart(12)}`
    );
  }

  for (const [rule, rows] of Object.entries(r.topPerRule)) {
    if (!rows.length) continue;
    console.log('');
    console.log(`── Top ${Math.min(args.top, rows.length)} violators of ${rule}`);
    for (const row of rows) {
      const name = (row.legal_name || '(not in identification)').slice(0, 50);
      console.log(`  ${row.bn}  FY ${row.fiscal_year}  ${name.padEnd(50)}  severity=${$(row.severity).padStart(14)}`);
      console.log(`    ${(row.details || '').slice(0, 240)}`);
    }
  }

  if (!fs.existsSync(REPORT_DIR)) fs.mkdirSync(REPORT_DIR, { recursive: true });
  fs.writeFileSync(path.join(REPORT_DIR, 't3010-arithmetic-impossibilities.json'),
    JSON.stringify({ generated_at: new Date().toISOString(), options: args, ...r }, null, 2));
  fs.writeFileSync(path.join(REPORT_DIR, 't3010-arithmetic-impossibilities.md'), buildMd(r));
  log.info('');
  log.info('  JSON: data/reports/data-quality/t3010-arithmetic-impossibilities.json');
  log.info('  MD:   data/reports/data-quality/t3010-arithmetic-impossibilities.md');
}

function buildMd(r) {
  const s = r.scope;

  const ruleTable = r.byRule.map(row =>
    `| ${row.rule_family} | ${row.rule_code} | ${Number(row.rows).toLocaleString()} | ${Number(row.distinct_bns).toLocaleString()} | ${$(row.sum_severity)} | ${$(row.max_severity)} |`
  ).join('\n');

  const years = Array.from(new Set(r.byYear.map(x => x.fiscal_year))).sort();
  const rules = r.byRule.map(x => x.rule_code);
  const map = new Map(r.byYear.map(x => [`${x.fiscal_year}_${x.rule_code}`, x.n]));
  let yearPivot = `| FY | ${rules.join(' | ')} | Total |\n|---|${rules.map(() => '---:').join('|')}|---:|\n`;
  for (const y of years) {
    const cells = rules.map(rc => map.get(`${y}_${rc}`) || 0);
    const total = cells.reduce((a, b) => a + b, 0);
    yearPivot += `| ${y} | ${cells.join(' | ')} | ${total} |\n`;
  }

  const ruleTitles = {
    IDENTITY_5100:    'IDENTITY_5100 — field_5100 ≠ field_4950 + field_5045 + field_5050 (all operands populated)',
    PARTITION_4950:   'PARTITION_4950 — field_5000 + field_5010 + field_5020 + field_5040 > field_4950',
    IDENTITY_4200:    'IDENTITY_4200 — field_4200 ≠ sum of asset lines 4100…4170 (all populated)',
    IDENTITY_4350:    'IDENTITY_4350 — field_4350 ≠ field_4300 + 4310 + 4320 + 4330 (all populated)',
    COMP_4880_EQ_390: 'COMP_4880_EQ_390 — Schedule 6 field_4880 ≠ Schedule 3 field_390',
    DQ_845_EQ_5000:   'DQ_845_EQ_5000 — Schedule 8 line 845 ≠ field_5000',
    DQ_850_EQ_5045:   'DQ_850_EQ_5045 — Schedule 8 line 850 ≠ field_5045',
    DQ_855_EQ_5050:   'DQ_855_EQ_5050 — Schedule 8 line 855 ≠ field_5050',
    SCH3_DEP_FORWARD: 'SCH3_DEP_FORWARD — field_3400 (C9) = TRUE but no Schedule 3 row',
    SCH3_DEP_REVERSE: 'SCH3_DEP_REVERSE — Schedule 3 row exists but field_3400 (C9) ≠ TRUE'
  };

  let topSections = '';
  for (const [rule, rows] of Object.entries(r.topPerRule)) {
    if (!rows.length) continue;
    topSections += `\n### ${ruleTitles[rule] || rule}\n\n`;
    topSections += '| BN | FY | Legal name | Severity | Supporting detail |\n|---|---:|---|---:|---|\n';
    for (const row of rows.slice(0, args.top)) {
      topSections += `| \`${row.bn}\` | ${row.fiscal_year} | ${(row.legal_name || '(not in identification)').replace(/\|/g, '/')} | ${$(row.severity)} | ${(row.details || '').replace(/\|/g, '/').replace(/\n/g, ' ').slice(0, 200)} |\n`;
    }
  }

  return `# CRA T3010 Strict Impossibility Audit

Generated: ${new Date().toISOString()}
Options: ${JSON.stringify(args)}

## Methodology: strict impossibility vs. completeness vs. plausibility

This audit separates three classes of data-quality signal into three
tables, because conflating them produces misleading results:

| Table | What it contains | What it means |
|---|---|---|
| \`cra.t3010_impossibilities\` | Arithmetic identities that fail with ALL operands populated; cross-schedule equalities where both sides populated but differ; schedule dependencies. | Filing is structurally inconsistent on its face. |
| \`cra.t3010_completeness_issues\` | Identities where one side is populated but an operand is NULL, so the identity cannot be verified. | Filing is incomplete — not necessarily wrong. |
| \`cra.t3010_plausibility_flags\` | Values that exceed editorial thresholds (e.g. money fields > \\$${PLAUSIBILITY_MONEY_CEILING.toLocaleString()}). | Not impossible, but very likely a units error. |

Every rule in the impossibilities table is textually grounded in either
the T3010 form or the Open Data Dictionary v2.0. No thresholds, no sign
conventions, no plausibility heuristics. The script NEVER treats a NULL
operand as zero when firing an impossibility rule — doing so
misclassifies ordinary missing-data filings as identity violations.

Tolerance: **\\$${TOLERANCE}** (rounding-level differences below this are not flagged).

## The 10 impossibility rules

### Expenditure-tree identities

| Rule | Check | Source |
|---|---|---|
| **IDENTITY_5100** | \`field_5100 = field_4950 + field_5045 + field_5050\` — fires only when 5100, 4950, and 5050 are all populated | T3010 line 657: "Total expenditures (add lines 4950, 5045 and 5050)" |
| **PARTITION_4950** | \`field_5000 + field_5010 + field_5020 + field_5040 ≤ field_4950\` — one-sided (only over-partitions are impossible, given version differences with field_5030) | T3010 lines 644, 648–651 |

### Balance-sheet identities

| Rule | Check | Source |
|---|---|---|
| **IDENTITY_4200** | \`field_4200 = field_4100 + 4110 + 4120 + 4130 + 4140 + 4150 + 4155 + 4160 + 4165 + 4166 + 4170\` — fires only when all twelve fields are populated | T3010 line 584; \`4180\` pre-v27 and \`4190\` impact-investment are NOT in the sum (latter is a memo cross-cut per Dictionary line 249) |
| **IDENTITY_4350** | \`field_4350 = field_4300 + field_4310 + field_4320 + field_4330\` — all five populated | T3010 line 572 |

### Cross-schedule equalities

| Rule | Check | Source |
|---|---|---|
| **COMP_4880_EQ_390** | \`field_4880\` (Schedule 6) = \`field_390\` (Schedule 3) | T3010 line 631 |
| **DQ_845_EQ_5000** | Schedule 8 line 845 = \`field_5000\` | Dictionary line 1023 |
| **DQ_850_EQ_5045** | Schedule 8 line 850 = \`field_5045\` | Dictionary line 1024 |
| **DQ_855_EQ_5050** | Schedule 8 line 855 = \`field_5050\` | Dictionary line 1025 |

### Schedule dependencies

| Rule | Check | Source |
|---|---|---|
| **SCH3_DEP_FORWARD** | \`field_3400\` (C9) = TRUE → Schedule 3 row must exist | T3010 line 133 |
| **SCH3_DEP_REVERSE** | Schedule 3 row exists → \`field_3400\` must = TRUE | T3010 line 467 |

## Rules deliberately retired in this version

* **\`I1_COMPONENT_EXCEEDS_PARENT / gifts_gt_total_exp\`**: claimed
  \`field_5050 > field_5100\` is impossible because "5050 is a component
  of 5100". Form line 657 says 5100 is the SUM of three addends
  (4950, 5045, 5050). 5050 is an addend, not a partition component.
  A negative field_4950 — legal under the form — makes 5050 > 5100
  arithmetically required, not impossible. Evaluation on 100 flagged
  rows found that 70 were NULL-5100 cases (completeness, not math),
  11 of the 25 populated rows actually SATISFY the 5100 identity
  exactly (they just have negative 4950), and the ~14 remaining real
  violations are already caught by \`IDENTITY_5100\`.

* **\`R1_MAGNITUDE_OUTLIER\`**: "money field > \\$50B" is a plausibility
  heuristic. The form imposes no upper bound. Moved to the
  plausibility_flags table.

* **\`R2_RECONCILIATION_FAILURE\`**: identical in intent to
  \`IDENTITY_5100\` but used \`COALESCE(..., 0)\` on the operands,
  producing the same NULL-as-zero false positives. Subsumed.

## Headline

| Metric | Value |
|---|---:|
| Financial filings scanned                      | ${Number(s.total_filings).toLocaleString()} |
| Total impossibilities recorded                  | ${Number(s.total_impossibilities).toLocaleString()} |
| Distinct BNs with ≥1 impossibility              | ${Number(s.distinct_bns_imp).toLocaleString()} |
| Total completeness issues recorded              | ${Number(s.total_completeness).toLocaleString()} |
| Distinct BNs with ≥1 completeness issue         | ${Number(s.distinct_bns_comp).toLocaleString()} |
| Total plausibility flags recorded               | ${Number(s.total_plausibility).toLocaleString()} |

## Impossibilities by rule

| Family | Rule | Rows | Distinct BNs | Σ severity | Max severity |
|---|---|---:|---:|---:|---:|
${ruleTable}

## Impossibilities by fiscal year

${yearPivot}

## Top violators per rule (full evidence)
${topSections}

## Reproducing

\`\`\`bash
cd CRA
npm run data-quality:arithmetic
node scripts/data-quality/02-t3010-arithmetic-impossibilities.js
node scripts/data-quality/02-t3010-arithmetic-impossibilities.js --top 40
\`\`\`

## Caveats

* **Tolerance is \\$${TOLERANCE}.** Rounding differences below that threshold are
  not flagged.
* **Severity** is the dollar magnitude of the violation where applicable
  (difference between reported total and computed sum). For dependency
  rules, severity is the companion dollar amount (\`field_390\` for
  SCH3_DEP_REVERSE; placeholder 1 for SCH3_DEP_FORWARD).
* **Field 4166 (accumulated amortization).** In accounting this is a
  contra-asset, but the form text at line 584 says "add" for the range
  4160 to 4170 which includes 4166. We take the form text literally.
  Filings where the charity reported 4166 as a positive magnitude
  expecting CRA to subtract it will trigger IDENTITY_4200 — the form's
  stated arithmetic is what we test.
* **Section D simplified filers** (revenue < \\$100K) report
  \`field_4200\` / \`field_4350\` totals without the component breakdown.
  Under this script's strict NULL handling, those filings generate
  MISSING_OPERAND_* completeness rows, NOT impossibilities. That is
  by design: they are not arithmetic violations.
* **Schedule 8** is only present for charities subject to the
  disbursement quota. DQ_* rules only fire when both sides exist for
  the same (bn, fpe). Exempt charities are not checked.
* **One charity-year can trigger multiple rules.** The impossibilities
  table stores one row per (bn, fpe, rule_code) so joins on (bn, fpe)
  may fan out.
* **Completeness rows are not errors.** A charity that reports
  \`field_4200\` but leaves individual asset components blank is
  following the form's optional-field semantics. Treat completeness
  volume as a data-shape metric, not a data-quality indictment.
`;
}

async function main() {
  log.section('Data-quality: T3010 strict impossibility audit');
  log.info(`Options: ${JSON.stringify(args)}`);
  const client = await db.getClient();
  try {
    await migrate(client);
    await runChecks(client);
    const r = await report(client);
    await emit(r);
    log.section('Arithmetic check complete');
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