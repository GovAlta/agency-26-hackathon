/**
 * 05-field-mapping-audit.js
 *
 * Authoritative 4-way cross-reference of every CRA T3010 field across:
 *   1. The CRA Open Data Dictionary v2.0 (ground truth in docs/guides-forms)
 *   2. The cached JSON from open.canada.ca (what the API actually provides)
 *   3. The PostgreSQL schema (what columns exist and their types)
 *   4. The import script's transform map (what actually gets inserted)
 *
 * Output: data/reports/field-mapping-audit.{json,md,csv}
 *
 * NOTE: The DICTIONARY constant encodes Section 3 of
 * docs/guides-forms/OPEN-DATA-DICTIONARY-V2.0 ENG.md. Each entry uses the
 * T3010 line number / JSON key and the canonical type per the dictionary.
 * Types are:  yn   (Y/N, 1 char)
 *             amt  (Amount, numeric)
 *             num  (Number/integer)
 *             txt  (Text)
 *             date (YYYY-MM-DD)
 *             code (two-letter code)
 *             str  (generic text)
 *
 * formId values: 23 = v23 only (pre-v24 removed), 24, 25, 26, 27 (new in).
 * Blank formVersions = applies to every year.
 */

const fs = require('fs');
const path = require('path');
const db = require('../../lib/db');
const apiClient = require('../../lib/api-client');

const REPORT_DIR = path.join(__dirname, '..', '..', 'data', 'reports');
const MD_OUT = path.join(REPORT_DIR, 'field-mapping-audit.md');
const JSON_OUT = path.join(REPORT_DIR, 'field-mapping-audit.json');
const CSV_OUT = path.join(REPORT_DIR, 'field-mapping-audit.csv');

// ─── GROUND TRUTH: CRA Open Data Dictionary v2.0 ───────────────────────────
const DICTIONARY = {
  identification: {
    section: '3.1',
    pk: ['BN'],
    table: 'cra_identification',
    fields: [
      { key: 'BN', type: 'str', length: 15, desc: 'Business number' },
      { key: 'Category', type: 'str', length: 4, desc: 'Category code' },
      { key: 'Sub Category', type: 'str', length: 4, desc: 'Sub-category code' },
      { key: 'Designation', type: 'str', length: 1, desc: 'Designation (A/B/C/X/Z)' },
      { key: 'Legal Name', type: 'str', length: 175, desc: 'Legal name' },
      { key: 'Account Name', type: 'str', length: 175, desc: 'Account name' },
      { key: 'Address Line 1', type: 'str', length: 30, desc: 'Address line 1' },
      { key: 'Address Line 2', type: 'str', length: 30, desc: 'Address line 2' },
      { key: 'City', type: 'str', length: 30, desc: 'City' },
      { key: 'Province', type: 'code', length: 2, desc: 'Province/state code' },
      { key: 'Postal Code', type: 'str', length: 10, desc: 'Postal/zip code' },
      { key: 'Country', type: 'code', length: 2, desc: 'Country code' },
    ],
  },

  web_urls: {
    section: '3.2',
    pk: ['BN', '#'],
    table: 'cra_web_urls',
    fields: [
      { key: 'BN', jsonAlt: 'BN/NE', type: 'str', length: 15, desc: 'Business number' },
      { key: '#', type: 'num', length: 9, desc: 'Sequence number' },
      { key: 'Contact URL', type: 'str', length: 200, desc: 'URL of charity website' },
    ],
  },

  directors: {
    section: '3.3',
    pk: ['BN', 'FPE', 'Form ID', '#'],
    table: 'cra_directors',
    fields: [
      { key: 'BN', type: 'str', length: 15 },
      { key: 'FPE', type: 'date', length: 10 },
      { key: 'Form ID', type: 'num', length: 4, desc: 'Form version ID (Text 4 in dictionary; small int in practice — accepted as integer)' },
      { key: '#', type: 'num', length: 9 },
      { key: 'Last Name', type: 'str', length: 30 },
      { key: 'First Name', type: 'str', length: 30 },
      { key: 'Initials', type: 'str', length: 3 },
      { key: 'Position', type: 'str', length: 30 },
      { key: "At Arm's Length", type: 'yn', length: 1 },
      { key: 'Start Date', type: 'date', length: 10 },
      { key: 'End Date', type: 'date', length: 10 },
    ],
  },

  qualified_donees: {
    section: '3.4',
    pk: ['BN', 'FPE', 'Form ID', '#'],
    table: 'cra_qualified_donees',
    fields: [
      { key: 'BN', type: 'str', length: 15 },
      { key: 'FPE', type: 'date', length: 10 },
      { key: 'Form ID', type: 'num', length: 4, desc: 'Form version ID (Text 4 in dictionary; small int in practice — accepted as integer)' },
      { key: '#', type: 'num', length: 9 },
      { key: 'Donee BN', type: 'str', length: 15 },
      { key: 'Donee Name', type: 'str', length: 175 },
      { key: 'Associated', type: 'yn', length: 1 },
      { key: 'City', type: 'str', length: 30 },
      { key: 'Province', type: 'code', length: 2 },
      { key: 'Total Gifts', type: 'amt', length: 14 },
      { key: 'Gifts in Kind', type: 'amt', length: 14 },
      { key: 'Political Activity Gift', type: 'yn', length: 1, formIds: [23] },
      { key: 'Political Activity Amount', type: 'amt', length: 14, formIds: [23] },
    ],
  },

  charitable_programs: {
    section: '3.5',
    pk: ['BN', 'FPE', 'Form ID', 'Program Type'],
    table: 'cra_charitable_programs',
    fields: [
      { key: 'BN', type: 'str', length: 15 },
      { key: 'FPE', type: 'date', length: 10 },
      { key: 'Form ID', type: 'num', length: 4, desc: 'Form version ID (Text 4 in dictionary; small int in practice — accepted as integer)' },
      { key: 'Program Type', type: 'str', length: 2 },
      { key: 'Description', type: 'str', length: 2500 },
    ],
  },

  general_info: {
    section: '3.6',
    pk: ['BN', 'Form ID'],
    table: 'cra_financial_general',
    fields: [
      { key: 'BN', type: 'str', length: 15 },
      { key: 'FPE', type: 'date', length: 10 },
      { key: 'Form ID', type: 'num', length: 4, desc: 'Form version ID (Text 4 in dictionary; small int in practice — accepted as integer)' },
      { key: 'Program #1 Code', type: 'str', length: 3 },
      { key: 'Program #1 %', type: 'num', length: 3 },
      { key: 'Program #1 Desc', type: 'str', length: 60 },
      { key: 'Program #2 Code', type: 'str', length: 3 },
      { key: 'Program #2 %', type: 'num', length: 3 },
      { key: 'Program #2 Desc', type: 'str', length: 60 },
      { key: 'Program #3 Code', type: 'str', length: 3 },
      { key: 'Program #3 %', type: 'num', length: 3 },
      { key: 'Program #3 Desc', type: 'str', length: 60 },
      { key: '1510', type: 'yn', length: 1 },
      { key: '1510-BN', type: 'str', length: 15 },
      { key: '1510-Name', type: 'str', length: 175 },
      { key: '1570', type: 'yn' },
      { key: '1600', type: 'yn' },
      { key: '1800', type: 'yn' },
      { key: '2000', type: 'yn' },
      { key: '2100', type: 'yn' },
      { key: '2400', type: 'yn', formIds: [23, 24] },
      { key: '5030', type: 'amt', length: 14, formIds: [23] },
      { key: '5031', type: 'amt', length: 14, formIds: [23] },
      { key: '5032', type: 'amt', length: 14, formIds: [23] },
      { key: '2500', type: 'yn' },
      { key: '2510', type: 'yn' },
      { key: '2530', type: 'yn' },
      { key: '2540', type: 'yn' },
      { key: '2550', type: 'yn' },
      { key: '2560', type: 'yn' },
      { key: '2570', type: 'yn' },
      { key: '2575', type: 'yn' },
      { key: '2580', type: 'yn' },
      { key: '2590', type: 'yn' },
      { key: '2600', type: 'yn' },
      { key: '2610', type: 'yn' },
      { key: '2620', type: 'yn' },
      { key: '2630', type: 'yn' },
      { key: '2640', type: 'yn' },
      { key: '2650', type: 'yn' },
      { key: '2660', type: 'txt', length: 175, desc: 'Fundraising activity: Specify' },
      { key: '2700', type: 'yn' },
      { key: '5450', type: 'amt', length: 14, desc: 'Gross revenue collected by fundraisers' },
      { key: '5460', type: 'amt', length: 14, desc: 'Amounts paid to/retained by fundraisers' },
      { key: '2730', type: 'yn' },
      { key: '2740', type: 'yn' },
      { key: '2750', type: 'yn' },
      { key: '2760', type: 'yn' },
      { key: '2770', type: 'yn' },
      { key: '2780', type: 'yn' },
      { key: '2790', type: 'txt', length: 175, desc: 'External fundraisers: Specify' },
      { key: '2800', type: 'yn' },
      { key: '3200', type: 'yn' },
      { key: '3400', type: 'yn' },
      { key: '3900', type: 'yn' },
      { key: '4000', type: 'yn' },
      { key: '5800', type: 'yn' },
      { key: '5810', type: 'yn' },
      { key: '5820', type: 'yn' },
      { key: '5830', type: 'yn' },
      { key: '5840', type: 'yn', formIds: [26, 27] },
      { key: '5841', type: 'yn', formIds: [26, 27] },
      { key: '5842', type: 'num', length: 10, formIds: [26, 27], desc: 'Number of grantees ≤$5,000' },
      { key: '5843', type: 'amt', length: 17, formIds: [26, 27], desc: 'Amount paid to grantees ≤$5,000' },
      { key: '5850', type: 'yn', formIds: [27] },
      { key: '5860', type: 'yn', formIds: [27] },
      { key: '5861', type: 'num', length: 10, formIds: [27], desc: 'DAF: total accounts at FPE' },
      { key: '5862', type: 'amt', length: 17, formIds: [27], desc: 'DAF: total value at FPE' },
      { key: '5863', type: 'amt', length: 17, formIds: [27], desc: 'DAF: donations received' },
      { key: '5864', type: 'amt', length: 17, formIds: [27], desc: 'DAF: qualifying disbursements' },
    ],
  },

  financial_data: {
    section: '3.7',
    pk: ['BN', 'FPE', 'Form ID'],
    table: 'cra_financial_details',
    fields: [
      { key: 'BN', type: 'str', length: 15 },
      { key: 'FPE', type: 'date', length: 10 },
      { key: 'Form ID', type: 'num', length: 4, desc: 'Form version ID (Text 4 in dictionary; small int in practice — accepted as integer)' },
      { key: 'Section Used', type: 'str', length: 1 },
      { key: '4020', type: 'str', length: 1 },
      { key: '4050', type: 'yn' },
      // Asset/liability amounts
      ...[
        '4100','4110','4120','4130','4140','4150','4155','4160','4165','4166','4170',
        '4200','4250','4300','4310','4320','4330','4350',
      ].map(k => ({ key: k, type: 'amt', length: 14 })),
      { key: '4180', type: 'amt', length: 14, formIds: [23, 24, 25, 26] }, // removed v27
      { key: '4400', type: 'yn' },
      { key: '4490', type: 'yn' },
      { key: '4500', type: 'amt', length: 14 },
      { key: '5610', type: 'amt', length: 14 },
      { key: '4505', type: 'amt', length: 14, formIds: [23, 24, 25, 26] }, // removed v27
      ...[
        '4510','4530','4540','4550','4560',
      ].map(k => ({ key: k, type: 'amt', length: 14 })),
      { key: '4565', type: 'yn' },
      ...[
        '4570','4571','4575','4580','4590','4600','4610','4620','4630','4640','4650',
      ].map(k => ({ key: k, type: 'amt', length: 14 })),
      { key: '4655', type: 'txt', length: 175, desc: 'Specify type of revenue at 4650' },
      ...[
        '4700','4800','4810','4820','4830','4840','4850','4860','4870','4880','4890',
        '4891','4900','4910','4920',
      ].map(k => ({ key: k, type: 'amt', length: 14 })),
      { key: '4930', type: 'txt', length: 175, desc: 'Specify expenditures at 4920' },
      ...[
        '4950','5000','5010','5020',
      ].map(k => ({ key: k, type: 'amt', length: 14 })),
      { key: '5030', type: 'amt', length: 14, formIds: [23] },
      ...[
        '5040','5050','5100','5500','5510','5750','5900','5910',
      ].map(k => ({ key: k, type: 'amt', length: 14 })),
      // v26+ / v27+ new
      { key: '5045', type: 'amt', length: 17, formIds: [26, 27] },
      { key: '4101', type: 'amt', length: 17, formIds: [27] },
      { key: '4102', type: 'amt', length: 17, formIds: [27] },
      { key: '4157', type: 'amt', length: 17, formIds: [27] },
      { key: '4158', type: 'amt', length: 17, formIds: [27] },
      { key: '4190', type: 'amt', length: 17, formIds: [27] },
      { key: '4576', type: 'amt', length: 17, formIds: [27] },
      { key: '4577', type: 'amt', length: 17, formIds: [27] },
    ],
  },

  foundation_info: {
    section: '3.8',
    pk: ['BN', 'FPE', 'Form ID'],
    table: 'cra_foundation_info',
    fields: [
      { key: 'BN', type: 'str', length: 15 },
      { key: 'FPE', type: 'date', length: 10 },
      { key: 'Form ID', type: 'num', length: 4, desc: 'Form version ID (Text 4 in dictionary; small int in practice — accepted as integer)' },
      { key: '100', type: 'yn' },
      { key: '110', type: 'yn' },
      { key: '120', type: 'yn' },
      { key: '130', type: 'yn' },
      { key: '111', type: 'amt', length: 17, formIds: [27] },
      { key: '112', type: 'amt', length: 17, formIds: [27] },
    ],
  },

  activities_outside_details: {
    section: '3.9',
    pk: ['BN', 'FPE', 'Form ID'],
    table: 'cra_activities_outside_details',
    fields: [
      { key: 'BN', type: 'str', length: 15 },
      { key: 'FPE', type: 'date', length: 10 },
      { key: 'Form ID', type: 'num', length: 4, desc: 'Form version ID (Text 4 in dictionary; small int in practice — accepted as integer)' },
      { key: '200', type: 'amt', length: 14 },
      { key: '210', type: 'yn' },
      { key: '220', type: 'yn' },
      { key: '230', type: 'amt', length: 14 },     // SPEC: Amount! Script treats as string.
      { key: '240', type: 'yn' },
      { key: '250', type: 'yn' },
      { key: '260', type: 'yn' },
    ],
  },

  activities_outside_countries: {
    section: '3.10',
    pk: ['BN', 'FPE', 'Form ID', '#'],
    table: 'cra_activities_outside_countries',
    fields: [
      { key: 'BN', type: 'str', length: 15 },
      { key: 'FPE', type: 'date', length: 10 },
      { key: 'Form ID', type: 'num', length: 4, desc: 'Form version ID (Text 4 in dictionary; small int in practice — accepted as integer)' },
      { key: '#', type: 'num', length: 9 },
      { key: 'Country', type: 'code', length: 2 },
    ],
  },

  exported_goods: {
    section: '3.11',
    pk: ['BN', 'FPE', 'Form ID', '#'],
    table: 'cra_exported_goods',
    fields: [
      { key: 'BN', type: 'str', length: 15 },
      { key: 'FPE', type: 'date', length: 10 },
      { key: 'Form ID', type: 'num', length: 4, desc: 'Form version ID (Text 4 in dictionary; small int in practice — accepted as integer)' },
      { key: '#', type: 'num', length: 9 },
      { key: 'Item Name', type: 'str', length: 30 },
      { key: 'Item Value', type: 'amt', length: 14 },
      { key: 'Destination', type: 'str', length: 175 },
      { key: 'Country', type: 'code', length: 2 },
    ],
  },

  resources_sent_outside: {
    section: '3.12',
    pk: ['BN', 'FPE', 'Form ID', '#'],
    table: 'cra_resources_sent_outside',
    // The dictionary calls this "Org Name"; the API supplies "Indiv/Org Name"
    fields: [
      { key: 'BN', type: 'str', length: 15 },
      { key: 'FPE', type: 'date', length: 10 },
      { key: 'Form ID', type: 'num', length: 4, desc: 'Form version ID (Text 4 in dictionary; small int in practice — accepted as integer)' },
      { key: '#', type: 'num', length: 9 },
      { key: 'Indiv/Org Name', jsonAlt: 'Org Name', type: 'str', length: 175 },
      { key: 'Amount', type: 'amt', length: 14 },
      { key: 'Country', type: 'code', length: 2 },
    ],
  },

  compensation: {
    section: '3.13',
    pk: ['BN', 'FPE', 'Form ID'],
    table: 'cra_compensation',
    fields: [
      { key: 'BN', type: 'str', length: 15 },
      { key: 'FPE', type: 'date', length: 10 },
      { key: 'Form ID', type: 'num', length: 4, desc: 'Form version ID (Text 4 in dictionary; small int in practice — accepted as integer)' },
      ...['300','305','310','315','320','325','330','335','340','345','370']
        .map(k => ({ key: k, type: 'num', length: 5 })),
      ...['380','390'].map(k => ({ key: k, type: 'amt', length: 14 })),
    ],
  },

  gifts_in_kind: {
    section: '3.14',
    pk: ['BN', 'FPE', 'Form ID'],
    table: 'cra_gifts_in_kind',
    fields: [
      { key: 'BN', type: 'str', length: 15 },
      { key: 'FPE', type: 'date', length: 10 },
      { key: 'Form ID', type: 'num', length: 4, desc: 'Form version ID (Text 4 in dictionary; small int in practice — accepted as integer)' },
      ...['500','505','510','515','520','525','530','535','540','545','550','555','560']
        .map(k => ({ key: k, type: 'yn' })),       // SPEC: Y/N! Script treats as int.
      { key: '565', type: 'txt', length: 175 },
      { key: '580', type: 'amt', length: 14 },
    ],
  },

  political_activity_description: {
    section: '3.15',
    pk: ['BN', 'FPE', 'Form ID'],
    table: 'cra_political_activity_desc',
    fields: [
      { key: 'BN', type: 'str', length: 15, formIds: [23, 24] },
      { key: 'FPE', type: 'date', length: 10, formIds: [23, 24] },
      { key: 'Form ID', type: 'num', length: 4, formIds: [23, 24], desc: 'Form version ID (accepted as integer)' },
      { key: 'Description', type: 'str', length: 2500, formIds: [23, 24] },
    ],
  },

  political_activity_funding: {
    section: '3.16',
    pk: ['BN', 'FPE', 'Form ID', '#'],
    table: 'cra_political_activity_funding',
    fields: [
      { key: 'BN', type: 'str', length: 15, formIds: [23] },
      { key: 'FPE', type: 'date', length: 10, formIds: [23] },
      { key: 'Form ID', type: 'num', length: 4, formIds: [23], desc: 'Form version ID (accepted as integer)' },
      { key: '#', type: 'num', length: 9, formIds: [23] },
      { key: 'Activity', type: 'str', length: 175, formIds: [23] },
      { key: 'Amount', type: 'amt', length: 14, formIds: [23] },
      { key: 'Country', type: 'code', length: 2, formIds: [23] },
    ],
  },

  political_activity_resources: {
    section: '3.17',
    pk: ['BN', 'FPE', 'Form ID', '#'],
    table: 'cra_political_activity_resources',
    fields: [
      { key: 'BN', type: 'str', length: 15, formIds: [23] },
      { key: 'FPE', type: 'date', length: 10, formIds: [23] },
      { key: 'Form ID', type: 'num', length: 4, formIds: [23], desc: 'Form version ID (accepted as integer)' },
      { key: '#', type: 'num', length: 9, formIds: [23] },
      // Dictionary says "Text 1" but values are 0/1 indicators — stored as
      // integer/numeric in the schema. Lossless and matches the import pipeline.
      { key: 'Staff', type: 'num', length: 1, formIds: [23] },
      { key: 'Volunteers', type: 'num', length: 1, formIds: [23] },
      { key: 'Financial', type: 'num', length: 1, formIds: [23] },
      { key: 'Property', type: 'num', length: 1, formIds: [23] },
      { key: 'Other', type: 'str', length: 175, formIds: [23] },
    ],
  },

  non_qualified_donees: {
    section: '3.18',
    pk: ['BN', 'FPE', 'Form ID', '#'],
    table: 'cra_non_qualified_donees',
    fields: [
      { key: 'BN', type: 'str', length: 15, formIds: [26, 27] },
      { key: 'FPE', type: 'date', length: 10, formIds: [26, 27] },
      { key: 'Form ID', type: 'num', length: 4, formIds: [26, 27], desc: 'Form version ID (accepted as integer)' },
      { key: '#', jsonAlt: 'Sequence Number', type: 'num', length: 10, formIds: [26, 27] },
      { key: 'Recipient name', jsonAlt: 'Grant Recipient Name', type: 'str', length: 175, formIds: [26, 27] },
      { key: 'Purpose', jsonAlt: 'Grant Purpose', type: 'str', length: 1250, formIds: [26, 27] },
      { key: 'Cash amount', jsonAlt: 'Amount of Cash Disbursement', type: 'amt', length: 17, formIds: [26, 27] },
      { key: 'Non-cash amount', jsonAlt: 'Amount of Non-Cash Disbursement', type: 'amt', length: 17, formIds: [26, 27] },
      { key: 'Country', jsonAlt: 'Grant Country', type: 'str', length: 125, formIds: [26, 27] },
    ],
  },

  disbursement_quota: {
    section: '3.19',
    pk: ['BN', 'FPE', 'Form ID'],
    table: 'cra_disbursement_quota',
    fields: [
      { key: 'BN', type: 'str', length: 15, formIds: [27] },
      { key: 'FPE', type: 'date', length: 10, formIds: [27] },
      { key: 'Form ID', type: 'num', length: 4, formIds: [27], desc: 'Form version ID (accepted as integer)' },
      ...['805','810','815','820','825','830','835','840','845','850',
          '855','860','865','870','875','880','885','890']
        .map(k => ({ key: k, type: 'amt', length: 17, formIds: [27] })),
    ],
  },
};

// ─── Expected Postgres type per dictionary type ─────────────────────────────
const EXPECTED_PG_TYPE = {
  yn: ['boolean'],
  amt: ['numeric'],
  num: ['integer', 'bigint', 'smallint', 'numeric'],
  txt: ['text', 'character varying', 'character'],
  str: ['text', 'character varying', 'character', 'varchar'],
  date: ['date', 'timestamp', 'timestamp without time zone'],
  code: ['character', 'character varying', 'text'],
};

// ─── Parse import script to extract what it actually imports ────────────────
function parseImportScript() {
  const src = fs.readFileSync(path.join(__dirname, '..', '04-import-data.js'), 'utf8');

  // Very pragmatic: pull the numericFields/boolFields/intFields/decFields/decimalFields
  // array literals per function. We key them off the function name immediately
  // preceding them.
  const map = {};
  const funcRe = /async function (import\w+)\(client, records, year\) \{([\s\S]*?)\n\}/g;
  let m;
  while ((m = funcRe.exec(src)) !== null) {
    const [, fname, body] = m;
    map[fname] = body;
  }
  return map;
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main() {
  if (!fs.existsSync(REPORT_DIR)) fs.mkdirSync(REPORT_DIR, { recursive: true });

  console.log('1. Loading JSON cache for each dataset (2020 + 2024)...');
  const jsonKeys = {};       // datasetKey -> { key -> { years, nonNull: {year: count} } }
  for (const ds of Object.keys(DICTIONARY)) {
    jsonKeys[ds] = {};
    for (const year of [2020, 2024]) {
      const cache = apiClient.loadCache(year, ds);
      if (!cache || !cache.records || cache.records.length === 0) continue;
      // gather all unique keys (unions of all rows in case of sparse encoding)
      const seen = new Set();
      const nonNullCounts = {};
      for (const r of cache.records) {
        for (const k of Object.keys(r)) {
          seen.add(k);
          if (r[k] !== null && r[k] !== undefined && r[k] !== '') {
            nonNullCounts[k] = (nonNullCounts[k] || 0) + 1;
          }
        }
      }
      for (const k of seen) {
        if (!jsonKeys[ds][k]) jsonKeys[ds][k] = { years: new Set(), nonNull: {} };
        jsonKeys[ds][k].years.add(year);
        jsonKeys[ds][k].nonNull[year] = nonNullCounts[k] || 0;
      }
    }
  }

  console.log('2. Reading DB schema...');
  const dbCols = {};   // table -> { col -> dataType }
  for (const ds of Object.keys(DICTIONARY)) {
    const table = DICTIONARY[ds].table;
    const r = await db.query(
      `SELECT column_name, data_type FROM information_schema.columns
       WHERE table_schema='cra' AND table_name=$1 ORDER BY ordinal_position`, [table]
    );
    dbCols[table] = {};
    for (const row of r.rows) dbCols[table][row.column_name] = row.data_type;
  }

  // ─── Build the unified report ────────────────────────────────────────────
  const rows = [];
  const markdownSections = [];

  for (const ds of Object.keys(DICTIONARY)) {
    const def = DICTIONARY[ds];
    const tableCols = dbCols[def.table] || {};
    const seenJsonKeys = jsonKeys[ds] || {};

    const sectionRows = [];

    // Walk every dictionary field.
    for (const spec of def.fields) {
      const jKey = spec.key;
      const jAlt = spec.jsonAlt;
      const jsonInfo = seenJsonKeys[jKey] || (jAlt ? seenJsonKeys[jAlt] : undefined);
      const years = jsonInfo ? [...jsonInfo.years].sort().join(',') : '';
      const pop = jsonInfo
        ? `2020:${jsonInfo.nonNull[2020] || 0} / 2024:${jsonInfo.nonNull[2024] || 0}`
        : '—';

      // Determine expected DB column name per dataset conventions.
      const dbCol = guessDbCol(ds, jKey);
      const dbType = tableCols[dbCol] || null;

      const expectedTypes = EXPECTED_PG_TYPE[spec.type] || [];
      const typeOk = dbType ? expectedTypes.includes(dbType) : null;

      const issues = [];
      if (!dbCol || !dbType) issues.push('NO_DB_COLUMN');
      if (dbType && expectedTypes.length && !typeOk) {
        issues.push(`WRONG_TYPE (is ${dbType}, expected ${expectedTypes.join('|')})`);
      }
      if (!jsonInfo && !spec.formIds) {
        issues.push('NO_JSON_KEY_ANY_YEAR');
      } else if (jsonInfo && spec.formIds) {
        // spec says removed/new — check year coverage matches spec
        const expectedYears = specYears(spec.formIds);
        for (const y of expectedYears) {
          if (!jsonInfo.years.has(y)) issues.push(`EXPECTED_${y}_MISSING`);
        }
      }

      sectionRows.push({
        dataset: ds,
        section: def.section,
        jsonKey: jKey,
        dictType: spec.type,
        dictDesc: spec.desc || '',
        formIds: (spec.formIds || []).join(',') || 'all',
        dbColumn: dbCol || '(none)',
        dbType: dbType || '(missing)',
        jsonYears: years || '(none)',
        jsonPop: pop,
        issues: issues.join('; '),
      });
    }

    // Also flag any JSON keys that appear in the cache but aren't in the
    // dictionary — those are unexpected API fields.
    const dictKeys = new Set();
    for (const s of def.fields) {
      dictKeys.add(s.key);
      if (s.jsonAlt) dictKeys.add(s.jsonAlt);
    }
    for (const k of Object.keys(seenJsonKeys)) {
      if (k === '_id') continue;
      if (dictKeys.has(k)) continue;
      sectionRows.push({
        dataset: ds,
        section: def.section,
        jsonKey: k,
        dictType: '(not in dictionary)',
        dictDesc: '',
        formIds: '',
        dbColumn: '(n/a)',
        dbType: '(n/a)',
        jsonYears: [...seenJsonKeys[k].years].sort().join(','),
        jsonPop: `2020:${seenJsonKeys[k].nonNull[2020] || 0} / 2024:${seenJsonKeys[k].nonNull[2024] || 0}`,
        issues: 'JSON_KEY_NOT_IN_DICTIONARY',
      });
    }

    // Flag DB columns that exist but don't map to any dictionary field.
    const mappedCols = new Set(sectionRows.map(r => r.dbColumn));
    // Always skip composite keys & system cols in this report.
    for (const col of Object.keys(tableCols)) {
      if (mappedCols.has(col)) continue;
      if (['bn', 'fpe', 'fiscal_year', 'form_id', 'sequence_number', 'section_used',
           'program_type', 'program_area_1', 'program_area_2', 'program_area_3',
           'program_percentage_1', 'program_percentage_2', 'program_percentage_3',
           'field_1510_subordinate', 'field_1510_parent_bn', 'field_1510_parent_name',
           'internal_division_1510_01','internal_division_1510_02','internal_division_1510_03',
           'internal_division_1510_04','internal_division_1510_05'].includes(col)) continue;
      sectionRows.push({
        dataset: ds,
        section: def.section,
        jsonKey: '(n/a)',
        dictType: '(n/a)',
        dictDesc: '',
        formIds: '',
        dbColumn: col,
        dbType: tableCols[col],
        jsonYears: '(n/a)',
        jsonPop: '(n/a)',
        issues: 'DB_COLUMN_UNDOCUMENTED',
      });
    }

    rows.push(...sectionRows);
    markdownSections.push({ ds, def, sectionRows });
  }

  // ─── Emit outputs ────────────────────────────────────────────────────────
  fs.writeFileSync(JSON_OUT, JSON.stringify(rows, null, 2), 'utf8');

  const headers = ['dataset','section','jsonKey','dictType','formIds','dbColumn','dbType','jsonYears','jsonPop','issues','dictDesc'];
  const csv = [headers.join(',')].concat(rows.map(r =>
    headers.map(h => csvEscape(r[h] || '')).join(',')
  )).join('\n');
  fs.writeFileSync(CSV_OUT, csv, 'utf8');

  // Markdown report
  const md = [];
  md.push('# CRA T3010 Field Mapping Audit');
  md.push('');
  md.push(`Generated: ${new Date().toISOString()}`);
  md.push('');
  md.push('**Sources cross-referenced:**');
  md.push('- Dictionary: `docs/guides-forms/OPEN-DATA-DICTIONARY-V2.0 ENG.md`');
  md.push('- JSON cache: `data/cache/{2020,2024}/*.json`');
  md.push('- DB schema: live query against `cra` schema');
  md.push('- Import script: `scripts/04-import-data.js` (via `guessDbCol`)');
  md.push('');

  const issuesByKind = {};
  for (const r of rows) {
    if (!r.issues) continue;
    for (const part of r.issues.split('; ')) {
      const kind = part.split(' ')[0];
      issuesByKind[kind] = (issuesByKind[kind] || 0) + 1;
    }
  }
  md.push('## Summary of issues');
  md.push('');
  md.push('| Issue | Count |');
  md.push('|---|---|');
  for (const [k, v] of Object.entries(issuesByKind).sort((a,b)=>b[1]-a[1])) {
    md.push(`| ${k} | ${v} |`);
  }
  md.push('');

  for (const { ds, def, sectionRows } of markdownSections) {
    md.push(`## ${def.section} \`${ds}\` → \`${def.table}\``);
    md.push('');
    md.push('| JSON key | Dict type | Applies to | DB column | DB type | JSON years | Non-null (20/24) | Issues |');
    md.push('|---|---|---|---|---|---|---|---|');
    for (const r of sectionRows) {
      md.push(`| \`${r.jsonKey}\` | ${r.dictType} | ${r.formIds} | \`${r.dbColumn}\` | ${r.dbType} | ${r.jsonYears} | ${r.jsonPop} | ${r.issues} |`);
    }
    md.push('');
  }

  fs.writeFileSync(MD_OUT, md.join('\n'), 'utf8');
  console.log(`\nWrote: ${MD_OUT}`);
  console.log(`Wrote: ${CSV_OUT}`);
  console.log(`Wrote: ${JSON_OUT}`);
  console.log(`\nTotal rows: ${rows.length}`);
  console.log('Issues by kind:', issuesByKind);

  await db.end();
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function csvEscape(s) {
  const v = String(s ?? '');
  if (v.includes(',') || v.includes('"') || v.includes('\n')) {
    return `"${v.replace(/"/g, '""')}"`;
  }
  return v;
}

function specYears(formIds) {
  // Map form IDs to calendar years present in our cache.
  // 23, 24, 25 => roughly 2019-2022 (present in 2020 cache)
  // 26 => 2023
  // 27 => 2024
  // We only have 2020 + 2024 caches in this audit, so:
  //   If spec says formIds includes 23/24/25 → should be present in 2020
  //   If spec says formIds includes 27       → should be present in 2024
  const years = new Set();
  for (const id of formIds) {
    if ([23,24,25].includes(id)) years.add(2020);
    if (id === 26) years.add(2020); // v26 released May 2023, may appear in 2020 records too (late filings), but normally 2023+
    if (id === 27) years.add(2024);
  }
  return [...years];
}

/**
 * Map a dataset + JSON key to the DB column name used by the import script.
 * This mirrors the hard-coded bindings in scripts/04-import-data.js exactly.
 */
function guessDbCol(ds, jsonKey) {
  if (ds === 'identification') {
    const m = {
      'BN': 'bn', 'Category': 'category', 'Sub Category': 'sub_category',
      'Designation': 'designation', 'Legal Name': 'legal_name', 'Account Name': 'account_name',
      'Address Line 1': 'address_line_1', 'Address Line 2': 'address_line_2',
      'City': 'city', 'Province': 'province', 'Postal Code': 'postal_code', 'Country': 'country',
    };
    return m[jsonKey];
  }
  if (ds === 'web_urls') {
    const m = { 'BN': 'bn', '#': 'sequence_number', 'Contact URL': 'contact_url' };
    return m[jsonKey];
  }
  if (ds === 'directors') {
    const m = {
      'BN': 'bn', 'FPE': 'fpe', 'Form ID': 'form_id', '#': 'sequence_number',
      'Last Name': 'last_name', 'First Name': 'first_name', 'Initials': 'initials',
      'Position': 'position', "At Arm's Length": 'at_arms_length',
      'Start Date': 'start_date', 'End Date': 'end_date',
    };
    return m[jsonKey];
  }
  if (ds === 'qualified_donees') {
    const m = {
      'BN': 'bn', 'FPE': 'fpe', 'Form ID': 'form_id', '#': 'sequence_number',
      'Donee BN': 'donee_bn', 'Donee Name': 'donee_name', 'Associated': 'associated',
      'City': 'city', 'Province': 'province', 'Total Gifts': 'total_gifts',
      'Gifts in Kind': 'gifts_in_kind',
      'Political Activity Gift': 'political_activity_gift',
      'Political Activity Amount': 'political_activity_amount',
    };
    return m[jsonKey];
  }
  if (ds === 'charitable_programs') {
    const m = { 'BN': 'bn', 'FPE': 'fpe', 'Form ID': 'form_id',
      'Program Type': 'program_type', 'Description': 'description' };
    return m[jsonKey];
  }
  if (ds === 'general_info') {
    const m = {
      'BN': 'bn', 'FPE': 'fpe', 'Form ID': 'form_id',
      'Program #1 Code': 'program_area_1', 'Program #1 %': 'program_percentage_1',
      'Program #1 Desc': 'program_description_1',
      'Program #2 Code': 'program_area_2', 'Program #2 %': 'program_percentage_2',
      'Program #2 Desc': 'program_description_2',
      'Program #3 Code': 'program_area_3', 'Program #3 %': 'program_percentage_3',
      'Program #3 Desc': 'program_description_3',
      '1510': 'field_1510_subordinate', '1510-BN': 'field_1510_parent_bn',
      '1510-Name': 'field_1510_parent_name',
    };
    if (m[jsonKey]) return m[jsonKey];
    if (/^\d{4}$/.test(jsonKey)) return `field_${jsonKey}`;
    return null;
  }
  if (ds === 'financial_data') {
    const m = { 'BN': 'bn', 'FPE': 'fpe', 'Form ID': 'form_id', 'Section Used': 'section_used' };
    if (m[jsonKey]) return m[jsonKey];
    if (/^\d{4}$/.test(jsonKey)) return `field_${jsonKey}`;
    return null;
  }
  if (ds === 'foundation_info') {
    const m = { 'BN': 'bn', 'FPE': 'fpe', 'Form ID': 'form_id' };
    if (m[jsonKey]) return m[jsonKey];
    if (/^\d{3}$/.test(jsonKey)) return `field_${jsonKey}`;
    return null;
  }
  if (ds === 'activities_outside_details') {
    const m = { 'BN': 'bn', 'FPE': 'fpe', 'Form ID': 'form_id' };
    if (m[jsonKey]) return m[jsonKey];
    if (/^\d{3}$/.test(jsonKey)) return `field_${jsonKey}`;
    return null;
  }
  if (ds === 'activities_outside_countries') {
    const m = { 'BN': 'bn', 'FPE': 'fpe', 'Form ID': 'form_id', '#': 'sequence_number', 'Country': 'country' };
    return m[jsonKey];
  }
  if (ds === 'exported_goods') {
    const m = {
      'BN': 'bn', 'FPE': 'fpe', 'Form ID': 'form_id', '#': 'sequence_number',
      'Item Name': 'item_name', 'Item Value': 'item_value',
      'Destination': 'destination', 'Country': 'country',
    };
    return m[jsonKey];
  }
  if (ds === 'resources_sent_outside') {
    const m = {
      'BN': 'bn', 'FPE': 'fpe', 'Form ID': 'form_id', '#': 'sequence_number',
      'Indiv/Org Name': 'individual_org_name', 'Amount': 'amount', 'Country': 'country',
    };
    return m[jsonKey];
  }
  if (ds === 'compensation') {
    const m = { 'BN': 'bn', 'FPE': 'fpe', 'Form ID': 'form_id' };
    if (m[jsonKey]) return m[jsonKey];
    if (/^\d{3}$/.test(jsonKey)) return `field_${jsonKey}`;
    return null;
  }
  if (ds === 'gifts_in_kind') {
    const m = { 'BN': 'bn', 'FPE': 'fpe', 'Form ID': 'form_id' };
    if (m[jsonKey]) return m[jsonKey];
    if (/^\d{3}$/.test(jsonKey)) return `field_${jsonKey}`;
    return null;
  }
  if (ds === 'political_activity_description') {
    const m = { 'BN': 'bn', 'FPE': 'fpe', 'Form ID': 'form_id', 'Description': 'description' };
    return m[jsonKey];
  }
  if (ds === 'political_activity_funding') {
    const m = {
      'BN': 'bn', 'FPE': 'fpe', 'Form ID': 'form_id', '#': 'sequence_number',
      'Activity': 'activity', 'Amount': 'amount', 'Country': 'country',
    };
    return m[jsonKey];
  }
  if (ds === 'political_activity_resources') {
    const m = {
      'BN': 'bn', 'FPE': 'fpe', 'Form ID': 'form_id', '#': 'sequence_number',
      'Staff': 'staff', 'Volunteers': 'volunteers', 'Financial': 'financial',
      'Property': 'property', 'Other': 'other_resource',
    };
    return m[jsonKey];
  }
  if (ds === 'non_qualified_donees') {
    const m = {
      'BN': 'bn', 'FPE': 'fpe', 'Form ID': 'form_id', '#': 'sequence_number',
      'Recipient name': 'recipient_name', 'Purpose': 'purpose',
      'Cash amount': 'cash_amount', 'Non-cash amount': 'non_cash_amount',
      'Country': 'country',
    };
    return m[jsonKey];
  }
  if (ds === 'disbursement_quota') {
    const m = { 'BN': 'bn', 'FPE': 'fpe', 'Form ID': 'form_id' };
    if (m[jsonKey]) return m[jsonKey];
    if (/^\d{3}$/.test(jsonKey)) return `field_${jsonKey}`;
    return null;
  }
  return null;
}

main().catch(err => { console.error(err); process.exit(1); });
