/**
 * 04-import-data.js - Import Cached CRA T3010 Data into PostgreSQL
 *
 * Reads cached JSON files (produced by 03-fetch-data.js) and bulk-inserts
 * them into the corresponding PostgreSQL tables.
 *
 * All INSERTs use ON CONFLICT DO NOTHING for idempotency.
 *
 * Usage:
 *   node scripts/04-import-data.js              # Import all years
 *   node scripts/04-import-data.js --year 2023  # Import only 2023
 */
const db = require('../lib/db');
const apiClient = require('../lib/api-client');
const log = require('../lib/logger');
const { FISCAL_YEARS, DATASETS, getDatasetsForYear } = require('../config/datasets');
const {
  yesNoToBool,
  xFlagToBool,
  parseDecimal,
  parseInteger,
  parseDate,
  cleanString,
  cleanCode2,
  sqlStr,
  sqlVal,
} = require('../lib/transformers');

const BATCH_SIZE = 1000;

// ─── Helpers ──────────────────────────────────────────────────────

function parseYearArg() {
  const args = process.argv.slice(2);
  const yearIdx = args.indexOf('--year');
  if (yearIdx !== -1 && args[yearIdx + 1]) {
    const year = parseInt(args[yearIdx + 1], 10);
    if (!FISCAL_YEARS.includes(year)) {
      log.error(`Invalid year: ${year}. Valid years: ${FISCAL_YEARS.join(', ')}`);
      process.exit(1);
    }
    return [year];
  }
  return [...FISCAL_YEARS];
}

/**
 * Generic batch insert. Processes records through processRow, builds VALUES
 * via buildValues, and inserts in batches of BATCH_SIZE.
 *
 * NOTE: This function uses string-interpolated SQL (via sqlStr/sqlVal) rather
 * than parameterized queries ($1, $2) because the column set varies per table
 * and pg doesn't support parameterized identifiers. The data source is the
 * CRA Open Data API, not user input. If you adapt this pattern for user-facing
 * input, switch to parameterized queries — see 02-score-universe.js for examples.
 */
async function batchInsert(client, records, processRow, buildValues, tableName, conflictClause) {
  let total = 0;
  let skipped = 0;
  for (let i = 0; i < records.length; i += BATCH_SIZE) {
    const batch = records.slice(i, i + BATCH_SIZE);
    const processed = [];
    for (const rec of batch) {
      try {
        const row = processRow(rec);
        if (row) processed.push(row);
        else skipped++;
      } catch (e) {
        skipped++;
        if (skipped <= 5) log.warn(`  Skipped row: ${e.message}`);
      }
    }
    if (processed.length > 0) {
      const { columns, values } = buildValues(processed);
      await client.query(`INSERT INTO ${tableName} (${columns}) VALUES ${values} ON CONFLICT ${conflictClause} DO NOTHING`);
      total += processed.length;
      if ((total % 10000) < BATCH_SIZE) log.info(`  ${tableName}: ${total.toLocaleString()} rows inserted...`);
    }
  }
  log.info(`  ${tableName}: ${total.toLocaleString()} total (${skipped} skipped)`);
  return total;
}

/**
 * Load cached data and run the import. Returns record count or 0.
 */
async function importDataset(client, year, datasetKey, importFn) {
  const cached = apiClient.loadCache(year, datasetKey);
  if (!cached || !cached.records) {
    log.warn(`No cached data for ${datasetKey}/${year}, run fetch first`);
    return 0;
  }
  const records = cached.records;
  log.info(`  Loading ${records.length.toLocaleString()} records for ${datasetKey}/${year}`);
  return await importFn(client, records, year);
}

// ─── Helper to read BN from API row (field name varies) ─────────

function getBN(rec) {
  return cleanString(rec['BN'] || rec['BN/NE']);
}

// ─── 1. Identification ──────────────────────────────────────────

async function importIdentification(client, records, year) {
  function processRow(rec) {
    const bn = getBN(rec);
    if (!bn) return null;
    return {
      bn,
      fiscal_year: year,
      category: cleanString(rec['Category']),
      sub_category: cleanString(rec['Sub Category']),
      designation: cleanString(rec['Designation']),
      legal_name: cleanString(rec['Legal Name']),
      account_name: cleanString(rec['Account Name']),
      address_line_1: cleanString(rec['Address Line 1']),
      address_line_2: cleanString(rec['Address Line 2']),
      city: cleanString(rec['City']),
      province: cleanCode2(rec['Province']),
      postal_code: cleanString(rec['Postal Code']),
      country: cleanCode2(rec['Country']),
    };
  }

  function buildValues(rows) {
    const columns = 'bn, fiscal_year, category, sub_category, designation, legal_name, account_name, address_line_1, address_line_2, city, province, postal_code, country';
    const values = rows.map(r =>
      `(${sqlStr(r.bn)}, ${sqlVal(r.fiscal_year)}, ${sqlStr(r.category)}, ${sqlStr(r.sub_category)}, ${sqlStr(r.designation)}, ${sqlStr(r.legal_name)}, ${sqlStr(r.account_name)}, ${sqlStr(r.address_line_1)}, ${sqlStr(r.address_line_2)}, ${sqlStr(r.city)}, ${sqlStr(r.province)}, ${sqlStr(r.postal_code)}, ${sqlStr(r.country)})`
    ).join(',\n');
    return { columns, values };
  }

  return await batchInsert(client, records, processRow, buildValues, 'cra_identification', '(bn, fiscal_year)');
}

// ─── 2. Directors ───────────────────────────────────────────────

async function importDirectors(client, records, year) {
  function processRow(rec) {
    const bn = cleanString(rec['BN']);
    const fpe = parseDate(rec['FPE']);
    const seq = parseInteger(rec['#']);
    if (!bn || !fpe || seq === null) return null;
    return {
      bn,
      fpe,
      form_id: parseInteger(rec['Form ID']),
      sequence_number: seq,
      last_name: cleanString(rec['Last Name']),
      first_name: cleanString(rec['First Name']),
      initials: cleanString(rec['Initials']),
      position: cleanString(rec['Position']),
      at_arms_length: yesNoToBool(rec['At Arm\'s Length']),
      start_date: parseDate(rec['Start Date']),
      end_date: parseDate(rec['End Date']),
    };
  }

  function buildValues(rows) {
    const columns = 'bn, fpe, form_id, sequence_number, last_name, first_name, initials, position, at_arms_length, start_date, end_date';
    const values = rows.map(r =>
      `(${sqlStr(r.bn)}, ${sqlStr(r.fpe)}, ${sqlVal(r.form_id)}, ${sqlVal(r.sequence_number)}, ${sqlStr(r.last_name)}, ${sqlStr(r.first_name)}, ${sqlStr(r.initials)}, ${sqlStr(r.position)}, ${sqlVal(r.at_arms_length)}, ${r.start_date ? sqlStr(r.start_date) : 'NULL'}, ${r.end_date ? sqlStr(r.end_date) : 'NULL'})`
    ).join(',\n');
    return { columns, values };
  }

  return await batchInsert(client, records, processRow, buildValues, 'cra_directors', '(bn, fpe, sequence_number)');
}

// ─── 3. Financial Data (dynamic fields) ─────────────────────────

async function importFinancialData(client, records, year) {
  // Per CRA Open Data Dictionary §3.7 (Financial Data).
  // Amount fields become DECIMAL; the two "specify" text fields are TEXT.
  const numericFields = [
    '4100','4101','4102','4110','4120','4130','4140','4150','4155','4157','4158',
    '4160','4165','4166','4170','4180','4190','4200','4250','4300','4310','4320',
    '4330','4350','4500','4505','4510','4530','4540','4550','4560',
    '4570','4571','4575','4576','4577','4580','4590','4600','4610','4620','4630','4640',
    '4650','4700','4800','4810','4820','4830','4840','4850','4860','4870',
    '4880','4890','4891','4900','4910','4920','4950','5000','5010','5020',
    '5030','5040','5045','5050','5100','5500','5510','5610','5750','5900','5910',
  ];
  const boolFields = ['4400', '4490', '4565'];
  const textFields = ['4655', '4930'];  // Text 175 per dictionary (free-text "specify")

  function processRow(rec) {
    const bn = cleanString(rec['BN']);
    const fpe = parseDate(rec['FPE']);
    if (!bn || !fpe) return null;

    const row = {
      bn,
      fpe,
      form_id: parseInteger(rec['FormID'] || rec['Form ID']),
      section_used: cleanString(rec['SectionUsed'] || rec['Section Used']),
      field_4020: cleanString(rec['4020']),
      field_4050: yesNoToBool(rec['4050']),
    };

    for (const f of numericFields) {
      row[`field_${f}`] = parseDecimal(rec[f]);
    }
    for (const f of boolFields) {
      row[`field_${f}`] = yesNoToBool(rec[f]);
    }
    for (const f of textFields) {
      row[`field_${f}`] = cleanString(rec[f]);
    }

    return row;
  }

  function buildValues(rows) {
    // Collect all keys from the first row (they are all the same shape)
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
    return { columns, values };
  }

  return await batchInsert(client, records, processRow, buildValues, 'cra_financial_details', '(bn, fpe)');
}

// ─── 4. General Info (dynamic fields) ───────────────────────────

async function importGeneralInfo(client, records, year) {
  // Per CRA Open Data Dictionary §3.6 (General Information / Sections A-C).
  //
  // The field-type lists below are derived directly from the dictionary.
  // Fields appearing in the DB schema but not in any dictionary section
  // (the "orphan" columns — 1610, 1620, 1630, 1640, 1650, 2110, 2300, 2350,
  // 2520, 3205-3270, 3600, 3610, 4010, 5000, 5010, 5844-5849, 5851-5859)
  // are intentionally kept in the schema but left NULL on import.
  const boolFields = [
    // Y/N flags, all from dictionary §3.6
    '1570','1600','1800','2000','2100',
    '2400',                                 // v23/v24 only — political-activity activation
    '2500','2510','2530','2540','2550','2560','2570','2575','2580','2590',
    '2600','2610','2620','2630','2640','2650',
    '2700',                                 // "Charity paid external fundraisers"
    '2730','2740','2750','2760','2770','2780','2800',
    '3200','3400','3900','4000',
    '5800','5810','5820','5830',
    '5840','5841',                          // v26+ — grants to non-qualified donees
    '5850','5860',                          // v27+ — DAF questions
  ];
  const decimalFields = [
    '5030','5031','5032',                   // v23 only — Amount 14 (political-activity spend)
    '5450','5460',                          // Amount 14 — fundraiser revenue/paid
    '5843',                                 // v26+ Amount 17 — total paid to grantees ≤$5,000
    '5862','5863','5864',                   // v27+ Amount 17 — DAF dollars
  ];
  const integerFields = [
    '5842',                                 // v26+ Number 10 — count of grantees ≤$5,000
    '5861',                                 // v27+ Number 10 — DAF account count
  ];
  const textFields = [
    '2660',                                 // Text 175 — "Fundraising activity: Specify"
    '2790',                                 // Text 175 — "External fundraisers: Specify"
  ];
  const internalDivisions = ['1510-01','1510-02','1510-03','1510-04','1510-05'];

  function processRow(rec) {
    const bn = cleanString(rec['BN']);
    const fpe = parseDate(rec['FPE']);
    if (!bn || !fpe) return null;

    const row = {
      bn,
      fpe,
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
      // 1510 subordinate/parent fields (API names differ from CSV)
      field_1510_subordinate: yesNoToBool(rec['1510']),
      field_1510_parent_bn: cleanString(rec['1510-BN']),
      field_1510_parent_name: cleanString(rec['1510-Name']),
    };

    for (const d of internalDivisions) {
      const colName = `internal_division_${d.replace('-', '_')}`;
      row[colName] = parseInteger(rec[d]);
    }

    for (const f of boolFields)    row[`field_${f}`] = yesNoToBool(rec[f]);
    for (const f of decimalFields) row[`field_${f}`] = parseDecimal(rec[f]);
    for (const f of integerFields) row[`field_${f}`] = parseInteger(rec[f]);
    for (const f of textFields)    row[`field_${f}`] = cleanString(rec[f]);

    return row;
  }

  function buildValues(rows) {
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
    return { columns, values };
  }

  return await batchInsert(client, records, processRow, buildValues, 'cra_financial_general', '(bn, fpe)');
}

// ─── 5. Charitable Programs ─────────────────────────────────────

async function importCharitablePrograms(client, records, year) {
  function processRow(rec) {
    const bn = cleanString(rec['BN']);
    const fpe = parseDate(rec['FPE']);
    const programType = cleanString(rec['Program Type'] || rec['ProgramType']);
    if (!bn || !fpe || !programType) return null;
    return {
      bn,
      fpe,
      form_id: parseInteger(rec['FormID'] || rec['Form ID']),
      program_type: programType,
      description: cleanString(rec['Description']),
    };
  }

  function buildValues(rows) {
    const columns = 'bn, fpe, form_id, program_type, description';
    const values = rows.map(r =>
      `(${sqlStr(r.bn)}, ${sqlStr(r.fpe)}, ${sqlVal(r.form_id)}, ${sqlStr(r.program_type)}, ${sqlStr(r.description)})`
    ).join(',\n');
    return { columns, values };
  }

  return await batchInsert(client, records, processRow, buildValues, 'cra_charitable_programs', '(bn, fpe, program_type)');
}

// ─── 6. Non-Qualified Donees ────────────────────────────────────

async function importNonQualifiedDonees(client, records, year) {
  function processRow(rec) {
    const bn = cleanString(rec['BN']);
    const fpe = parseDate(rec['FPE']);
    const seq = parseInteger(rec['#']);
    if (!bn || !fpe || seq === null) return null;
    return {
      bn,
      fpe,
      form_id: parseInteger(rec['Form ID'] || rec['FormID']),
      sequence_number: seq,
      recipient_name: cleanString(rec['Recipient name'] || rec['Recipient Name']),
      purpose: cleanString(rec['Purpose']),
      cash_amount: parseDecimal(rec['Cash amount'] || rec['Cash Amount']),
      non_cash_amount: parseDecimal(rec['Non-cash amount'] || rec['Non-cash Amount'] || rec['Non-Cash Amount']),
      // Per dictionary §3.18 "Grant Country" is Text 125 — a free-text list of countries,
      // NOT a 2-char code. cleanCode2 was silently dropping ~96% of values.
      country: cleanString(rec['Country']),
    };
  }

  function buildValues(rows) {
    const columns = 'bn, fpe, form_id, sequence_number, recipient_name, purpose, cash_amount, non_cash_amount, country';
    const values = rows.map(r =>
      `(${sqlStr(r.bn)}, ${sqlStr(r.fpe)}, ${sqlVal(r.form_id)}, ${sqlVal(r.sequence_number)}, ${sqlStr(r.recipient_name)}, ${sqlStr(r.purpose)}, ${sqlVal(r.cash_amount)}, ${sqlVal(r.non_cash_amount)}, ${sqlStr(r.country)})`
    ).join(',\n');
    return { columns, values };
  }

  return await batchInsert(client, records, processRow, buildValues, 'cra_non_qualified_donees', '(bn, fpe, sequence_number)');
}

// ─── 7. Qualified Donees ────────────────────────────────────────

async function importQualifiedDonees(client, records, year) {
  function processRow(rec) {
    const bn = cleanString(rec['BN']);
    const fpe = parseDate(rec['FPE']);
    const seq = parseInteger(rec['#']);
    if (!bn || !fpe || seq === null) return null;
    return {
      bn,
      fpe,
      form_id: parseInteger(rec['FormID'] || rec['Form ID']),
      sequence_number: seq,
      donee_bn: cleanString(rec['DoneeBN'] || rec['Donee BN']),
      donee_name: cleanString(rec['DoneeName'] || rec['Donee Name']),
      associated: yesNoToBool(rec['Associated']),
      city: cleanString(rec['City']),
      province: cleanCode2(rec['Province']),
      total_gifts: parseDecimal(rec['TotalGifts'] || rec['Total Gifts']),
      gifts_in_kind: parseDecimal(rec['GiftsinKind'] || rec['Gifts in Kind']),
      political_activity_gift: yesNoToBool(rec['PoliticalActivityGift'] || rec['Political Activity Gift']),
      political_activity_amount: parseDecimal(rec['PoliticalActivityAmount'] || rec['Political Activity Amount']),
    };
  }

  function buildValues(rows) {
    const columns = 'bn, fpe, form_id, sequence_number, donee_bn, donee_name, associated, city, province, total_gifts, gifts_in_kind, political_activity_gift, political_activity_amount';
    const values = rows.map(r =>
      `(${sqlStr(r.bn)}, ${sqlStr(r.fpe)}, ${sqlVal(r.form_id)}, ${sqlVal(r.sequence_number)}, ${sqlStr(r.donee_bn)}, ${sqlStr(r.donee_name)}, ${sqlVal(r.associated)}, ${sqlStr(r.city)}, ${sqlStr(r.province)}, ${sqlVal(r.total_gifts)}, ${sqlVal(r.gifts_in_kind)}, ${sqlVal(r.political_activity_gift)}, ${sqlVal(r.political_activity_amount)})`
    ).join(',\n');
    return { columns, values };
  }

  return await batchInsert(client, records, processRow, buildValues, 'cra_qualified_donees', '(bn, fpe, sequence_number)');
}

// ─── 8. Foundation Info ─────────────────────────────────────────

async function importFoundationInfo(client, records, year) {
  // Per CRA Open Data Dictionary §3.8 (Schedule 1 - Foundations).
  // 100/110/120/130 are Y/N; 111/112 are Amount 17 (new in v27).
  const boolFields = ['100', '110', '120', '130'];
  const decimalFields = ['111', '112'];
  const allFields = ['100', '110', '111', '112', '120', '130'];  // preserve column order

  function processRow(rec) {
    const bn = cleanString(rec['BN']);
    const fpe = parseDate(rec['FPE']);
    if (!bn || !fpe) return null;
    const row = {
      bn,
      fpe,
      form_id: parseInteger(rec['Form ID'] || rec['FormID']),
    };
    for (const f of boolFields)    row[`field_${f}`] = yesNoToBool(rec[f]);
    for (const f of decimalFields) row[`field_${f}`] = parseDecimal(rec[f]);
    return row;
  }

  function buildValues(rows) {
    const columns = `bn, fpe, form_id, ${allFields.map(f => `field_${f}`).join(', ')}`;
    const values = rows.map(r =>
      `(${sqlStr(r.bn)}, ${sqlStr(r.fpe)}, ${sqlVal(r.form_id)}, ${allFields.map(f => sqlVal(r[`field_${f}`])).join(', ')})`
    ).join(',\n');
    return { columns, values };
  }

  return await batchInsert(client, records, processRow, buildValues, 'cra_foundation_info', '(bn, fpe)');
}

// ─── 9. Activities Outside Countries ────────────────────────────

async function importActivitiesOutsideCountries(client, records, year) {
  function processRow(rec) {
    const bn = cleanString(rec['BN']);
    const fpe = parseDate(rec['FPE']);
    const seq = parseInteger(rec['#']);
    if (!bn || !fpe || seq === null) return null;
    return {
      bn,
      fpe,
      form_id: parseInteger(rec['Form ID'] || rec['FormID']),
      sequence_number: seq,
      country: cleanCode2(rec['Country']),
    };
  }

  function buildValues(rows) {
    const columns = 'bn, fpe, form_id, sequence_number, country';
    const values = rows.map(r =>
      `(${sqlStr(r.bn)}, ${sqlStr(r.fpe)}, ${sqlVal(r.form_id)}, ${sqlVal(r.sequence_number)}, ${sqlStr(r.country)})`
    ).join(',\n');
    return { columns, values };
  }

  return await batchInsert(client, records, processRow, buildValues, 'cra_activities_outside_countries', '(bn, fpe, sequence_number)');
}

// ─── 10. Activities Outside Details ─────────────────────────────

async function importActivitiesOutsideDetails(client, records, year) {
  function processRow(rec) {
    const bn = cleanString(rec['BN']);
    const fpe = parseDate(rec['FPE']);
    if (!bn || !fpe) return null;
    return {
      bn,
      fpe,
      form_id: parseInteger(rec['Form ID'] || rec['FormID']),
      field_200: parseDecimal(rec['200']),
      field_210: yesNoToBool(rec['210']),
      field_220: yesNoToBool(rec['220']),
      field_230: cleanString(rec['230']),
      field_240: yesNoToBool(rec['240']),
      field_250: yesNoToBool(rec['250']),
      field_260: yesNoToBool(rec['260']),
    };
  }

  function buildValues(rows) {
    const columns = 'bn, fpe, form_id, field_200, field_210, field_220, field_230, field_240, field_250, field_260';
    const values = rows.map(r =>
      `(${sqlStr(r.bn)}, ${sqlStr(r.fpe)}, ${sqlVal(r.form_id)}, ${sqlVal(r.field_200)}, ${sqlVal(r.field_210)}, ${sqlVal(r.field_220)}, ${sqlStr(r.field_230)}, ${sqlVal(r.field_240)}, ${sqlVal(r.field_250)}, ${sqlVal(r.field_260)})`
    ).join(',\n');
    return { columns, values };
  }

  return await batchInsert(client, records, processRow, buildValues, 'cra_activities_outside_details', '(bn, fpe)');
}

// ─── 11. Exported Goods ─────────────────────────────────────────

async function importExportedGoods(client, records, year) {
  function processRow(rec) {
    const bn = cleanString(rec['BN']);
    const fpe = parseDate(rec['FPE']);
    const seq = parseInteger(rec['#']);
    if (!bn || !fpe || seq === null) return null;
    return {
      bn,
      fpe,
      form_id: parseInteger(rec['Form ID'] || rec['FormID']),
      sequence_number: seq,
      item_name: cleanString(rec['Item Name']),
      item_value: parseDecimal(rec['Item Value']),
      destination: cleanString(rec['Destination']),
      country: cleanCode2(rec['Country']),
    };
  }

  function buildValues(rows) {
    const columns = 'bn, fpe, form_id, sequence_number, item_name, item_value, destination, country';
    const values = rows.map(r =>
      `(${sqlStr(r.bn)}, ${sqlStr(r.fpe)}, ${sqlVal(r.form_id)}, ${sqlVal(r.sequence_number)}, ${sqlStr(r.item_name)}, ${sqlVal(r.item_value)}, ${sqlStr(r.destination)}, ${sqlStr(r.country)})`
    ).join(',\n');
    return { columns, values };
  }

  return await batchInsert(client, records, processRow, buildValues, 'cra_exported_goods', '(bn, fpe, sequence_number)');
}

// ─── 12. Resources Sent Outside ─────────────────────────────────

async function importResourcesSentOutside(client, records, year) {
  function processRow(rec) {
    const bn = cleanString(rec['BN']);
    const fpe = parseDate(rec['FPE']);
    const seq = parseInteger(rec['#']);
    if (!bn || !fpe || seq === null) return null;
    return {
      bn,
      fpe,
      form_id: parseInteger(rec['Form ID'] || rec['FormID']),
      sequence_number: seq,
      individual_org_name: cleanString(rec['Indiv/Org Name'] || rec['Individual/Org Name']),
      amount: parseDecimal(rec['Amount']),
      country: cleanCode2(rec['Country']),
    };
  }

  function buildValues(rows) {
    const columns = 'bn, fpe, form_id, sequence_number, individual_org_name, amount, country';
    const values = rows.map(r =>
      `(${sqlStr(r.bn)}, ${sqlStr(r.fpe)}, ${sqlVal(r.form_id)}, ${sqlVal(r.sequence_number)}, ${sqlStr(r.individual_org_name)}, ${sqlVal(r.amount)}, ${sqlStr(r.country)})`
    ).join(',\n');
    return { columns, values };
  }

  return await batchInsert(client, records, processRow, buildValues, 'cra_resources_sent_outside', '(bn, fpe, sequence_number)');
}

// ─── 13. Compensation ───────────────────────────────────────────

async function importCompensation(client, records, year) {
  const intFields = ['300','305','310','315','320','325','330','335','340','345','370'];
  const decFields = ['380','390'];

  function processRow(rec) {
    const bn = cleanString(rec['BN']);
    const fpe = parseDate(rec['FPE']);
    if (!bn || !fpe) return null;
    const row = {
      bn,
      fpe,
      form_id: parseInteger(rec['Form ID'] || rec['FormID']),
    };
    for (const f of intFields) {
      row[`field_${f}`] = parseInteger(rec[f]);
    }
    for (const f of decFields) {
      row[`field_${f}`] = parseDecimal(rec[f]);
    }
    return row;
  }

  function buildValues(rows) {
    const allFields = [...intFields, ...decFields];
    const columns = `bn, fpe, form_id, ${allFields.map(f => `field_${f}`).join(', ')}`;
    const values = rows.map(r => {
      const fieldVals = allFields.map(f => sqlVal(r[`field_${f}`])).join(', ');
      return `(${sqlStr(r.bn)}, ${sqlStr(r.fpe)}, ${sqlVal(r.form_id)}, ${fieldVals})`;
    }).join(',\n');
    return { columns, values };
  }

  return await batchInsert(client, records, processRow, buildValues, 'cra_compensation', '(bn, fpe)');
}

// ─── 14. Gifts in Kind ──────────────────────────────────────────

async function importGiftsInKind(client, records, year) {
  // Per CRA Open Data Dictionary §3.14 (Schedule 5 - Non-cash Gifts).
  // 500-560 are all Y/N. Previous code mis-typed 500-545 as integer (parseInteger('Y')=NaN→NULL)
  // and 555/560 as text (strings "Y"/"N" stored). Both corrected here.
  const boolFields = ['500','505','510','515','520','525','530','535','540','545','550','555','560'];

  function processRow(rec) {
    const bn = cleanString(rec['BN']);
    const fpe = parseDate(rec['FPE']);
    if (!bn || !fpe) return null;
    const row = {
      bn,
      fpe,
      form_id: parseInteger(rec['Form ID'] || rec['FormID']),
    };
    for (const f of boolFields) {
      row[`field_${f}`] = yesNoToBool(rec[f]);
    }
    row.field_565 = cleanString(rec['565']);  // Text 175
    row.field_580 = parseDecimal(rec['580']); // Amount 14
    return row;
  }

  function buildValues(rows) {
    const allCols = [
      'bn', 'fpe', 'form_id',
      ...boolFields.map(f => `field_${f}`),
      'field_565', 'field_580',
    ];
    const columns = allCols.join(', ');
    const values = rows.map(r => {
      const vals = allCols.map(c => {
        const v = r[c];
        if (v === null || v === undefined) return 'NULL';
        if (typeof v === 'boolean') return v.toString();
        if (typeof v === 'number') return v;
        return sqlStr(v);
      });
      return `(${vals.join(', ')})`;
    }).join(',\n');
    return { columns, values };
  }

  return await batchInsert(client, records, processRow, buildValues, 'cra_gifts_in_kind', '(bn, fpe)');
}

// ─── 15. Political Activity Description ─────────────────────────

async function importPoliticalActivityDescription(client, records, year) {
  function processRow(rec) {
    const bn = cleanString(rec['BN']);
    const fpe = parseDate(rec['FPE']);
    if (!bn || !fpe) return null;
    return {
      bn,
      fpe,
      form_id: parseInteger(rec['Form ID'] || rec['FormID']),
      description: cleanString(rec['Description']),
    };
  }

  function buildValues(rows) {
    const columns = 'bn, fpe, form_id, description';
    const values = rows.map(r =>
      `(${sqlStr(r.bn)}, ${sqlStr(r.fpe)}, ${sqlVal(r.form_id)}, ${sqlStr(r.description)})`
    ).join(',\n');
    return { columns, values };
  }

  return await batchInsert(client, records, processRow, buildValues, 'cra_political_activity_desc', '(bn, fpe)');
}

// ─── 16. Political Activity Funding ─────────────────────────────

async function importPoliticalActivityFunding(client, records, year) {
  function processRow(rec) {
    const bn = cleanString(rec['BN']);
    const fpe = parseDate(rec['FPE']);
    const seq = parseInteger(rec['#']);
    if (!bn || !fpe || seq === null) return null;
    return {
      bn,
      fpe,
      form_id: parseInteger(rec['Form ID'] || rec['FormID']),
      sequence_number: seq,
      activity: cleanString(rec['Activity']),
      amount: parseDecimal(rec['Amount']),
      country: cleanCode2(rec['Country']),
    };
  }

  function buildValues(rows) {
    const columns = 'bn, fpe, form_id, sequence_number, activity, amount, country';
    const values = rows.map(r =>
      `(${sqlStr(r.bn)}, ${sqlStr(r.fpe)}, ${sqlVal(r.form_id)}, ${sqlVal(r.sequence_number)}, ${sqlStr(r.activity)}, ${sqlVal(r.amount)}, ${sqlStr(r.country)})`
    ).join(',\n');
    return { columns, values };
  }

  return await batchInsert(client, records, processRow, buildValues, 'cra_political_activity_funding', '(bn, fpe, sequence_number)');
}

// ─── 17. Political Activity Resources ───────────────────────────

async function importPoliticalActivityResources(client, records, year) {
  function processRow(rec) {
    const bn = cleanString(rec['BN']);
    const fpe = parseDate(rec['FPE']);
    const seq = parseInteger(rec['#']);
    if (!bn || !fpe || seq === null) return null;
    return {
      bn,
      fpe,
      form_id: parseInteger(rec['Form ID'] || rec['FormID']),
      sequence_number: seq,
      // Source publishes staff/volunteers/financial/property as "X"
      // presence flags, not counts/amounts. Target schema is BOOLEAN.
      staff: xFlagToBool(rec['Staff']),
      volunteers: xFlagToBool(rec['Volunteers']),
      financial: xFlagToBool(rec['Financial']),
      property: xFlagToBool(rec['Property']),
      other_resource: cleanString(rec['Other'] || rec['Other Resource']),
    };
  }

  function buildValues(rows) {
    const columns = 'bn, fpe, form_id, sequence_number, staff, volunteers, financial, property, other_resource';
    const values = rows.map(r =>
      `(${sqlStr(r.bn)}, ${sqlStr(r.fpe)}, ${sqlVal(r.form_id)}, ${sqlVal(r.sequence_number)}, ${sqlVal(r.staff)}, ${sqlVal(r.volunteers)}, ${sqlVal(r.financial)}, ${sqlVal(r.property)}, ${sqlStr(r.other_resource)})`
    ).join(',\n');
    return { columns, values };
  }

  return await batchInsert(client, records, processRow, buildValues, 'cra_political_activity_resources', '(bn, fpe, sequence_number)');
}

// ─── 18. Disbursement Quota ─────────────────────────────────────

async function importDisbursementQuota(client, records, year) {
  const decimalFields = [
    '805','810','815','820','825','830','835','840','845','850',
    '855','860','865','870','875','880','885','890',
  ];

  function processRow(rec) {
    const bn = cleanString(rec['BN']);
    const fpe = parseDate(rec['FPE']);
    if (!bn || !fpe) return null;
    const row = {
      bn,
      fpe,
      form_id: parseInteger(rec['Form ID'] || rec['FormID']),
    };
    for (const f of decimalFields) {
      row[`field_${f}`] = parseDecimal(rec[f]);
    }
    return row;
  }

  function buildValues(rows) {
    const columns = `bn, fpe, form_id, ${decimalFields.map(f => `field_${f}`).join(', ')}`;
    const values = rows.map(r => {
      const fieldVals = decimalFields.map(f => sqlVal(r[`field_${f}`])).join(', ');
      return `(${sqlStr(r.bn)}, ${sqlStr(r.fpe)}, ${sqlVal(r.form_id)}, ${fieldVals})`;
    }).join(',\n');
    return { columns, values };
  }

  return await batchInsert(client, records, processRow, buildValues, 'cra_disbursement_quota', '(bn, fpe)');
}

// ─── 19. Web URLs ───────────────────────────────────────────────

async function importWebUrls(client, records, year) {
  function processRow(rec) {
    const bn = getBN(rec);
    const seq = parseInteger(rec['#']);
    if (!bn || seq === null) return null;
    return {
      bn,
      fiscal_year: year,
      sequence_number: seq,
      contact_url: cleanString(rec['Contact URL']),
    };
  }

  function buildValues(rows) {
    const columns = 'bn, fiscal_year, sequence_number, contact_url';
    const values = rows.map(r =>
      `(${sqlStr(r.bn)}, ${sqlVal(r.fiscal_year)}, ${sqlVal(r.sequence_number)}, ${sqlStr(r.contact_url)})`
    ).join(',\n');
    return { columns, values };
  }

  return await batchInsert(client, records, processRow, buildValues, 'cra_web_urls', '(bn, fiscal_year, sequence_number)');
}

// ─── Dataset Router ─────────────────────────────────────────────

const IMPORT_MAP = {
  identification: importIdentification,
  directors: importDirectors,
  financial_data: importFinancialData,
  general_info: importGeneralInfo,
  charitable_programs: importCharitablePrograms,
  non_qualified_donees: importNonQualifiedDonees,
  qualified_donees: importQualifiedDonees,
  foundation_info: importFoundationInfo,
  activities_outside_countries: importActivitiesOutsideCountries,
  activities_outside_details: importActivitiesOutsideDetails,
  exported_goods: importExportedGoods,
  resources_sent_outside: importResourcesSentOutside,
  compensation: importCompensation,
  gifts_in_kind: importGiftsInKind,
  political_activity_description: importPoliticalActivityDescription,
  political_activity_funding: importPoliticalActivityFunding,
  political_activity_resources: importPoliticalActivityResources,
  disbursement_quota: importDisbursementQuota,
  web_urls: importWebUrls,
};

async function importForDataset(client, year, datasetKey) {
  const importFn = IMPORT_MAP[datasetKey];
  if (!importFn) {
    log.warn(`No import handler for dataset: ${datasetKey}`);
    return 0;
  }
  return await importDataset(client, year, datasetKey, importFn);
}

// ─── Main ───────────────────────────────────────────────────────

async function importAll() {
  const client = await db.getClient();
  const years = parseYearArg();
  const results = [];
  let grandTotal = 0;

  try {
    log.section('CRA T3010 Data Import');
    log.info(`Years to import: ${years.join(', ')}`);

    for (const year of years) {
      log.section(`Importing ${year} data`);
      const datasets = getDatasetsForYear(year);
      log.info(`${datasets.length} datasets available for ${year}`);

      for (const ds of datasets) {
        try {
          log.info(`Processing: ${ds.name} (${year})`);
          const count = await importForDataset(client, year, ds.key);
          results.push({ year, key: ds.key, name: ds.name, status: 'success', records: count });
          grandTotal += count;
        } catch (err) {
          results.push({ year, key: ds.key, name: ds.name, status: 'failed', error: err.message });
          log.error(`  Failed to import ${ds.name} (${year}): ${err.message}`);
        }
      }
    }

    // ─── Summary ──────────────────────────────────────────────
    log.section('Import Summary');
    const succeeded = results.filter(r => r.status === 'success');
    const failed = results.filter(r => r.status === 'failed');

    log.info(`Total datasets processed: ${results.length}`);
    log.info(`  Succeeded: ${succeeded.length}`);
    log.info(`  Failed:    ${failed.length}`);
    log.info(`  Total rows imported: ${grandTotal.toLocaleString()}`);
    log.info('');

    for (const year of years) {
      const yearResults = results.filter(r => r.year === year);
      const yearSuccess = yearResults.filter(r => r.status === 'success');
      const yearFailed = yearResults.filter(r => r.status === 'failed');
      const yearTotal = yearSuccess.reduce((sum, r) => sum + r.records, 0);

      log.info(`${year}: ${yearSuccess.length} succeeded, ${yearFailed.length} failed, ${yearTotal.toLocaleString()} rows`);
      for (const r of yearSuccess) {
        log.info(`  [OK]   ${r.name}: ${r.records.toLocaleString()} rows`);
      }
      for (const r of yearFailed) {
        log.error(`  [FAIL] ${r.name}: ${r.error}`);
      }
    }

    if (failed.length > 0) {
      log.error(`\n${failed.length} dataset(s) failed to import. Review errors above.`);
      process.exit(1);
    }

    log.info('\nAll datasets imported successfully.');

  } finally {
    client.release();
    await db.end();
  }
}

importAll().catch((err) => {
  log.error(`Fatal error: ${err.message}`);
  process.exit(1);
});
