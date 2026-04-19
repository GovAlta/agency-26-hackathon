/**
 * 04-json-vs-db-audit.js
 *
 * Field-by-field audit of cached JSON (Government of Canada open data) vs
 * PostgreSQL database for random samples of charities from 2020 and 2024.
 *
 * Goal: verify that every value in the cached JSON survives intact into the DB
 * after the 2024 T3010 form revision, and flag any misaligned or missing fields.
 *
 * Output:
 *   - Stdout summary (counts of mismatches by dataset)
 *   - data/reports/json-vs-db-audit.json (full detailed report)
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

const SAMPLE_SIZE = 20;
const YEARS = [2020, 2024];
const REPORT_DIR = path.join(__dirname, '..', '..', 'data', 'reports');
const REPORT_FILE = path.join(REPORT_DIR, 'json-vs-db-audit.json');

// ─── Dataset map: JSON key → DB column, with transform ──────────────────────
//
// Each entry describes one API dataset and how its JSON keys map to the
// matching cra_* table row(s). `match` names the key fields that identify
// a row (bn + fpe, or bn + fiscal_year, or bn + fpe + seq, etc.). The
// `fields` list pairs every DB column name with the JSON key it should come
// from plus the transform the import applies.

const DATASETS = {
  identification: {
    table: 'cra_identification',
    keyType: 'year',                          // rows keyed by (bn, fiscal_year)
    fields: [
      ['category', 'Category', 'string'],
      ['sub_category', 'Sub Category', 'string'],
      ['designation', 'Designation', 'string'],
      ['legal_name', 'Legal Name', 'string'],
      ['account_name', 'Account Name', 'string'],
      ['address_line_1', 'Address Line 1', 'string'],
      ['address_line_2', 'Address Line 2', 'string'],
      ['city', 'City', 'string'],
      ['province', 'Province', 'code2'],
      ['postal_code', 'Postal Code', 'string'],
      ['country', 'Country', 'code2'],
    ],
  },

  directors: {
    table: 'cra_directors',
    keyType: 'fpe_seq',
    fields: [
      ['form_id', 'Form ID', 'int'],
      ['last_name', 'Last Name', 'string'],
      ['first_name', 'First Name', 'string'],
      ['initials', 'Initials', 'string'],
      ['position', 'Position', 'string'],
      ['at_arms_length', "At Arm's Length", 'bool'],
      ['start_date', 'Start Date', 'date'],
      ['end_date', 'End Date', 'date'],
    ],
  },

  financial_data: {
    table: 'cra_financial_details',
    keyType: 'fpe',
    fields: [
      ['form_id', 'Form ID', 'int'],
      ['section_used', 'Section Used', 'string'],
      ['field_4020', '4020', 'string'],
      ['field_4050', '4050', 'bool'],
      // Amount fields
      ...[
        '4100','4101','4102','4110','4120','4130','4140','4150','4155','4157','4158',
        '4160','4165','4166','4170','4180','4190','4200','4250','4300','4310','4320',
        '4330','4350','4500','4505','4510','4530','4540','4550','4560',
        '4570','4571','4575','4576','4577','4580','4590','4600','4610','4620','4630','4640',
        '4650','4700','4800','4810','4820','4830','4840','4850','4860','4870',
        '4880','4890','4891','4900','4910','4920','4950','5000','5010','5020',
        '5030','5040','5045','5050','5100','5500','5510','5610','5750','5900','5910',
      ].map(f => [`field_${f}`, f, 'decimal']),
      ...['4400','4490','4565'].map(f => [`field_${f}`, f, 'bool']),
      // Text "specify" fields (Text 175 per dictionary)
      ['field_4655', '4655', 'string'],
      ['field_4930', '4930', 'string'],
    ],
  },

  general_info: {
    table: 'cra_financial_general',
    keyType: 'fpe',
    fields: [
      ['form_id', 'Form ID', 'int'],
      ['program_area_1', 'Program #1 Code', 'string'],
      ['program_area_2', 'Program #2 Code', 'string'],
      ['program_area_3', 'Program #3 Code', 'string'],
      ['program_percentage_1', 'Program #1 %', 'int'],
      ['program_percentage_2', 'Program #2 %', 'int'],
      ['program_percentage_3', 'Program #3 %', 'int'],
      ['program_description_1', 'Program #1 Desc', 'string'],
      ['program_description_2', 'Program #2 Desc', 'string'],
      ['program_description_3', 'Program #3 Desc', 'string'],
      ['field_1510_subordinate', '1510', 'bool'],
      ['field_1510_parent_bn', '1510-BN', 'string'],
      ['field_1510_parent_name', '1510-Name', 'string'],
      // Y/N flags per dictionary §3.6
      ...[
        '1570','1600','1800','2000','2100','2400',
        '2500','2510','2530','2540','2550','2560','2570','2575','2580','2590',
        '2600','2610','2620','2630','2640','2650',
        '2700','2730','2740','2750','2760','2770','2780','2800',
        '3200','3400','3900','4000','5800','5810','5820','5830',
        '5840','5841','5850','5860',
      ].map(f => [`field_${f}`, f, 'bool']),
      // Decimal Amount fields
      ...['5030','5031','5032','5450','5460','5843','5862','5863','5864']
        .map(f => [`field_${f}`, f, 'decimal']),
      // Integer Number fields
      ...['5842','5861'].map(f => [`field_${f}`, f, 'int']),
      // Text "specify" fields
      ['field_2660', '2660', 'string'],
      ['field_2790', '2790', 'string'],
    ],
  },

  charitable_programs: {
    table: 'cra_charitable_programs',
    keyType: 'fpe_prog_type',
    fields: [
      ['form_id', 'Form ID', 'int'],
      ['description', 'Description', 'string'],
    ],
  },

  non_qualified_donees: {
    table: 'cra_non_qualified_donees',
    keyType: 'fpe_seq',
    fields: [
      ['form_id', 'Form ID', 'int'],
      ['recipient_name', 'Recipient name', 'string'],
      ['purpose', 'Purpose', 'string'],
      ['cash_amount', 'Cash amount', 'decimal'],
      ['non_cash_amount', 'Non-cash amount', 'decimal'],
      // "Grant Country" is Text 125 per dictionary §3.18, not a 2-char code.
      ['country', 'Country', 'string'],
    ],
  },

  qualified_donees: {
    table: 'cra_qualified_donees',
    keyType: 'fpe_seq',
    fields: [
      ['form_id', 'Form ID', 'int'],
      ['donee_bn', 'Donee BN', 'string'],
      ['donee_name', 'Donee Name', 'string'],
      ['associated', 'Associated', 'bool'],
      ['city', 'City', 'string'],
      ['province', 'Province', 'code2'],
      ['total_gifts', 'Total Gifts', 'decimal'],
      ['gifts_in_kind', 'Gifts in Kind', 'decimal'],
      ['political_activity_gift', 'Political Activity Gift', 'bool'],
      ['political_activity_amount', 'Political Activity Amount', 'decimal'],
    ],
  },

  foundation_info: {
    table: 'cra_foundation_info',
    keyType: 'fpe',
    fields: [
      ['form_id', 'Form ID', 'int'],
      // 100/110/120/130 are Y/N; 111/112 are Amount 17 (v27+)
      ...['100','110','120','130'].map(f => [`field_${f}`, f, 'bool']),
      ...['111','112'].map(f => [`field_${f}`, f, 'decimal']),
    ],
  },

  activities_outside_countries: {
    table: 'cra_activities_outside_countries',
    keyType: 'fpe_seq',
    fields: [
      ['form_id', 'Form ID', 'int'],
      ['country', 'Country', 'code2'],
    ],
  },

  activities_outside_details: {
    table: 'cra_activities_outside_details',
    keyType: 'fpe',
    fields: [
      ['form_id', 'Form ID', 'int'],
      ['field_200', '200', 'decimal'],
      ['field_210', '210', 'bool'],
      ['field_220', '220', 'bool'],
      ['field_230', '230', 'string'],
      ['field_240', '240', 'bool'],
      ['field_250', '250', 'bool'],
      ['field_260', '260', 'bool'],
    ],
  },

  exported_goods: {
    table: 'cra_exported_goods',
    keyType: 'fpe_seq',
    fields: [
      ['form_id', 'Form ID', 'int'],
      ['item_name', 'Item Name', 'string'],
      ['item_value', 'Item Value', 'decimal'],
      ['destination', 'Destination', 'string'],
      ['country', 'Country', 'code2'],
    ],
  },

  resources_sent_outside: {
    table: 'cra_resources_sent_outside',
    keyType: 'fpe_seq',
    fields: [
      ['form_id', 'Form ID', 'int'],
      ['individual_org_name', 'Indiv/Org Name', 'string'],
      ['amount', 'Amount', 'decimal'],
      ['country', 'Country', 'code2'],
    ],
  },

  compensation: {
    table: 'cra_compensation',
    keyType: 'fpe',
    fields: [
      ['form_id', 'Form ID', 'int'],
      ...['300','305','310','315','320','325','330','335','340','345','370'].map(f => [`field_${f}`, f, 'int']),
      ...['380','390'].map(f => [`field_${f}`, f, 'decimal']),
    ],
  },

  gifts_in_kind: {
    table: 'cra_gifts_in_kind',
    keyType: 'fpe',
    fields: [
      ['form_id', 'Form ID', 'int'],
      // All of 500–560 are Y/N per CRA Open Data Dictionary §3.14.
      ...['500','505','510','515','520','525','530','535','540','545','550','555','560']
        .map(f => [`field_${f}`, f, 'bool']),
      ['field_565', '565', 'string'],   // Text 175 "Other: specify"
      ['field_580', '580', 'decimal'],  // Amount 14
    ],
  },

  political_activity_description: {
    table: 'cra_political_activity_desc',
    keyType: 'fpe',
    fields: [
      ['form_id', 'Form ID', 'int'],
      ['description', 'Description', 'string'],
    ],
  },

  political_activity_funding: {
    table: 'cra_political_activity_funding',
    keyType: 'fpe_seq',
    fields: [
      ['form_id', 'Form ID', 'int'],
      ['activity', 'Activity', 'string'],
      ['amount', 'Amount', 'decimal'],
      ['country', 'Country', 'code2'],
    ],
  },

  political_activity_resources: {
    table: 'cra_political_activity_resources',
    keyType: 'fpe_seq',
    fields: [
      ['form_id', 'Form ID', 'int'],
      ['staff', 'Staff', 'int'],
      ['volunteers', 'Volunteers', 'int'],
      ['financial', 'Financial', 'decimal'],
      ['property', 'Property', 'decimal'],
      ['other_resource', 'Other', 'string'],
    ],
  },

  disbursement_quota: {
    table: 'cra_disbursement_quota',
    keyType: 'fpe',
    fields: [
      ['form_id', 'Form ID', 'int'],
      ...['805','810','815','820','825','830','835','840','845','850',
          '855','860','865','870','875','880','885','890'].map(f => [`field_${f}`, f, 'decimal']),
    ],
  },

  web_urls: {
    table: 'cra_web_urls',
    keyType: 'year_seq',
    fields: [
      ['contact_url', 'Contact URL', 'string'],
    ],
  },
};

// ─── Transform helpers (match the import script's semantics) ────────────────

function transformValue(raw, type) {
  switch (type) {
    case 'string': return cleanString(raw);
    case 'code2':  return cleanCode2(raw);
    case 'int':    return parseInteger(raw);
    case 'decimal': {
      const n = parseDecimal(raw);
      return n === null ? null : Number(n);
    }
    case 'bool':   return yesNoToBool(raw);
    case 'date':   return parseDate(raw);
    default:       return raw;
  }
}

function normalizeDbValue(v, type) {
  if (v === null || v === undefined) return null;
  switch (type) {
    case 'decimal': return Number(v);
    case 'int':     return Number(v);
    case 'bool':    return v === true || v === 't' || v === 'true';
    case 'date': {
      if (v instanceof Date) {
        // DB returns Date in local TZ but the stored value is a pg DATE —
        // format it as YYYY-MM-DD so it compares to the string from parseDate.
        const y = v.getFullYear();
        const m = String(v.getMonth() + 1).padStart(2, '0');
        const d = String(v.getDate()).padStart(2, '0');
        return `${y}-${m}-${d}`;
      }
      return String(v).slice(0, 10);
    }
    case 'string':
    case 'code2':
    default:
      return typeof v === 'string' ? v.trim() : v;
  }
}

function valuesEqual(a, b, type) {
  if (a === null && b === null) return true;
  if (a === null || b === null) return false;
  if (type === 'decimal') {
    return Math.abs(Number(a) - Number(b)) < 1e-6;
  }
  // Normalize dates on both sides (import normalizes to YYYY-MM-DD or YYYY/MM/DD)
  if (type === 'date') {
    return String(a).replace(/\//g, '-') === String(b).replace(/\//g, '-');
  }
  return a === b;
}

// ─── Sampling ───────────────────────────────────────────────────────────────

function randomSample(arr, n) {
  const copy = [...arr];
  const out = [];
  const max = Math.min(n, copy.length);
  for (let i = 0; i < max; i++) {
    const idx = Math.floor(Math.random() * copy.length);
    out.push(copy.splice(idx, 1)[0]);
  }
  return out;
}

// ─── Build indexes from JSON cache ──────────────────────────────────────────

function groupByBn(records) {
  const map = new Map();
  for (const r of records) {
    const bn = cleanString(r.BN || r['BN/NE']);
    if (!bn) continue;
    if (!map.has(bn)) map.set(bn, []);
    map.get(bn).push(r);
  }
  return map;
}

// ─── Audit a single charity for a single dataset ───────────────────────────

async function auditCharityDataset(year, bn, datasetKey, jsonRecords, discrepancies, stats) {
  const def = DATASETS[datasetKey];
  if (!def) return;

  const table = def.table;
  const dsStats = stats[datasetKey] || { jsonRows: 0, dbRows: 0, fieldChecks: 0, mismatches: 0, missingInDb: 0, extraInDb: 0 };
  stats[datasetKey] = dsStats;

  // Pull DB rows for this BN + year
  let dbRows = [];
  try {
    if (def.keyType === 'year' || def.keyType === 'year_seq') {
      const r = await db.query(`SELECT * FROM ${table} WHERE bn = $1 AND fiscal_year = $2`, [bn, year]);
      dbRows = r.rows;
    } else {
      // rows keyed by fpe — we want rows where the fpe falls within the fiscal_year
      // scope. The API cache groups by fiscal_year, so each JSON row's FPE should
      // match the same filing. Pull rows whose fpe appears in jsonRecords.
      const fpes = [...new Set(jsonRecords.map(r => parseDate(r.FPE)).filter(Boolean))];
      if (fpes.length === 0) {
        dbRows = [];
      } else {
        const r = await db.query(`SELECT * FROM ${table} WHERE bn = $1 AND fpe = ANY($2::date[])`, [bn, fpes]);
        dbRows = r.rows;
      }
    }
  } catch (e) {
    dsStats.mismatches++;
    discrepancies.push({
      year, bn, dataset: datasetKey, kind: 'db_query_error', message: e.message,
    });
    return;
  }

  dsStats.jsonRows += jsonRecords.length;
  dsStats.dbRows += dbRows.length;

  // Match JSON rows to DB rows by the natural key.
  function keyOfJson(r) {
    const fpe = parseDate(r.FPE);
    const seq = parseInteger(r['#']);
    const progType = cleanString(r['Program Type'] || r['ProgramType']);
    switch (def.keyType) {
      case 'year':        return `${bn}|${year}`;
      case 'year_seq':    return `${bn}|${year}|${seq}`;
      case 'fpe':         return `${bn}|${fpe}`;
      case 'fpe_seq':     return `${bn}|${fpe}|${seq}`;
      case 'fpe_prog_type': return `${bn}|${fpe}|${progType}`;
      default:            return `${bn}`;
    }
  }
  function keyOfDb(row) {
    switch (def.keyType) {
      case 'year':        return `${row.bn}|${row.fiscal_year}`;
      case 'year_seq':    return `${row.bn}|${row.fiscal_year}|${row.sequence_number}`;
      case 'fpe': {
        const fpe = normalizeDbValue(row.fpe, 'date');
        return `${row.bn}|${fpe}`;
      }
      case 'fpe_seq': {
        const fpe = normalizeDbValue(row.fpe, 'date');
        return `${row.bn}|${fpe}|${row.sequence_number}`;
      }
      case 'fpe_prog_type': {
        const fpe = normalizeDbValue(row.fpe, 'date');
        return `${row.bn}|${fpe}|${row.program_type}`;
      }
      default:            return `${row.bn}`;
    }
  }

  const jsonByKey = new Map();
  for (const r of jsonRecords) {
    const k = keyOfJson(r);
    // When identification has multi-record duplication, the last record wins.
    // (In practice we only ever see one identification row per (bn,year).)
    jsonByKey.set(k, r);
  }
  const dbByKey = new Map();
  for (const r of dbRows) dbByKey.set(keyOfDb(r), r);

  // Rows in JSON but not DB (or vice-versa).
  for (const [k, r] of jsonByKey) {
    if (!dbByKey.has(k)) {
      dsStats.missingInDb++;
      discrepancies.push({ year, bn, dataset: datasetKey, kind: 'json_row_missing_from_db', key: k });
    }
  }
  for (const [k, r] of dbByKey) {
    if (!jsonByKey.has(k)) {
      dsStats.extraInDb++;
      discrepancies.push({ year, bn, dataset: datasetKey, kind: 'db_row_not_in_json', key: k });
    }
  }

  // Field-by-field compare where both sides have the row.
  for (const [k, jr] of jsonByKey) {
    const dr = dbByKey.get(k);
    if (!dr) continue;
    for (const [col, jsonKey, type] of def.fields) {
      const jsonVal = transformValue(jr[jsonKey], type);
      const dbVal = normalizeDbValue(dr[col], type);
      dsStats.fieldChecks++;
      if (!valuesEqual(jsonVal, dbVal, type)) {
        dsStats.mismatches++;
        discrepancies.push({
          year, bn, dataset: datasetKey, kind: 'field_mismatch',
          key: k, column: col, jsonKey, type,
          jsonRaw: jr[jsonKey], jsonNormalized: jsonVal, db: dbVal,
        });
      }
    }

    // Also check: are there JSON keys on this row that are NOT in the mapping?
    // (Flags dropped 2024 fields.)
    const mappedJsonKeys = new Set(def.fields.map(([, j]) => j));
    // Keys that are part of the composite key:
    mappedJsonKeys.add('_id').add('BN').add('FPE').add('Form ID').add('#');
    if (datasetKey === 'charitable_programs') mappedJsonKeys.add('Program Type');
    for (const jk of Object.keys(jr)) {
      if (!mappedJsonKeys.has(jk)) {
        const v = jr[jk];
        // Only flag if there's an actual value (ignore trivially empty)
        if (v !== null && v !== undefined && v !== '') {
          dsStats.mismatches++;
          discrepancies.push({
            year, bn, dataset: datasetKey, kind: 'unmapped_json_field',
            key: k, jsonKey: jk, jsonValue: v,
          });
        }
      }
    }
  }
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main() {
  if (!fs.existsSync(REPORT_DIR)) fs.mkdirSync(REPORT_DIR, { recursive: true });

  const report = {
    generatedAt: new Date().toISOString(),
    sampleSize: SAMPLE_SIZE,
    years: YEARS,
    byYear: {},
    stats: {},
  };

  // Step 1: pick random BNs from each year's identification JSON.
  const sampled = {};
  for (const year of YEARS) {
    const idCache = apiClient.loadCache(year, 'identification');
    if (!idCache) throw new Error(`Missing identification cache for ${year}`);
    const bns = [...new Set(idCache.records.map(r => cleanString(r.BN || r['BN/NE'])).filter(Boolean))];
    const chosen = randomSample(bns, SAMPLE_SIZE);
    sampled[year] = chosen;
    console.log(`Sampled ${chosen.length} BNs from ${year}:`);
    for (const bn of chosen) console.log('  ', bn);
  }

  // Step 2: load every dataset's JSON once, index by BN.
  console.log('\nLoading and indexing JSON caches...');
  const indexes = {};
  for (const year of YEARS) {
    indexes[year] = {};
    for (const ds of Object.keys(DATASETS)) {
      const cache = apiClient.loadCache(year, ds);
      if (!cache || !cache.records) {
        indexes[year][ds] = new Map();
        continue;
      }
      indexes[year][ds] = groupByBn(cache.records);
    }
  }

  // Step 3: for each sampled BN, compare every dataset.
  const discrepancies = [];
  const stats = { _all: { bns: 0 } };
  for (const year of YEARS) {
    console.log(`\nAuditing ${year}...`);
    for (const bn of sampled[year]) {
      stats._all.bns++;
      for (const ds of Object.keys(DATASETS)) {
        const byBn = indexes[year][ds];
        const recs = byBn.get(bn) || [];
        await auditCharityDataset(year, bn, ds, recs, discrepancies, stats);
      }
    }
  }

  // Step 4: summarize.
  report.byYear = sampled;
  report.stats = stats;
  report.discrepancyCount = discrepancies.length;
  report.discrepancies = discrepancies;

  fs.writeFileSync(REPORT_FILE, JSON.stringify(report, null, 2), 'utf8');

  console.log('\n───────────────────────────────────────────────');
  console.log('JSON vs DB Audit — Summary');
  console.log('───────────────────────────────────────────────');
  console.log(`BNs checked: ${stats._all.bns} (${SAMPLE_SIZE} per year × ${YEARS.length} years)`);
  console.log('\nPer-dataset stats:');
  console.log('dataset                           jsonRows  dbRows  fieldChecks  mismatches  missingInDB  extraInDB');
  for (const ds of Object.keys(DATASETS)) {
    const s = stats[ds] || { jsonRows: 0, dbRows: 0, fieldChecks: 0, mismatches: 0, missingInDb: 0, extraInDb: 0 };
    console.log(
      ds.padEnd(34) +
      String(s.jsonRows).padStart(8) +
      String(s.dbRows).padStart(8) +
      String(s.fieldChecks).padStart(13) +
      String(s.mismatches).padStart(12) +
      String(s.missingInDb).padStart(13) +
      String(s.extraInDb).padStart(11)
    );
  }
  console.log(`\nTotal discrepancies: ${discrepancies.length}`);

  // Breakdown by kind
  const byKind = {};
  for (const d of discrepancies) byKind[d.kind] = (byKind[d.kind] || 0) + 1;
  console.log('By kind:');
  for (const [k, v] of Object.entries(byKind)) console.log(`  ${k}: ${v}`);

  console.log(`\nFull report: ${REPORT_FILE}`);
  await db.end();
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
