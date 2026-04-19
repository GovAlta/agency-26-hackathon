/**
 * build-crosswalk.js — Generate a comprehensive source → database crosswalk
 * for all 19 CRA T3010 datasets.
 *
 * For each dataset:
 *   - Lists every source key observed in cached API responses (all 5 years)
 *   - Lists every target column in the corresponding Postgres table
 *   - Maps source key → target column with the transform function used
 *   - Flags UNMAPPED source keys (potential data loss)
 *   - Flags UNPOPULATED target columns (potential schema drift)
 *   - Records per-column non-null counts in both source and target
 *
 * Outputs: CRA/data/reports/crosswalk/cra-crosswalk.json
 */

const fs = require('fs');
const path = require('path');
const { Client } = require('pg');
require('dotenv').config({ path: path.join(__dirname, '..', '..', 'FED', '.env.public') });

const inventory = require(path.join(__dirname, '..', 'config', 'dataset-inventory.json'));

// Explicit mapping derived from scripts/04-import-data.js — every source→target
// pair that the importer uses, with the transform function.
// This is the single source of truth for the ingestion logic.
const IMPORT_MAP = {
  identification: {
    table: 'cra_identification',
    pk: ['bn', 'fiscal_year'],
    mappings: [
      { src: 'BN',             dst: 'bn',             transform: 'cleanString' },
      { src: '__SYNTHESIZED__', dst: 'fiscal_year',    transform: 'year from filename/run' },
      { src: 'Category',       dst: 'category',       transform: 'cleanString' },
      { src: 'Sub Category',   dst: 'sub_category',   transform: 'cleanString' },
      { src: 'Designation',    dst: 'designation',    transform: 'cleanString' },
      { src: 'Legal Name',     dst: 'legal_name',     transform: 'cleanString' },
      { src: 'Account Name',   dst: 'account_name',   transform: 'cleanString' },
      { src: 'Address Line 1', dst: 'address_line_1', transform: 'cleanString' },
      { src: 'Address Line 2', dst: 'address_line_2', transform: 'cleanString' },
      { src: 'City',           dst: 'city',           transform: 'cleanString' },
      { src: 'Province',       dst: 'province',       transform: 'cleanCode2' },
      { src: 'Postal Code',    dst: 'postal_code',    transform: 'cleanString' },
      { src: 'Country',        dst: 'country',        transform: 'cleanCode2' },
    ],
  },
  directors: {
    table: 'cra_directors',
    pk: ['bn', 'fpe', 'sequence_number'],
    mappings: [
      { src: 'BN',             dst: 'bn',              transform: 'cleanString' },
      { src: 'FPE',            dst: 'fpe',             transform: 'parseDate' },
      { src: 'Form ID',        dst: 'form_id',         transform: 'parseInteger' },
      { src: '#',              dst: 'sequence_number', transform: 'parseInteger' },
      { src: 'Last Name',      dst: 'last_name',       transform: 'cleanString' },
      { src: 'First Name',     dst: 'first_name',      transform: 'cleanString' },
      { src: 'Initials',       dst: 'initials',        transform: 'cleanString' },
      { src: 'Position',       dst: 'position',        transform: 'cleanString' },
      { src: "At Arm's Length", dst: 'at_arms_length', transform: 'yesNoToBool' },
      { src: 'Start Date',     dst: 'start_date',      transform: 'parseDate' },
      { src: 'End Date',       dst: 'end_date',        transform: 'parseDate' },
    ],
  },
  financial_data: {
    table: 'cra_financial_details',
    pk: ['bn', 'fpe'],
    mappings: (() => {
      const numericFields = ['4100','4101','4102','4110','4120','4130','4140','4150','4155','4157','4158','4160','4165','4166','4170','4180','4190','4200','4250','4300','4310','4320','4330','4350','4500','4505','4510','4530','4540','4550','4560','4570','4571','4575','4576','4577','4580','4590','4600','4610','4620','4630','4640','4650','4700','4800','4810','4820','4830','4840','4850','4860','4870','4880','4890','4891','4900','4910','4920','4950','5000','5010','5020','5030','5040','5045','5050','5100','5500','5510','5610','5750','5900','5910'];
      const boolFields = ['4400','4490','4565'];
      const textFields = ['4655','4930'];
      const base = [
        { src: 'BN',         dst: 'bn',            transform: 'cleanString' },
        { src: 'FPE',        dst: 'fpe',           transform: 'parseDate' },
        { src: 'FormID|Form ID', dst: 'form_id',   transform: 'parseInteger' },
        { src: 'SectionUsed|Section Used', dst: 'section_used', transform: 'cleanString' },
        { src: '4020',       dst: 'field_4020',    transform: 'cleanString' },
        { src: '4050',       dst: 'field_4050',    transform: 'yesNoToBool' },
      ];
      for (const f of numericFields) base.push({ src: f, dst: `field_${f}`, transform: 'parseDecimal' });
      for (const f of boolFields)    base.push({ src: f, dst: `field_${f}`, transform: 'yesNoToBool' });
      for (const f of textFields)    base.push({ src: f, dst: `field_${f}`, transform: 'cleanString' });
      return base;
    })(),
  },
  general_info: {
    table: 'cra_financial_general',
    pk: ['bn', 'fpe'],
    mappings: (() => {
      const boolFields = ['1570','1600','1800','2000','2100','2400','2500','2510','2530','2540','2550','2560','2570','2575','2580','2590','2600','2610','2620','2630','2640','2650','2700','2730','2740','2750','2760','2770','2780','2800','3200','3400','3900','4000','5800','5810','5820','5830','5840','5841','5850','5860'];
      const decimalFields = ['5030','5031','5032','5450','5460','5843','5862','5863','5864'];
      const integerFields = ['5842','5861'];
      const textFields = ['2660','2790'];
      const internalDivisions = ['1510-01','1510-02','1510-03','1510-04','1510-05'];
      const base = [
        { src: 'BN',  dst: 'bn',  transform: 'cleanString' },
        { src: 'FPE', dst: 'fpe', transform: 'parseDate' },
        { src: 'Form ID|FormID', dst: 'form_id', transform: 'parseInteger' },
        { src: 'Program Area 1|Program #1 Code', dst: 'program_area_1', transform: 'cleanString' },
        { src: 'Program Area 2|Program #2 Code', dst: 'program_area_2', transform: 'cleanString' },
        { src: 'Program Area 3|Program #3 Code', dst: 'program_area_3', transform: 'cleanString' },
        { src: '% 1|Program #1 %', dst: 'program_percentage_1', transform: 'parseInteger' },
        { src: '% 2|Program #2 %', dst: 'program_percentage_2', transform: 'parseInteger' },
        { src: '% 3|Program #3 %', dst: 'program_percentage_3', transform: 'parseInteger' },
        { src: 'Program #1 Desc', dst: 'program_description_1', transform: 'cleanString' },
        { src: 'Program #2 Desc', dst: 'program_description_2', transform: 'cleanString' },
        { src: 'Program #3 Desc', dst: 'program_description_3', transform: 'cleanString' },
        { src: '1510',    dst: 'field_1510_subordinate', transform: 'yesNoToBool' },
        { src: '1510-BN', dst: 'field_1510_parent_bn',   transform: 'cleanString' },
        { src: '1510-Name', dst: 'field_1510_parent_name', transform: 'cleanString' },
      ];
      for (const d of internalDivisions) base.push({ src: d, dst: `internal_division_${d.replace('-', '_')}`, transform: 'parseInteger' });
      for (const f of boolFields)    base.push({ src: f, dst: `field_${f}`, transform: 'yesNoToBool' });
      for (const f of decimalFields) base.push({ src: f, dst: `field_${f}`, transform: 'parseDecimal' });
      for (const f of integerFields) base.push({ src: f, dst: `field_${f}`, transform: 'parseInteger' });
      for (const f of textFields)    base.push({ src: f, dst: `field_${f}`, transform: 'cleanString' });
      return base;
    })(),
  },
  charitable_programs: {
    table: 'cra_charitable_programs',
    pk: ['bn', 'fpe', 'program_type'],
    mappings: [
      { src: 'BN',  dst: 'bn',  transform: 'cleanString' },
      { src: 'FPE', dst: 'fpe', transform: 'parseDate' },
      { src: 'FormID|Form ID', dst: 'form_id', transform: 'parseInteger' },
      { src: 'Program Type|ProgramType', dst: 'program_type', transform: 'cleanString' },
      { src: 'Description', dst: 'description', transform: 'cleanString' },
    ],
  },
  non_qualified_donees: {
    table: 'cra_non_qualified_donees',
    pk: ['bn', 'fpe', 'sequence_number'],
    mappings: [
      { src: 'BN',  dst: 'bn',  transform: 'cleanString' },
      { src: 'FPE', dst: 'fpe', transform: 'parseDate' },
      { src: 'Form ID|FormID', dst: 'form_id', transform: 'parseInteger' },
      { src: '#', dst: 'sequence_number', transform: 'parseInteger' },
      { src: 'Recipient name|Recipient Name', dst: 'recipient_name', transform: 'cleanString' },
      { src: 'Purpose', dst: 'purpose', transform: 'cleanString' },
      { src: 'Cash amount|Cash Amount', dst: 'cash_amount', transform: 'parseDecimal' },
      { src: 'Non-cash amount|Non-cash Amount|Non-Cash Amount', dst: 'non_cash_amount', transform: 'parseDecimal' },
      { src: 'Country', dst: 'country', transform: 'cleanString' },
    ],
  },
  qualified_donees: {
    table: 'cra_qualified_donees',
    pk: ['bn', 'fpe', 'sequence_number'],
    mappings: [
      { src: 'BN',  dst: 'bn',  transform: 'cleanString' },
      { src: 'FPE', dst: 'fpe', transform: 'parseDate' },
      { src: 'FormID|Form ID', dst: 'form_id', transform: 'parseInteger' },
      { src: '#', dst: 'sequence_number', transform: 'parseInteger' },
      { src: 'DoneeBN|Donee BN', dst: 'donee_bn', transform: 'cleanString' },
      { src: 'DoneeName|Donee Name', dst: 'donee_name', transform: 'cleanString' },
      { src: 'Associated', dst: 'associated', transform: 'yesNoToBool' },
      { src: 'City', dst: 'city', transform: 'cleanString' },
      { src: 'Province', dst: 'province', transform: 'cleanCode2' },
      { src: 'TotalGifts|Total Gifts', dst: 'total_gifts', transform: 'parseDecimal' },
      { src: 'GiftsinKind|Gifts in Kind', dst: 'gifts_in_kind', transform: 'parseDecimal' },
      { src: 'PoliticalActivityGift|Political Activity Gift', dst: 'political_activity_gift', transform: 'yesNoToBool' },
      { src: 'PoliticalActivityAmount|Political Activity Amount', dst: 'political_activity_amount', transform: 'parseDecimal' },
    ],
  },
  foundation_info: {
    table: 'cra_foundation_info',
    pk: ['bn', 'fpe'],
    mappings: [
      { src: 'BN',  dst: 'bn',  transform: 'cleanString' },
      { src: 'FPE', dst: 'fpe', transform: 'parseDate' },
      { src: 'Form ID|FormID', dst: 'form_id', transform: 'parseInteger' },
      { src: '100', dst: 'field_100', transform: 'yesNoToBool' },
      { src: '110', dst: 'field_110', transform: 'yesNoToBool' },
      { src: '111', dst: 'field_111', transform: 'parseDecimal' },
      { src: '112', dst: 'field_112', transform: 'parseDecimal' },
      { src: '120', dst: 'field_120', transform: 'yesNoToBool' },
      { src: '130', dst: 'field_130', transform: 'yesNoToBool' },
    ],
  },
  activities_outside_countries: {
    table: 'cra_activities_outside_countries',
    pk: ['bn', 'fpe', 'sequence_number'],
    mappings: [
      { src: 'BN',  dst: 'bn',  transform: 'cleanString' },
      { src: 'FPE', dst: 'fpe', transform: 'parseDate' },
      { src: 'Form ID|FormID', dst: 'form_id', transform: 'parseInteger' },
      { src: '#', dst: 'sequence_number', transform: 'parseInteger' },
      { src: 'Country', dst: 'country', transform: 'cleanCode2' },
    ],
  },
  activities_outside_details: {
    table: 'cra_activities_outside_details',
    pk: ['bn', 'fpe'],
    mappings: [
      { src: 'BN',  dst: 'bn',  transform: 'cleanString' },
      { src: 'FPE', dst: 'fpe', transform: 'parseDate' },
      { src: 'Form ID|FormID', dst: 'form_id', transform: 'parseInteger' },
      { src: '200', dst: 'field_200', transform: 'parseDecimal' },
      { src: '210', dst: 'field_210', transform: 'yesNoToBool' },
      { src: '220', dst: 'field_220', transform: 'yesNoToBool' },
      { src: '230', dst: 'field_230', transform: 'cleanString' },
      { src: '240', dst: 'field_240', transform: 'yesNoToBool' },
      { src: '250', dst: 'field_250', transform: 'yesNoToBool' },
      { src: '260', dst: 'field_260', transform: 'yesNoToBool' },
    ],
  },
  exported_goods: {
    table: 'cra_exported_goods',
    pk: ['bn', 'fpe', 'sequence_number'],
    mappings: [
      { src: 'BN',  dst: 'bn',  transform: 'cleanString' },
      { src: 'FPE', dst: 'fpe', transform: 'parseDate' },
      { src: 'Form ID|FormID', dst: 'form_id', transform: 'parseInteger' },
      { src: '#', dst: 'sequence_number', transform: 'parseInteger' },
      { src: 'Item Name', dst: 'item_name', transform: 'cleanString' },
      { src: 'Item Value', dst: 'item_value', transform: 'parseDecimal' },
      { src: 'Destination', dst: 'destination', transform: 'cleanString' },
      { src: 'Country', dst: 'country', transform: 'cleanCode2' },
    ],
  },
  resources_sent_outside: {
    table: 'cra_resources_sent_outside',
    pk: ['bn', 'fpe', 'sequence_number'],
    mappings: [
      { src: 'BN',  dst: 'bn',  transform: 'cleanString' },
      { src: 'FPE', dst: 'fpe', transform: 'parseDate' },
      { src: 'Form ID|FormID', dst: 'form_id', transform: 'parseInteger' },
      { src: '#', dst: 'sequence_number', transform: 'parseInteger' },
      { src: 'Indiv/Org Name|Individual/Org Name', dst: 'individual_org_name', transform: 'cleanString' },
      { src: 'Amount', dst: 'amount', transform: 'parseDecimal' },
      { src: 'Country', dst: 'country', transform: 'cleanCode2' },
    ],
  },
  compensation: {
    table: 'cra_compensation',
    pk: ['bn', 'fpe'],
    mappings: (() => {
      const intFields = ['300','305','310','315','320','325','330','335','340','345','370'];
      const decFields = ['380','390'];
      const base = [
        { src: 'BN',  dst: 'bn',  transform: 'cleanString' },
        { src: 'FPE', dst: 'fpe', transform: 'parseDate' },
        { src: 'Form ID|FormID', dst: 'form_id', transform: 'parseInteger' },
      ];
      for (const f of intFields) base.push({ src: f, dst: `field_${f}`, transform: 'parseInteger' });
      for (const f of decFields) base.push({ src: f, dst: `field_${f}`, transform: 'parseDecimal' });
      return base;
    })(),
  },
  gifts_in_kind: {
    table: 'cra_gifts_in_kind',
    pk: ['bn', 'fpe'],
    mappings: (() => {
      const boolFields = ['500','505','510','515','520','525','530','535','540','545','550','555','560'];
      const base = [
        { src: 'BN',  dst: 'bn',  transform: 'cleanString' },
        { src: 'FPE', dst: 'fpe', transform: 'parseDate' },
        { src: 'Form ID|FormID', dst: 'form_id', transform: 'parseInteger' },
      ];
      for (const f of boolFields) base.push({ src: f, dst: `field_${f}`, transform: 'yesNoToBool' });
      base.push({ src: '565', dst: 'field_565', transform: 'cleanString' });
      base.push({ src: '580', dst: 'field_580', transform: 'parseDecimal' });
      return base;
    })(),
  },
  political_activity_description: {
    table: 'cra_political_activity_desc',
    pk: ['bn', 'fpe'],
    mappings: [
      { src: 'BN',  dst: 'bn',  transform: 'cleanString' },
      { src: 'FPE', dst: 'fpe', transform: 'parseDate' },
      { src: 'Form ID|FormID', dst: 'form_id', transform: 'parseInteger' },
      { src: 'Description', dst: 'description', transform: 'cleanString' },
    ],
  },
  political_activity_funding: {
    table: 'cra_political_activity_funding',
    pk: ['bn', 'fpe', 'sequence_number'],
    mappings: [
      { src: 'BN',  dst: 'bn',  transform: 'cleanString' },
      { src: 'FPE', dst: 'fpe', transform: 'parseDate' },
      { src: 'Form ID|FormID', dst: 'form_id', transform: 'parseInteger' },
      { src: '#', dst: 'sequence_number', transform: 'parseInteger' },
      { src: 'Activity', dst: 'activity', transform: 'cleanString' },
      { src: 'Amount', dst: 'amount', transform: 'parseDecimal' },
      { src: 'Country', dst: 'country', transform: 'cleanCode2' },
    ],
  },
  political_activity_resources: {
    table: 'cra_political_activity_resources',
    pk: ['bn', 'fpe', 'sequence_number'],
    mappings: [
      { src: 'BN',  dst: 'bn',  transform: 'cleanString' },
      { src: 'FPE', dst: 'fpe', transform: 'parseDate' },
      { src: 'Form ID|FormID', dst: 'form_id', transform: 'parseInteger' },
      { src: '#', dst: 'sequence_number', transform: 'parseInteger' },
      { src: 'Staff',      dst: 'staff',      transform: 'xFlagToBool' },
      { src: 'Volunteers', dst: 'volunteers', transform: 'xFlagToBool' },
      { src: 'Financial',  dst: 'financial',  transform: 'xFlagToBool' },
      { src: 'Property',   dst: 'property',   transform: 'xFlagToBool' },
      { src: 'Other|Other Resource', dst: 'other_resource', transform: 'cleanString' },
    ],
  },
  disbursement_quota: {
    table: 'cra_disbursement_quota',
    pk: ['bn', 'fpe'],
    mappings: (() => {
      const decimalFields = ['805','810','815','820','825','830','835','840','845','850','855','860','865','870','875','880','885','890'];
      const base = [
        { src: 'BN',  dst: 'bn',  transform: 'cleanString' },
        { src: 'FPE', dst: 'fpe', transform: 'parseDate' },
        { src: 'Form ID|FormID', dst: 'form_id', transform: 'parseInteger' },
      ];
      for (const f of decimalFields) base.push({ src: f, dst: `field_${f}`, transform: 'parseDecimal' });
      return base;
    })(),
  },
  web_urls: {
    table: 'cra_web_urls',
    pk: ['bn', 'fiscal_year', 'sequence_number'],
    mappings: [
      { src: 'BN|BN/NE', dst: 'bn', transform: 'cleanString' },
      { src: '__SYNTHESIZED__', dst: 'fiscal_year', transform: 'year from run argument' },
      { src: '#', dst: 'sequence_number', transform: 'parseInteger' },
      { src: 'Contact URL', dst: 'contact_url', transform: 'cleanString' },
    ],
  },
};

async function loadSourceKeys() {
  const DATASETS = Object.keys(IMPORT_MAP);
  const YEARS = [2020, 2021, 2022, 2023, 2024];
  const out = {};
  for (const ds of DATASETS) {
    const keyCount = {};
    const sampleByKey = {};
    const yearBreakdown = {};
    let totalRows = 0;
    for (const y of YEARS) {
      const p = path.join(__dirname, '..', 'data', 'cache', String(y), ds + '.json');
      if (!fs.existsSync(p)) { yearBreakdown[y] = { rows: 0, keys: [] }; continue; }
      try {
        const d = JSON.parse(fs.readFileSync(p, 'utf8'));
        const recs = d.records || d;
        totalRows += recs.length;
        const yearKeyCount = {};
        for (const r of recs) {
          for (const k of Object.keys(r)) {
            keyCount[k] = (keyCount[k] || 0) + (r[k] !== null && r[k] !== '' && r[k] !== undefined ? 1 : 0);
            yearKeyCount[k] = (yearKeyCount[k] || 0) + (r[k] !== null && r[k] !== '' && r[k] !== undefined ? 1 : 0);
            if (!sampleByKey[k] && r[k] !== null && r[k] !== '') sampleByKey[k] = String(r[k]).slice(0, 60);
          }
        }
        yearBreakdown[y] = { rows: recs.length, keyNonNullCounts: yearKeyCount };
      } catch(e) { yearBreakdown[y] = { rows: 0, error: e.message }; }
    }
    const keys = Object.keys(keyCount).sort();
    out[ds] = {
      totalRowsAcrossYears: totalRows,
      sourceKeys: keys.map(k => ({ key: k, nonNullCountAcrossYears: keyCount[k], sample: sampleByKey[k] || null })),
      yearBreakdown,
    };
  }
  return out;
}

async function loadDbColumns(client) {
  const out = {};
  const q = await client.query(`
    SELECT table_name, column_name, data_type, ordinal_position
    FROM information_schema.columns
    WHERE table_schema = 'cra' AND table_name LIKE 'cra_%'
    ORDER BY table_name, ordinal_position
  `);
  for (const r of q.rows) {
    if (!out[r.table_name]) out[r.table_name] = [];
    out[r.table_name].push({ column_name: r.column_name, data_type: r.data_type });
  }
  return out;
}

async function loadDbNonNullCounts(client, table, columns) {
  const clauses = columns.map(c => `COUNT(${c.column_name}) AS "${c.column_name}"`).join(', ');
  const q = await client.query(`SELECT COUNT(*) AS total_rows, ${clauses} FROM cra.${table}`);
  return q.rows[0];
}

async function main() {
  const client = new Client({ connectionString: process.env.DB_CONNECTION_STRING });
  await client.connect();

  console.log('Loading source keys from cache...');
  const sourceKeys = await loadSourceKeys();
  console.log('Loading DB columns...');
  const dbColumns = await loadDbColumns(client);

  const crosswalk = {
    _metadata: {
      description: 'Comprehensive source → database crosswalk for the 19 CRA T3010 datasets.',
      generated: new Date().toISOString(),
      sourceAuthority: 'Government of Canada Open Data Portal (open.canada.ca) — CKAN datastore_search API',
      fiscalYearsCovered: inventory.fiscalYears,
      importLogic: 'CRA/scripts/04-import-data.js (per-dataset importer functions)',
      transformLibrary: 'CRA/lib/transformers.js',
      purpose: 'Prove every source key is either (a) mapped to a target column with a known transform, or (b) intentionally skipped. Zero silent drops allowed.',
    },
    datasets: {},
  };

  for (const [dsKey, def] of Object.entries(IMPORT_MAP)) {
    const invDs = inventory.datasets[dsKey === 'political_activity_description' ? 'political_activity_description' : dsKey];
    const sourceInfo = sourceKeys[dsKey] || { sourceKeys: [], totalRowsAcrossYears: 0 };
    const dbCols = dbColumns[def.table] || [];
    const dbNonNull = dbCols.length > 0 ? await loadDbNonNullCounts(client, def.table, dbCols) : { total_rows: 0 };

    // Normalize mapping source-key aliases and match against observed source keys
    const sourceKeySet = new Set(sourceInfo.sourceKeys.map(sk => sk.key));
    const mappedSourceKeys = new Set();
    const mappedDbColumns = new Set();

    const columnCrosswalk = def.mappings.map(m => {
      const srcAliases = m.src.split('|').map(s => s.trim());
      const matchedAliases = srcAliases.filter(a => sourceKeySet.has(a));
      const matchedAlias = matchedAliases[0] || null;
      // Mark EVERY present alias as mapped (handles API ↔ CSV key variants like "FormID"/"Form ID")
      for (const a of matchedAliases) mappedSourceKeys.add(a);
      mappedDbColumns.add(m.dst);
      const srcInfo = sourceInfo.sourceKeys.find(sk => sk.key === matchedAlias);
      const dbCol = dbCols.find(c => c.column_name === m.dst);
      const nonNullInDb = dbNonNull[m.dst] !== undefined ? Number(dbNonNull[m.dst]) : null;

      return {
        sourceKeyAliases: srcAliases,
        sourceKeyMatched: matchedAlias,
        sourceNonNullCountAcrossYears: srcInfo ? srcInfo.nonNullCountAcrossYears : 0,
        sourceSample: srcInfo ? srcInfo.sample : null,
        targetColumn: m.dst,
        targetDataType: dbCol ? dbCol.data_type : '__MISSING_FROM_DB__',
        transform: m.transform,
        defect: m.defect || null,
        dbNonNullCount: nonNullInDb,
        status: determineStatus(srcInfo, nonNullInDb, m, dbCol),
      };
    });

    // Find source keys that were NOT mapped
    const unmappedSourceKeys = sourceInfo.sourceKeys
      .filter(sk => !mappedSourceKeys.has(sk.key) && sk.key !== '_id' && sk.key !== '_rank')
      .map(sk => ({ key: sk.key, nonNullCountAcrossYears: sk.nonNullCountAcrossYears, sample: sk.sample }));

    // Find DB columns that had no mapping
    const unmappedDbColumns = dbCols
      .filter(c => !mappedDbColumns.has(c.column_name))
      .map(c => ({
        column_name: c.column_name,
        data_type: c.data_type,
        dbNonNullCount: dbNonNull[c.column_name] !== undefined ? Number(dbNonNull[c.column_name]) : null,
      }));

    crosswalk.datasets[dsKey] = {
      id: invDs ? invDs.id : null,
      name: invDs ? invDs.name : null,
      t3010Section: invDs ? invDs.t3010Section : null,
      description: invDs ? invDs.description : null,
      sourceUuidsByYear: invDs ? (invDs.uuids || {}) : {},
      databaseTable: def.table,
      primaryKey: def.pk,
      totalRowsInDb: Number(dbNonNull.total_rows),
      totalRowsInCachedSource: sourceInfo.totalRowsAcrossYears,
      rowCountDelta: sourceInfo.totalRowsAcrossYears - Number(dbNonNull.total_rows),
      columnCrosswalk,
      unmappedSourceKeys,
      unmappedDbColumns,
      knownDefects: columnCrosswalk.filter(c => c.defect).map(c => ({ column: c.targetColumn, defect: c.defect })),
    };
  }

  const outPath = path.join(__dirname, '..', 'config', 'cra-crosswalk.json');
  fs.writeFileSync(outPath, JSON.stringify(crosswalk, null, 2));
  console.log(`Wrote ${outPath}`);
  await client.end();

  // Print summary
  console.log('\n=== SUMMARY ===');
  for (const [ds, data] of Object.entries(crosswalk.datasets)) {
    const defects = data.knownDefects.length;
    const unmappedSrc = data.unmappedSourceKeys.length;
    console.log(`${ds}: rows ${data.totalRowsInDb} | src-delta ${data.rowCountDelta} | unmapped-src ${unmappedSrc} | defects ${defects}`);
  }
}

function determineStatus(srcInfo, dbNonNullCount, mapping, dbCol) {
  if (!dbCol) return 'ERROR — target column missing from DB';
  if (mapping.src === '__SYNTHESIZED__') return 'OK (synthesized at import time, not a source column)';
  if (mapping.defect) return 'TYPE-MISMATCH DEFECT — see defect field';
  if (!srcInfo) return 'OK (source key not observed in cached sample)';
  const srcNN = srcInfo.nonNullCountAcrossYears;
  if (srcNN === 0 && (dbNonNullCount === 0 || dbNonNullCount === null)) return 'OK (both empty)';
  if (srcNN > 0 && dbNonNullCount === 0) return `LOSSY — source has ${srcNN} non-null values, DB has 0`;
  if (srcNN > 0 && dbNonNullCount !== null && dbNonNullCount < srcNN * 0.5) return `PARTIAL LOSS — src ${srcNN}, db ${dbNonNullCount}`;
  return `OK (src ${srcNN}, db ${dbNonNullCount})`;
}

main().catch(err => { console.error(err); process.exit(1); });
