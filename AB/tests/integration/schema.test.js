const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const { pool } = require('../../lib/db');

after(async () => {
  await pool.end();
});

describe('AB Schema - Integration Tests', () => {
  it('ab schema exists', async () => {
    const result = await pool.query(
      `SELECT schema_name FROM information_schema.schemata WHERE schema_name = 'ab'`
    );
    assert.equal(result.rows.length, 1, 'ab schema should exist');
  });

  it('all expected tables exist', async () => {
    const expectedTables = [
      'ab_grants',
      'ab_grants_fiscal_years',
      'ab_grants_ministries',
      'ab_grants_programs',
      'ab_grants_recipients',
      'ab_contracts',
      'ab_sole_source',
      'ab_non_profit',
      'ab_non_profit_status_lookup',
    ];

    const result = await pool.query(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'ab' AND table_type = 'BASE TABLE'
       ORDER BY table_name`
    );
    const actualTables = result.rows.map(r => r.table_name);

    for (const expected of expectedTables) {
      assert.ok(actualTables.includes(expected), `Table ab.${expected} should exist`);
    }
  });

  it('all expected views exist', async () => {
    const expectedViews = [
      'vw_grants_by_ministry',
      'vw_grants_by_recipient',
      'vw_non_profit_decoded',
    ];

    const result = await pool.query(
      `SELECT table_name FROM information_schema.views
       WHERE table_schema = 'ab'
       ORDER BY table_name`
    );
    const actualViews = result.rows.map(r => r.table_name);

    for (const expected of expectedViews) {
      assert.ok(actualViews.includes(expected), `View ab.${expected} should exist`);
    }
  });

  it('ab_grants has correct columns', async () => {
    const result = await pool.query(
      `SELECT column_name, data_type FROM information_schema.columns
       WHERE table_schema = 'ab' AND table_name = 'ab_grants'
       ORDER BY ordinal_position`
    );
    const columns = result.rows.map(r => r.column_name);

    const requiredColumns = [
      'id', 'mongo_id', 'ministry', 'business_unit_name', 'recipient',
      'program', 'amount', 'lottery', 'payment_date', 'fiscal_year',
      'display_fiscal_year', 'lottery_fund',
      'version', 'created_at', 'updated_at',
    ];

    for (const col of requiredColumns) {
      assert.ok(columns.includes(col), `ab_grants should have column: ${col}`);
    }
  });

  it('ab_sole_source has correct columns', async () => {
    const result = await pool.query(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = 'ab' AND table_name = 'ab_sole_source'
       ORDER BY ordinal_position`
    );
    const columns = result.rows.map(r => r.column_name);

    const requiredColumns = [
      'id', 'ministry', 'vendor', 'start_date', 'end_date',
      'amount', 'contract_number', 'display_fiscal_year',
      'department_city', 'vendor_city',
    ];

    for (const col of requiredColumns) {
      assert.ok(columns.includes(col), `ab_sole_source should have column: ${col}`);
    }
  });

  it('ab_non_profit_status_lookup has data', async () => {
    const result = await pool.query('SELECT COUNT(*) FROM ab.ab_non_profit_status_lookup');
    const count = parseInt(result.rows[0].count);
    assert.ok(count >= 12, `Status lookup should have at least 12 entries, got ${count}`);
  });
});

describe('AB Data - Row Count Verification', () => {
  it('ab_grants has records', async () => {
    const result = await pool.query('SELECT COUNT(*) FROM ab.ab_grants');
    const count = parseInt(result.rows[0].count);
    assert.ok(count > 0, `ab_grants should have records, got ${count}`);
  });

  it('ab_grants_fiscal_years has records', async () => {
    const result = await pool.query('SELECT COUNT(*) FROM ab.ab_grants_fiscal_years');
    const count = parseInt(result.rows[0].count);
    assert.ok(count >= 10, `Should have at least 10 fiscal years, got ${count}`);
  });

  it('ab_contracts has records', async () => {
    const result = await pool.query('SELECT COUNT(*) FROM ab.ab_contracts');
    const count = parseInt(result.rows[0].count);
    assert.ok(count > 60000, `Contracts should have >60K rows, got ${count}`);
  });

  it('ab_sole_source has records', async () => {
    const result = await pool.query('SELECT COUNT(*) FROM ab.ab_sole_source');
    const count = parseInt(result.rows[0].count);
    assert.ok(count > 15000, `Sole-source should have >15K rows, got ${count}`);
  });

  it('ab_non_profit has records', async () => {
    const result = await pool.query('SELECT COUNT(*) FROM ab.ab_non_profit');
    const count = parseInt(result.rows[0].count);
    assert.ok(count > 69000, `Non-profit should have >69K rows, got ${count}`);
  });
});

describe('AB Data - Quality Checks', () => {
  it('grants fiscal years are in expected format', async () => {
    const result = await pool.query(
      `SELECT COUNT(*) FROM ab.ab_grants
       WHERE display_fiscal_year IS NOT NULL
         AND display_fiscal_year !~ '^\\d{4} - \\d{4}$'`
    );
    const badCount = parseInt(result.rows[0].count);
    assert.equal(badCount, 0, `All fiscal years should match "YYYY - YYYY" format, ${badCount} do not`);
  });

  it('contracts amounts are reasonable', async () => {
    const result = await pool.query(
      `SELECT MIN(amount) AS min_val, MAX(amount) AS max_val FROM ab.ab_contracts`
    );
    const { min_val, max_val } = result.rows[0];
    assert.ok(max_val !== null, 'Should have at least one amount');
    assert.ok(
      parseFloat(max_val) < 10_000_000_000,
      `Max contract amount should be < $10B (reasonable upper bound), got $${max_val}`
    );
    assert.ok(
      parseFloat(min_val) >= 0,
      `Min contract amount should be >= 0, got $${min_val}`
    );
  });

  it('non-profit statuses match lookup', async () => {
    const result = await pool.query(
      `SELECT COUNT(*) FROM ab.ab_non_profit np
       WHERE np.status IS NOT NULL
         AND NOT EXISTS (
           SELECT 1 FROM ab.ab_non_profit_status_lookup sl
           WHERE LOWER(sl.status) = LOWER(np.status)
         )`
    );
    const unmatched = parseInt(result.rows[0].count);
    assert.equal(unmatched, 0, `All non-profit statuses should match lookup, ${unmatched} unmatched`);
  });

  it('sole-source dates are valid', async () => {
    const result = await pool.query(
      `SELECT COUNT(*) FROM ab.ab_sole_source
       WHERE start_date IS NOT NULL AND start_date > end_date`
    );
    const invalid = parseInt(result.rows[0].count);
    const totalResult = await pool.query(
      `SELECT COUNT(*) FROM ab.ab_sole_source WHERE start_date IS NOT NULL`
    );
    const total = parseInt(totalResult.rows[0].count);
    // Some data may legitimately have start > end due to amendments
    console.log(`  [info] ${invalid} of ${total} sole-source records have start_date > end_date`);
    const pct = total > 0 ? (invalid / total) * 100 : 0;
    assert.ok(pct < 5, `Expected < 5% invalid date ranges, got ${pct.toFixed(2)}% (${invalid}/${total})`);
  });
});
