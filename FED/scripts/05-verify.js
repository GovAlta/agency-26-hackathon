/**
 * 05-verify.js - Verify data completeness and integrity.
 *
 * Checks:
 *   1. Lookup tables are populated
 *   2. Total records in DB match total fetched from API
 *   3. Data quality spot checks (province codes, agreement types, etc.)
 *   4. Balance report: API total vs cached vs DB
 *
 * Usage: npm run verify
 */
const db = require('../lib/db');
const log = require('../lib/logger');
const { loadMetadata, countCachedRecords, getBatchFiles } = require('../lib/api-client');

async function verify() {
  const client = await db.getClient();
  let totalChecks = 0;
  let passed = 0;
  let failed = 0;
  const failures = [];

  function check(name, condition, detail = '') {
    totalChecks++;
    if (condition) {
      passed++;
      log.info(`  PASS: ${name}`);
    } else {
      failed++;
      failures.push({ name, detail });
      log.error(`  FAIL: ${name} ${detail ? '- ' + detail : ''}`);
    }
  }

  try {
    await client.query(`SET search_path TO fed, public;`);

    log.section('Data Verification');

    // ── 1. Lookup tables ─────────────────────────────────────────
    log.info('Checking lookup tables...');
    const lookups = [
      { table: 'fed.agreement_type_lookup', minRows: 3 },
      { table: 'fed.recipient_type_lookup', minRows: 8 },
      { table: 'fed.country_lookup', minRows: 200 },
      { table: 'fed.province_lookup', minRows: 13 },
      { table: 'fed.currency_lookup', minRows: 50 },
    ];
    for (const lk of lookups) {
      const res = await client.query(`SELECT COUNT(*) AS cnt FROM ${lk.table}`);
      const count = parseInt(res.rows[0].cnt, 10);
      check(`${lk.table} populated`, count >= lk.minRows, `${count} rows (need >= ${lk.minRows})`);
    }

    // ── 2. Data table: cache vs database ─────────────────────────
    log.info('');
    log.info('Checking data table against cached source data...');

    const metadata = loadMetadata();
    const batchFiles = getBatchFiles();

    if (!metadata && batchFiles.length === 0) {
      log.warn('No cached data found - skipping balance check. Run fetch first.');
    } else {
      const apiTotal = metadata?.totalRecords || 0;
      const cachedCount = countCachedRecords();
      const dbRes = await client.query('SELECT COUNT(*) AS cnt FROM fed.grants_contributions');
      const dbCount = parseInt(dbRes.rows[0].cnt, 10);

      // Balance report
      log.info('');
      log.section('Balance Report: API Total vs Cached vs Database');
      log.info(`  API reported total:   ${apiTotal.toLocaleString()}`);
      log.info(`  Records in cache:     ${cachedCount.toLocaleString()}`);
      log.info(`  Records in database:  ${dbCount.toLocaleString()}`);
      log.info(`  Batch files on disk:  ${batchFiles.length}`);

      // Check: Did we fetch all records?
      check(
        `FETCH completeness: ${cachedCount.toLocaleString()} / ${apiTotal.toLocaleString()} cached`,
        cachedCount >= apiTotal,
        cachedCount < apiTotal ? `Missing ${(apiTotal - cachedCount).toLocaleString()} records from API` : ''
      );

      // Check: Did we load all cached rows to DB? (1% tolerance for invalid rows)
      const tolerance = Math.max(10, Math.ceil(cachedCount * 0.01));
      const withinTolerance = dbCount >= (cachedCount - tolerance);
      check(
        `IMPORT completeness: ${dbCount.toLocaleString()} / ${cachedCount.toLocaleString()} in database`,
        withinTolerance,
        withinTolerance ? '' : `Missing ${(cachedCount - dbCount).toLocaleString()} rows (tolerance: ${tolerance})`
      );

      // Check exact balance
      const exactMatch = dbCount >= apiTotal;
      const balanceStatus = exactMatch ? 'BALANCED' : `DIFF: -${(apiTotal - dbCount).toLocaleString()}`;
      log.info(`  Balance status: ${balanceStatus}`);
    }

    // ── 3. Data quality checks ───────────────────────────────────
    log.info('');
    log.info('Checking data quality...');

    // Total records > 0
    const totalRes = await client.query('SELECT COUNT(*) AS cnt FROM fed.grants_contributions');
    const totalCount = parseInt(totalRes.rows[0].cnt, 10);
    check('Total records > 0', totalCount > 0, `${totalCount.toLocaleString()} total`);

    if (totalCount > 0) {
      // Agreement types: standard codes (G/C/O) plus some departments used full words
      // ("Contribution", "Grant", "CONTRIBUTION", "GRANT") - this is source data quality
      const validTypeRes = await client.query(`
        SELECT COUNT(*) AS cnt FROM fed.grants_contributions
        WHERE agreement_type IS NOT NULL
          AND UPPER(agreement_type) NOT IN ('G', 'C', 'O', 'GRANT', 'CONTRIBUTION', 'OTHER TRANSFER PAYMENT')
      `);
      const unknownTypes = parseInt(validTypeRes.rows[0].cnt, 10);
      check('Agreement types recognized', unknownTypes === 0, `${unknownTypes} unrecognized rows`);

      // Warn about non-standard agreement type codes (not a failure)
      const nonstdTypeRes = await client.query(`
        SELECT COUNT(*) AS cnt FROM fed.grants_contributions
        WHERE agreement_type IS NOT NULL AND agreement_type NOT IN ('G', 'C', 'O')
      `);
      const nonstdTypes = parseInt(nonstdTypeRes.rows[0].cnt, 10);
      if (nonstdTypes > 0) {
        log.warn(`  NOTE: ${nonstdTypes.toLocaleString()} rows use full-text agreement types (e.g. "Contribution" instead of "C") - source data variance`);
      }

      // Recipient types are valid (A, F, G, I, N, O, P, S, or NULL)
      const invalidRecipRes = await client.query(`
        SELECT COUNT(*) AS cnt FROM fed.grants_contributions
        WHERE recipient_type IS NOT NULL AND recipient_type NOT IN ('A', 'F', 'G', 'I', 'N', 'O', 'P', 'S')
      `);
      const invalidRecip = parseInt(invalidRecipRes.rows[0].cnt, 10);
      check('Recipient types valid', invalidRecip === 0, `${invalidRecip} invalid rows`);

      // Province codes: most are 2-char, but some source rows have free-text
      // (e.g. "Ontario", "N/A", "Rome"). Allow < 0.1% tolerance.
      const invalidProvRes = await client.query(`
        SELECT COUNT(*) AS cnt FROM fed.grants_contributions
        WHERE recipient_province IS NOT NULL AND LENGTH(recipient_province) != 2
      `);
      const invalidProv = parseInt(invalidProvRes.rows[0].cnt, 10);
      const provTolerance = Math.ceil(totalCount * 0.001); // 0.1%
      check('Province codes mostly 2-char', invalidProv <= provTolerance,
        `${invalidProv} non-standard rows (tolerance: ${provTolerance})`);
      if (invalidProv > 0) {
        log.warn(`  NOTE: ${invalidProv} rows have free-text province codes (e.g. "Ontario", "N/A") - source data variance`);
      }

      // Agreement values: TBS spec says "must be greater than 0". Negatives
      // are used by some departments as termination/reversal markers (de
      // facto convention on amendment rows), and zeros appear in source data.
      // Both violate spec — we surface the counts but do not fail the check.
      const negativeValRes = await client.query(`
        SELECT
          COUNT(*) FILTER (WHERE agreement_value < 0) AS negative_total,
          COUNT(*) FILTER (WHERE agreement_value < 0 AND is_amendment) AS negative_on_amendments,
          COUNT(*) FILTER (WHERE agreement_value < 0 AND NOT is_amendment) AS negative_on_originals,
          COUNT(*) FILTER (WHERE agreement_value = 0) AS zero_values
        FROM fed.grants_contributions
      `);
      const { negative_total, negative_on_amendments, negative_on_originals, zero_values } =
        negativeValRes.rows[0];
      const negativeVals = parseInt(negative_total, 10);
      const negTolerance = Math.ceil(totalCount * 0.01); // 1%
      check('Negative agreement values within tolerance', negativeVals <= negTolerance,
        `${negativeVals.toLocaleString()} negative values (tolerance: ${negTolerance.toLocaleString()})`);
      if (negativeVals > 0 || parseInt(zero_values, 10) > 0) {
        log.warn(`  NOTE: TBS spec says agreement_value "must be greater than 0". Source data contains:`);
        log.warn(`    - ${parseInt(negative_total, 10).toLocaleString()} negative values`
          + ` (${parseInt(negative_on_amendments, 10).toLocaleString()} on amendments,`
          + ` ${parseInt(negative_on_originals, 10).toLocaleString()} on originals)`);
        log.warn(`    - ${parseInt(zero_values, 10).toLocaleString()} zero values`);
        log.warn(`  Carried through as-published — not fixed on import.`);
      }

      // ref_number source-defect surfacing (TBS: "unique reference number
      // given to each entry"). Report-only — we do not modify the data.
      const refDefectsRes = await client.query(`
        SELECT
          (SELECT COUNT(*) FROM (
             SELECT ref_number FROM fed.grants_contributions
             WHERE ref_number IS NOT NULL
             GROUP BY ref_number
             HAVING COUNT(DISTINCT COALESCE(recipient_business_number,'') || '|' ||
                                   COALESCE(recipient_legal_name,'')) > 1
           ) t) AS cross_recipient_refs,
          (SELECT COUNT(*) FROM (
             SELECT ref_number, amendment_number FROM fed.grants_contributions
             WHERE ref_number IS NOT NULL
             GROUP BY ref_number, amendment_number
             HAVING COUNT(*) > 1
           ) t) AS duplicate_pairs
      `);
      const crossRefs = parseInt(refDefectsRes.rows[0].cross_recipient_refs, 10);
      const dupPairs = parseInt(refDefectsRes.rows[0].duplicate_pairs, 10);
      if (crossRefs > 0 || dupPairs > 0) {
        log.warn(`  NOTE: ref_number defects vs TBS "unique per entry" spec:`);
        log.warn(`    - ${crossRefs.toLocaleString()} ref_numbers appear under >1 recipient`);
        log.warn(`    - ${dupPairs.toLocaleString()} (ref_number, amendment_number) pairs duplicate`);
        log.warn(`  See docs/DATA_DICTIONARY.md "Known source defects".`);
      }

      // Multiple departments present
      const deptRes = await client.query('SELECT COUNT(DISTINCT owner_org) AS cnt FROM fed.grants_contributions WHERE owner_org IS NOT NULL');
      const deptCount = parseInt(deptRes.rows[0].cnt, 10);
      check('Multiple departments present', deptCount > 10, `${deptCount} distinct departments`);

      // Multiple provinces present
      const provRes = await client.query('SELECT COUNT(DISTINCT recipient_province) AS cnt FROM fed.grants_contributions WHERE recipient_province IS NOT NULL');
      const provCount = parseInt(provRes.rows[0].cnt, 10);
      check('Multiple provinces present', provCount > 5, `${provCount} distinct provinces`);

      // Date range spans multiple years
      const yearRes = await client.query(`
        SELECT
          MIN(EXTRACT(YEAR FROM agreement_start_date)) AS min_year,
          MAX(EXTRACT(YEAR FROM agreement_start_date)) AS max_year
        FROM fed.grants_contributions
        WHERE agreement_start_date IS NOT NULL
      `);
      const minYear = yearRes.rows[0].min_year;
      const maxYear = yearRes.rows[0].max_year;
      check('Date range spans multiple years', maxYear - minYear > 1, `${minYear} to ${maxYear}`);
    }

    // ── Summary ──────────────────────────────────────────────────
    log.section('Verification Summary');
    log.info(`Total checks: ${totalChecks}`);
    log.info(`Passed: ${passed}`);
    log.info(`Failed: ${failed}`);

    if (failures.length > 0) {
      log.info('');
      log.info('Failures:');
      for (const f of failures) {
        log.error(`  - ${f.name}: ${f.detail}`);
      }
    }

    if (failed > 0) {
      log.error(`\n${failed} verification checks failed.`);
      process.exit(1);
    } else {
      log.info('\nAll verification checks passed!');
    }
  } catch (err) {
    log.error(`Verification error: ${err.message}`);
    throw err;
  } finally {
    client.release();
    await db.end();
  }
}

verify().catch((err) => {
  console.error('Fatal verification error:', err);
  process.exit(1);
});
