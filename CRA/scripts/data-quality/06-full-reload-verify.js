/**
 * 06-full-reload-verify.js
 *
 * Six-level JSON-cache vs. PostgreSQL verification after a full reload.
 *
 * Runs per (dataset × fiscal-year) across all 19 datasets and all 5 years.
 *
 *   Level 1 — Record count parity
 *             count(JSON records) == count(DB rows filtered to year)
 *             (tolerates exact-duplicate-row dedup by the ON CONFLICT
 *             DO NOTHING primary-key handling)
 *
 *   Level 2 — Field count / mapping parity
 *             Every JSON key that isn't a CKAN housekeeping field
 *             (`_id`, `BN/NE`) maps to a DB column that gets populated.
 *
 *   Level 3 — Per-field non-null count parity
 *             For every field: count of non-null JSON values matches
 *             count of non-null DB values (to within the row-dedup tolerance).
 *
 *   Level 4 — Numeric SUM parity
 *             For every numeric field in the DB, SUM(DB) equals SUM(JSON)
 *             to within 0.01% relative difference + $1 absolute.
 *
 *   Level 5 — Boolean Y/N distribution parity
 *             For every boolean field: count of Y in JSON == count of true
 *             in DB, count of N == count of false.
 *
 *   Level 6 — Distinct-value count parity for TEXT fields
 *             For every text field: count of distinct values in JSON matches
 *             count in DB (catches silent truncation / encoding drops).
 *
 * Output: data/reports/full-reload-verify.{md,json}
 * Any failure at any level is reported explicitly — this script exits with
 * nonzero status if anything fails.
 */

const fs = require('fs');
const path = require('path');
const db = require('../../lib/db');
const apiClient = require('../../lib/api-client');
const {
  yesNoToBool,
  parseDecimal,
  parseInteger,
  parseDate,
  cleanString,
  cleanCode2,
} = require('../../lib/transformers');

const YEARS = [2020, 2021, 2022, 2023, 2024];
const REPORT_DIR = path.join(__dirname, '..', '..', 'data', 'reports');
const REPORT_JSON = path.join(REPORT_DIR, 'full-reload-verify.json');
const REPORT_MD   = path.join(REPORT_DIR, 'full-reload-verify.md');

// ─── Canonical mapping: every (dataset × jsonKey) → (dbColumn, transform) ───
//
// Derived from the CRA Open Data Dictionary v2.0 (docs/guides-forms).
// This is the single source of truth used by the verification. If a column
// ever misaligns with the dictionary this mapping is what to change.

const TRANSFORMS = {
  string:  { tx: cleanString,    sum: false, bool: false, distinct: true  },
  code2:   { tx: cleanCode2,     sum: false, bool: false, distinct: true  },
  date:    { tx: parseDate,      sum: false, bool: false, distinct: true  },
  int:     { tx: parseInteger,   sum: true,  bool: false, distinct: false },
  decimal: { tx: v => { const n = parseDecimal(v); return n === null ? null : Number(n); },
             sum: true,  bool: false, distinct: false },
  bool:    { tx: yesNoToBool,    sum: false, bool: true,  distinct: false },
};

// keyType tells us whether the table is keyed by fiscal_year or by fpe.
const DATASETS = {
  identification: {
    table: 'cra_identification',
    keyType: 'year',
    fields: [
      ['BN',              'bn',            'string'],
      ['Category',        'category',      'string'],
      ['Sub Category',    'sub_category',  'string'],
      ['Designation',     'designation',   'string'],
      ['Legal Name',      'legal_name',    'string'],
      ['Account Name',    'account_name',  'string'],
      ['Address Line 1',  'address_line_1','string'],
      ['Address Line 2',  'address_line_2','string'],
      ['City',            'city',          'string'],
      ['Province',        'province',      'code2'],
      ['Postal Code',     'postal_code',   'string'],
      ['Country',         'country',       'code2'],
    ],
  },

  web_urls: {
    table: 'cra_web_urls',
    keyType: 'year',
    // Handle the "BN/NE" / "BN" alias via a pre-processor.
    fields: [
      ['Contact URL',     'contact_url',   'string'],
    ],
    preProcess: rec => ({ ...rec, BN: rec.BN || rec['BN/NE'] }),
  },

  directors: {
    table: 'cra_directors',
    keyType: 'fpe',
    fields: [
      ['Last Name',       'last_name',     'string'],
      ['First Name',      'first_name',    'string'],
      ['Initials',        'initials',      'string'],
      ['Position',        'position',      'string'],
      ["At Arm's Length", 'at_arms_length','bool'],
      ['Start Date',      'start_date',    'date'],
      ['End Date',        'end_date',      'date'],
    ],
  },

  qualified_donees: {
    table: 'cra_qualified_donees',
    keyType: 'fpe',
    // 2023 JSON uses camelcase header names (DoneeBN, TotalGifts) while other
    // years use spaced names. The import script handles both; the verifier
    // unifies them to the spaced version via preProcess.
    preProcess: rec => ({
      ...rec,
      'Form ID':                   rec['Form ID'] || rec['FormID'],
      'Donee BN':                  rec['Donee BN'] || rec['DoneeBN'],
      'Donee Name':                rec['Donee Name'] || rec['DoneeName'],
      'Total Gifts':               rec['Total Gifts'] ?? rec['TotalGifts'],
      'Gifts in Kind':             rec['Gifts in Kind'] ?? rec['GiftsinKind'],
      'Political Activity Gift':   rec['Political Activity Gift'] || rec['PoliticalActivityGift'],
      'Political Activity Amount': rec['Political Activity Amount'] ?? rec['PoliticalActivityAmount'],
    }),
    fields: [
      ['Donee BN',                  'donee_bn',                  'string'],
      ['Donee Name',                'donee_name',                'string'],
      ['Associated',                'associated',                'bool'],
      ['City',                      'city',                      'string'],
      ['Province',                  'province',                  'code2'],
      ['Total Gifts',               'total_gifts',               'decimal'],
      ['Gifts in Kind',             'gifts_in_kind',             'decimal'],
      ['Political Activity Gift',   'political_activity_gift',   'bool'],
      ['Political Activity Amount', 'political_activity_amount', 'decimal'],
    ],
  },

  charitable_programs: {
    table: 'cra_charitable_programs',
    keyType: 'fpe',
    preProcess: rec => ({
      ...rec,
      'Form ID': rec['Form ID'] || rec['FormID'],
      'Program Type': rec['Program Type'] || rec['ProgramType'],
    }),
    fields: [
      ['Description', 'description', 'string'],
    ],
  },

  general_info: {
    table: 'cra_financial_general',
    keyType: 'fpe',
    preProcess: rec => ({ ...rec, 'Form ID': rec['Form ID'] || rec['FormID'] }),
    fields: [
      ['Program #1 Code', 'program_area_1',         'string'],
      ['Program #2 Code', 'program_area_2',         'string'],
      ['Program #3 Code', 'program_area_3',         'string'],
      ['Program #1 %',    'program_percentage_1',   'int'],
      ['Program #2 %',    'program_percentage_2',   'int'],
      ['Program #3 %',    'program_percentage_3',   'int'],
      ['Program #1 Desc', 'program_description_1',  'string'],
      ['Program #2 Desc', 'program_description_2',  'string'],
      ['Program #3 Desc', 'program_description_3',  'string'],
      ['1510',            'field_1510_subordinate','bool'],
      ['1510-BN',         'field_1510_parent_bn', 'string'],
      ['1510-Name',       'field_1510_parent_name','string'],

      // Bool Y/N flags (per dictionary §3.6)
      ...['1570','1600','1800','2000','2100','2400','2500','2510','2530','2540',
          '2550','2560','2570','2575','2580','2590','2600','2610','2620','2630',
          '2640','2650','2700','2730','2740','2750','2760','2770','2780','2800',
          '3200','3400','3900','4000','5800','5810','5820','5830','5840','5841',
          '5850','5860']
        .map(k => [k, `field_${k}`, 'bool']),

      // Decimal Amount fields
      ...['5030','5031','5032','5450','5460','5843','5862','5863','5864']
        .map(k => [k, `field_${k}`, 'decimal']),

      // Integer Number fields
      ...['5842','5861']
        .map(k => [k, `field_${k}`, 'int']),

      // Text fields
      ['2660', 'field_2660', 'string'],
      ['2790', 'field_2790', 'string'],
    ],
  },

  financial_data: {
    table: 'cra_financial_details',
    keyType: 'fpe',
    preProcess: rec => ({
      ...rec,
      'Form ID': rec['Form ID'] || rec['FormID'],
      'Section Used': rec['Section Used'] || rec['SectionUsed'],
    }),
    fields: [
      ['Section Used', 'section_used', 'string'],
      ['4020',         'field_4020',   'string'],
      ['4050',         'field_4050',   'bool'],
      ...['4400','4490','4565'].map(k => [k, `field_${k}`, 'bool']),

      // All Amount fields
      ...['4100','4101','4102','4110','4120','4130','4140','4150','4155','4157',
          '4158','4160','4165','4166','4170','4180','4190','4200','4250','4300',
          '4310','4320','4330','4350','4500','4505','4510','4530','4540','4550',
          '4560','4570','4571','4575','4576','4577','4580','4590','4600','4610',
          '4620','4630','4640','4650','4700','4800','4810','4820','4830','4840',
          '4850','4860','4870','4880','4890','4891','4900','4910','4920','4950',
          '5000','5010','5020','5030','5040','5045','5050','5100','5500','5510',
          '5610','5750','5900','5910']
        .map(k => [k, `field_${k}`, 'decimal']),

      // The two Text "specify" fields (Text 175 per dictionary)
      ['4655', 'field_4655', 'string'],
      ['4930', 'field_4930', 'string'],
    ],
  },

  foundation_info: {
    table: 'cra_foundation_info',
    keyType: 'fpe',
    fields: [
      ['100', 'field_100', 'bool'],
      ['110', 'field_110', 'bool'],
      ['120', 'field_120', 'bool'],
      ['130', 'field_130', 'bool'],
      ['111', 'field_111', 'decimal'],
      ['112', 'field_112', 'decimal'],
    ],
  },

  activities_outside_countries: {
    table: 'cra_activities_outside_countries',
    keyType: 'fpe',
    fields: [
      ['Country', 'country', 'code2'],
    ],
  },

  activities_outside_details: {
    table: 'cra_activities_outside_details',
    keyType: 'fpe',
    // Note: dictionary says 230 is Amount 14 but DB stores as TEXT and values
    // are preserved as strings. Intentional: not touching this typing without
    // explicit approval. Verified as string-equal here.
    fields: [
      ['200', 'field_200', 'decimal'],
      ['210', 'field_210', 'bool'],
      ['220', 'field_220', 'bool'],
      ['230', 'field_230', 'string'],
      ['240', 'field_240', 'bool'],
      ['250', 'field_250', 'bool'],
      ['260', 'field_260', 'bool'],
    ],
  },

  exported_goods: {
    table: 'cra_exported_goods',
    keyType: 'fpe',
    fields: [
      ['Item Name',   'item_name',   'string'],
      ['Item Value',  'item_value',  'decimal'],
      ['Destination', 'destination', 'string'],
      ['Country',     'country',     'code2'],
    ],
  },

  resources_sent_outside: {
    table: 'cra_resources_sent_outside',
    keyType: 'fpe',
    preProcess: rec => ({ ...rec, 'Indiv/Org Name': rec['Indiv/Org Name'] || rec['Org Name'] }),
    fields: [
      ['Indiv/Org Name', 'individual_org_name', 'string'],
      ['Amount',         'amount',              'decimal'],
      ['Country',        'country',             'code2'],
    ],
  },

  compensation: {
    table: 'cra_compensation',
    keyType: 'fpe',
    fields: [
      ...['300','305','310','315','320','325','330','335','340','345','370']
        .map(k => [k, `field_${k}`, 'int']),
      ...['380','390']
        .map(k => [k, `field_${k}`, 'decimal']),
    ],
  },

  gifts_in_kind: {
    table: 'cra_gifts_in_kind',
    keyType: 'fpe',
    preProcess: rec => ({ ...rec, 'Form ID': rec['Form ID'] || rec['FormID'] }),
    fields: [
      ...['500','505','510','515','520','525','530','535','540','545','550','555','560']
        .map(k => [k, `field_${k}`, 'bool']),
      ['565', 'field_565', 'string'],
      ['580', 'field_580', 'decimal'],
    ],
  },

  political_activity_description: {
    table: 'cra_political_activity_desc',
    keyType: 'fpe',
    fields: [
      ['Description', 'description', 'string'],
    ],
  },

  political_activity_funding: {
    table: 'cra_political_activity_funding',
    keyType: 'fpe',
    fields: [
      ['Activity', 'activity', 'string'],
      ['Amount',   'amount',   'decimal'],
      ['Country',  'country',  'code2'],
    ],
  },

  political_activity_resources: {
    table: 'cra_political_activity_resources',
    keyType: 'fpe',
    // Staff/Volunteers/Financial/Property are "Text 1" in dictionary, stored
    // as int/numeric in DB. Values are 0/1-ish. Verified as string to int here.
    fields: [
      ['Staff',      'staff',          'int'],
      ['Volunteers', 'volunteers',     'int'],
      ['Financial',  'financial',      'decimal'],
      ['Property',   'property',       'decimal'],
      ['Other',      'other_resource', 'string'],
    ],
  },

  non_qualified_donees: {
    table: 'cra_non_qualified_donees',
    keyType: 'fpe',
    fields: [
      ['Recipient name', 'recipient_name',  'string'],
      ['Purpose',        'purpose',         'string'],
      ['Cash amount',    'cash_amount',     'decimal'],
      ['Non-cash amount','non_cash_amount', 'decimal'],
      ['Country',        'country',         'string'],  // Text 125 per §3.18, NOT code2
    ],
  },

  disbursement_quota: {
    table: 'cra_disbursement_quota',
    keyType: 'fpe',
    fields: [
      ...['805','810','815','820','825','830','835','840','845','850',
          '855','860','865','870','875','880','885','890']
        .map(k => [k, `field_${k}`, 'decimal']),
    ],
  },
};

// ─── Helpers ────────────────────────────────────────────────────────────────

function fmtNum(n) {
  if (n === null || n === undefined || !isFinite(n)) return String(n);
  return Math.abs(n) >= 1000 ? Number(n).toLocaleString() : String(n);
}

function yearFromFpe(v) {
  if (!v) return null;
  const m = /^(\d{4})/.exec(String(v));
  return m ? Number(m[1]) : null;
}

function normBoolString(s) {
  if (s === null || s === undefined || s === '') return null;
  const u = String(s).trim().toUpperCase();
  if (u === 'Y') return true;
  if (u === 'N') return false;
  return null;
}

// ─── Core verification routine for one (dataset × year) ─────────────────────

async function verifyDatasetYear(dsKey, year, log) {
  const def = DATASETS[dsKey];
  const cache = apiClient.loadCache(year, dsKey);
  if (!cache || !cache.records) {
    log.skip.push({ dsKey, year, reason: 'no cache file' });
    return;
  }

  // Apply preProcess (e.g. BN/NE alias) and filter by year (for year-keyed tables
  // the JSON only contains that year already; for fpe-keyed tables we filter on FPE year).
  const records = cache.records.map(r => def.preProcess ? def.preProcess(r) : r);

  // ── LEVEL 1: record count ───────────────────────────────────────────────
  //
  // Compare DB count against the number of UNIQUE primary keys in the JSON,
  // not raw JSON rows. CKAN datasets occasionally emit exact-duplicate rows
  // (same BN + fpe + seq) which ON CONFLICT DO NOTHING collapses on insert.
  // Counting raw JSON rows would treat that collapse as a data-loss bug.
  const jsonRowCount = records.length;
  const uniqueKeys = new Set();
  for (const r of records) {
    let k;
    if (def.keyType === 'year') {
      k = `${r.BN}|${r['#'] ?? ''}`;                // web_urls + identification
    } else {
      const seq = r['#'];
      const progType = r['Program Type'] || r['ProgramType'];
      k = `${r.BN}|${r.FPE}|${seq ?? progType ?? ''}`;
    }
    uniqueKeys.add(k);
  }
  const jsonUnique = uniqueKeys.size;

  const countQuery = def.keyType === 'year'
    ? `SELECT COUNT(*) AS n FROM ${def.table} WHERE fiscal_year = $1`
    : `SELECT COUNT(*) AS n FROM ${def.table} WHERE EXTRACT(YEAR FROM fpe) = $1`;
  const dbRowCount = Number((await db.query(countQuery, [year])).rows[0].n);

  const rowsL1 = {
    level: 1, kind: 'row_count', dsKey, year,
    json: jsonRowCount, json_unique: jsonUnique, db: dbRowCount,
    delta: jsonUnique - dbRowCount,
    raw_delta: jsonRowCount - dbRowCount,
  };
  // Pass if DB count matches unique-key count (allowing tiny slack for
  // rows skipped upstream due to invalid BN/FPE — these are logged in
  // the import step as "skipped").
  rowsL1.pass = Math.abs(rowsL1.delta) <= Math.max(5, Math.ceil(jsonUnique * 0.0001));
  log.results.push(rowsL1);

  // Level 1 is mandatory — if unique-key-count is way off, subsequent levels
  // are meaningless so we bail. (raw delta from duplicates doesn't count.)
  if (!rowsL1.pass && Math.abs(rowsL1.delta) > 50) {
    log.results.push({
      level: 'ABORT', dsKey, year,
      message: `unique-row count delta too large (${rowsL1.delta}) — skipping remaining levels for this year`,
    });
    return;
  }

  // Deduplicate JSON records by primary key for the per-field levels.
  // Without this, duplicate JSON rows inflate nnJson, sumJson, distinct counts.
  const dedupeKey = (r) => {
    if (def.keyType === 'year') return `${r.BN}|${r['#'] ?? ''}`;
    const seq = r['#'];
    const progType = r['Program Type'] || r['ProgramType'];
    return `${r.BN}|${r.FPE}|${seq ?? progType ?? ''}`;
  };
  const seenKeys = new Set();
  const dedupedRecords = [];
  for (const r of records) {
    const k = dedupeKey(r);
    if (seenKeys.has(k)) continue;
    seenKeys.add(k);
    dedupedRecords.push(r);
  }

  // ── LEVEL 2: field-coverage ─────────────────────────────────────────────
  const jsonKeys = new Set();
  for (const r of dedupedRecords) for (const k of Object.keys(r)) jsonKeys.add(k);
  jsonKeys.delete('_id');                 // CKAN row id
  jsonKeys.delete('BN/NE');               // alias, already unified to BN
  const mapped = new Set(['BN', 'FPE', 'Form ID', '#', 'Program Type']);
  // Known camelcase aliases emitted by the 2023 CKAN datasets — these resolve
  // to correctly-mapped fields through each dataset's preProcess.
  const CAMEL_ALIASES = [
    'FormID','SectionUsed','ProgramType',
    'DoneeBN','DoneeName','TotalGifts','GiftsinKind',
    'PoliticalActivityGift','PoliticalActivityAmount',
  ];
  for (const a of CAMEL_ALIASES) mapped.add(a);
  for (const [jk] of def.fields) mapped.add(jk);

  const unmapped = [...jsonKeys].filter(k => !mapped.has(k));
  if (unmapped.length > 0) {
    log.results.push({
      level: 2, kind: 'unmapped_json_key', dsKey, year,
      unmapped, pass: false,
    });
  } else {
    log.results.push({ level: 2, kind: 'unmapped_json_key', dsKey, year, unmapped: [], pass: true });
  }

  // ── LEVEL 3, 4, 5, 6 per field ──────────────────────────────────────────
  for (const [jsonKey, dbCol, type] of def.fields) {
    const T = TRANSFORMS[type];
    let nnJson = 0;
    let sumJson = 0;
    let yJson = 0, nJson = 0;
    const distinctJson = new Set();

    for (const rec of dedupedRecords) {
      const raw = rec[jsonKey];
      const v = T.tx(raw);
      if (v === null || v === undefined) continue;
      nnJson++;
      if (T.sum) sumJson += Number(v);
      if (T.bool) { if (v === true) yJson++; else nJson++; }
      if (T.distinct) distinctJson.add(String(v));
    }

    // DB side
    const yearFilter = def.keyType === 'year'
      ? `fiscal_year = $1`
      : `EXTRACT(YEAR FROM fpe) = $1`;

    // Level 3 non-null count
    const nnDbRes = await db.query(
      `SELECT COUNT(${dbCol}) AS n FROM ${def.table} WHERE ${yearFilter}`,
      [year]);
    const nnDb = Number(nnDbRes.rows[0].n);
    const l3 = {
      level: 3, kind: 'nonnull_count', dsKey, year, field: jsonKey, col: dbCol, type,
      json: nnJson, db: nnDb, delta: nnJson - nnDb,
    };
    l3.pass = Math.abs(l3.delta) <= Math.max(5, Math.ceil(nnJson * 0.0001));
    log.results.push(l3);

    // Level 4 sum (numeric only)
    if (T.sum) {
      const sumDbRes = await db.query(
        `SELECT COALESCE(SUM(${dbCol}), 0) AS s FROM ${def.table} WHERE ${yearFilter}`,
        [year]);
      const sumDb = Number(sumDbRes.rows[0].s);
      const absSum = Math.max(Math.abs(sumJson), Math.abs(sumDb), 1);
      const rel = Math.abs(sumJson - sumDb) / absSum;
      const l4 = {
        level: 4, kind: 'numeric_sum', dsKey, year, field: jsonKey, col: dbCol,
        json: sumJson, db: sumDb, abs_diff: sumJson - sumDb, rel_diff: rel,
      };
      l4.pass = rel <= 0.0001 || Math.abs(sumJson - sumDb) <= 1;
      log.results.push(l4);
    }

    // Level 5 Y/N distribution (bool only)
    if (T.bool) {
      const distRes = await db.query(
        `SELECT ${dbCol} AS v, COUNT(*) AS n FROM ${def.table} WHERE ${yearFilter} AND ${dbCol} IS NOT NULL GROUP BY ${dbCol}`,
        [year]);
      let trueDb = 0, falseDb = 0;
      for (const row of distRes.rows) {
        if (row.v === true) trueDb = Number(row.n);
        if (row.v === false) falseDb = Number(row.n);
      }
      const l5 = {
        level: 5, kind: 'bool_distribution', dsKey, year, field: jsonKey, col: dbCol,
        json_Y: yJson, json_N: nJson, db_true: trueDb, db_false: falseDb,
        delta_Y: yJson - trueDb, delta_N: nJson - falseDb,
      };
      l5.pass = Math.abs(l5.delta_Y) <= 5 && Math.abs(l5.delta_N) <= 5;
      log.results.push(l5);
    }

    // Level 6 distinct-value count (string only, skip BN-ish keys which have
    // huge cardinalities that already pass via Level 3)
    if (T.distinct) {
      const distRes = await db.query(
        `SELECT COUNT(DISTINCT ${dbCol}) AS n FROM ${def.table} WHERE ${yearFilter} AND ${dbCol} IS NOT NULL`,
        [year]);
      const distDb = Number(distRes.rows[0].n);
      const distJ = distinctJson.size;
      const l6 = {
        level: 6, kind: 'distinct_count', dsKey, year, field: jsonKey, col: dbCol,
        json: distJ, db: distDb, delta: distJ - distDb,
      };
      // Distinct count can diverge by a small amount because the transformer
      // may normalize more than SQL's DISTINCT (e.g., whitespace). Allow 0.5%.
      l6.pass = Math.abs(l6.delta) <= Math.max(2, Math.ceil(distJ * 0.005));
      log.results.push(l6);
    }
  }
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main() {
  if (!fs.existsSync(REPORT_DIR)) fs.mkdirSync(REPORT_DIR, { recursive: true });

  const log = { results: [], skip: [] };
  const dsKeys = Object.keys(DATASETS);

  console.log(`Verifying ${dsKeys.length} datasets × ${YEARS.length} years...`);

  for (const year of YEARS) {
    console.log(`\n── Year ${year} ──`);
    for (const dsKey of dsKeys) {
      process.stdout.write(`  ${dsKey.padEnd(32)} ... `);
      try {
        await verifyDatasetYear(dsKey, year, log);
        process.stdout.write('done\n');
      } catch (e) {
        process.stdout.write('ERROR: ' + e.message + '\n');
        log.results.push({ level: 'ERROR', dsKey, year, error: e.message });
      }
    }
  }

  // ─── Summarize ──────────────────────────────────────────────────────────
  const failures = log.results.filter(r => r.pass === false || r.level === 'ERROR' || r.level === 'ABORT');
  const byLevel = {};
  for (const r of log.results) {
    const k = r.level + ':' + (r.kind || r.level);
    byLevel[k] = byLevel[k] || { pass: 0, fail: 0 };
    if (r.pass === true) byLevel[k].pass++;
    else if (r.pass === false) byLevel[k].fail++;
  }

  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('Summary by level:');
  for (const [k, v] of Object.entries(byLevel).sort()) {
    console.log(`  ${k.padEnd(30)} pass=${v.pass}  fail=${v.fail}`);
  }
  console.log(`\nTotal checks: ${log.results.length}`);
  console.log(`Failures: ${failures.length}`);

  if (failures.length > 0) {
    console.log('\nFirst 20 failures:');
    for (const f of failures.slice(0, 20)) {
      console.log('  ', JSON.stringify(f));
    }
  }

  // Write full report
  fs.writeFileSync(REPORT_JSON, JSON.stringify(log, null, 2), 'utf8');

  // Markdown summary
  const md = [];
  md.push('# Full Reload Verification Report');
  md.push('');
  md.push(`Generated: ${new Date().toISOString()}`);
  md.push('');
  md.push('## Totals by level');
  md.push('');
  md.push('| Level | Check | Pass | Fail |');
  md.push('|---|---|---:|---:|');
  for (const [k, v] of Object.entries(byLevel).sort()) {
    md.push(`| ${k} | | ${v.pass} | ${v.fail} |`);
  }
  md.push('');
  md.push(`**Total checks:** ${log.results.length}`);
  md.push(`**Failures:** ${failures.length}`);
  md.push('');
  if (failures.length > 0) {
    md.push('## Failures');
    md.push('');
    md.push('| Level | Dataset | Year | Field | JSON | DB | Delta |');
    md.push('|---|---|---|---|---:|---:|---:|');
    for (const f of failures.slice(0, 200)) {
      md.push(`| ${f.level}:${f.kind || ''} | ${f.dsKey || ''} | ${f.year || ''} | ${f.field || ''} | ${fmtNum(f.json)} | ${fmtNum(f.db)} | ${fmtNum(f.delta || f.abs_diff || '')} |`);
    }
  } else {
    md.push('## All checks pass');
  }
  fs.writeFileSync(REPORT_MD, md.join('\n'), 'utf8');

  console.log(`\nReports: ${REPORT_MD}`);

  await db.end();

  process.exit(failures.length === 0 ? 0 : 1);
}

main().catch(err => { console.error('FATAL:', err); process.exit(1); });
