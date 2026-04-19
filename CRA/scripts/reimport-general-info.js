/**
 * One-off: reimport general_info for all years after adding
 * program_description_1/2/3 columns.
 */
const db = require('../lib/db');
const api = require('../lib/api-client');
const {
  cleanString, parseDate, parseInteger, yesNoToBool, parseDecimal,
  sqlStr, sqlVal,
} = require('../lib/transformers');

const BATCH = 1000;

const boolFields = [
  '1570','1600','1800','2000','2100','2400',
  '2500','2510','2530','2540','2550','2560','2570','2575','2580','2590',
  '2600','2610','2620','2630','2640','2650',
  '2700','2730','2740','2750','2760','2770','2780','2800',
  '3200','3400','3900','4000','5800','5810','5820','5830',
  '5840','5841','5850','5860',
];
const decimalFields = ['5030','5031','5032','5450','5460','5843','5862','5863','5864'];
const integerFields = ['5842','5861'];
const textFields = ['2660','2790'];
const internalDivisions = ['1510-01','1510-02','1510-03','1510-04','1510-05'];

function processRow(rec) {
  const bn = cleanString(rec['BN']);
  const fpe = parseDate(rec['FPE']);
  if (!bn || !fpe) return null;

  const row = {
    bn, fpe,
    form_id: parseInteger(rec['Form ID'] || rec['FormID']),
    program_area_1: cleanString(rec['Program Area 1'] || rec['Program #1 Code']),
    program_area_2: cleanString(rec['Program Area 2'] || rec['Program #2 Code']),
    program_area_3: cleanString(rec['Program Area 3'] || rec['Program #3 Code']),
    program_percentage_1: parseInteger(rec['% 1'] ?? rec['Program #1 %']),
    program_percentage_2: parseInteger(rec['% 2'] ?? rec['Program #2 %']),
    program_percentage_3: parseInteger(rec['% 3'] ?? rec['Program #3 %']),
    program_description_1: cleanString(rec['Program #1 Desc']),
    program_description_2: cleanString(rec['Program #2 Desc']),
    program_description_3: cleanString(rec['Program #3 Desc']),
    field_1510_subordinate: yesNoToBool(rec['1510']),
    field_1510_parent_bn: cleanString(rec['1510-BN']),
    field_1510_parent_name: cleanString(rec['1510-Name']),
  };
  for (const d of internalDivisions) {
    row[`internal_division_${d.replace('-', '_')}`] = parseInteger(rec[d]);
  }
  for (const f of boolFields)    row[`field_${f}`] = yesNoToBool(rec[f]);
  for (const f of decimalFields) row[`field_${f}`] = parseDecimal(rec[f]);
  for (const f of integerFields) row[`field_${f}`] = parseInteger(rec[f]);
  for (const f of textFields)    row[`field_${f}`] = cleanString(rec[f]);
  return row;
}

async function main() {
  const client = await db.getClient();
  try {
    await client.query('SET statement_timeout = 600000');
    for (const year of [2020, 2021, 2022, 2023, 2024]) {
      const cache = api.loadCache(year, 'general_info');
      if (!cache) { console.log(year + ': no cache'); continue; }
      const records = cache.records;
      console.log(year + ': loading ' + records.length + ' records');
      let total = 0;
      for (let i = 0; i < records.length; i += BATCH) {
        const batch = records.slice(i, i + BATCH);
        const rows = [];
        for (const r of batch) { const p = processRow(r); if (p) rows.push(p); }
        if (rows.length === 0) continue;
        const keys = Object.keys(rows[0]);
        const columns = keys.join(', ');
        const values = rows.map(r => {
          const vals = keys.map(k => {
            const v = r[k];
            if (v === null || v === undefined) return 'NULL';
            if (typeof v === 'boolean') return v.toString();
            if (typeof v === 'number') return v;
            return sqlStr(v);
          });
          return `(${vals.join(', ')})`;
        }).join(',\n');
        await client.query(`INSERT INTO cra_financial_general (${columns}) VALUES ${values} ON CONFLICT (bn, fpe) DO NOTHING`);
        total += rows.length;
        if (total % 20000 < BATCH) console.log(`  ${year}: ${total.toLocaleString()} rows`);
      }
      console.log(`  ${year}: done — ${total.toLocaleString()} rows`);
    }
  } finally {
    client.release();
    await db.end();
  }
}
main().catch(err => { console.error(err); process.exit(1); });
