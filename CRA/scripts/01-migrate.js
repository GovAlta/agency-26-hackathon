/**
 * 01-migrate.js - Database Schema Migration
 *
 * Creates all CRA T3010 tables, indexes, and views.
 * Fully idempotent - safe to run multiple times (uses IF NOT EXISTS / OR REPLACE).
 *
 * Schema supports multiple fiscal years (2020-2024):
 *   - Identification & Web URLs use (bn, fiscal_year) as primary key
 *   - All other tables use (bn, fpe, ...) which naturally supports multi-year data
 *
 * Usage: npm run migrate
 */
const db = require('../lib/db');
const log = require('../lib/logger');

async function migrate() {
  const client = await db.getClient();

  try {
    log.section('CRA T3010 Database Migration');
    log.info('Ensuring cra schema exists...');
    await client.query('CREATE SCHEMA IF NOT EXISTS cra');
    await client.query('SET search_path TO cra, public');
    log.info('Creating tables, indexes, and views...');

    // ─── Lookup Tables ───────────────────────────────────────────

    await client.query(`
      CREATE TABLE IF NOT EXISTS cra_category_lookup (
        code VARCHAR(10) PRIMARY KEY,
        name_en TEXT NOT NULL,
        name_fr TEXT,
        description_en TEXT,
        description_fr TEXT
      );
    `);
    log.info('Created cra_category_lookup');

    await client.query(`
      CREATE TABLE IF NOT EXISTS cra_sub_category_lookup (
        category_code VARCHAR(10) NOT NULL,
        sub_category_code VARCHAR(10) NOT NULL,
        name_en TEXT NOT NULL,
        name_fr TEXT,
        description_en TEXT,
        description_fr TEXT,
        PRIMARY KEY (category_code, sub_category_code)
      );
    `);
    log.info('Created cra_sub_category_lookup');

    await client.query(`
      CREATE TABLE IF NOT EXISTS cra_designation_lookup (
        code CHAR(1) PRIMARY KEY,
        name_en TEXT NOT NULL,
        name_fr TEXT,
        description_en TEXT,
        description_fr TEXT
      );
    `);
    log.info('Created cra_designation_lookup');

    await client.query(`
      CREATE TABLE IF NOT EXISTS cra_country_lookup (
        code CHAR(2) PRIMARY KEY,
        name_en TEXT NOT NULL,
        name_fr TEXT
      );
    `);
    log.info('Created cra_country_lookup');

    await client.query(`
      CREATE TABLE IF NOT EXISTS cra_province_state_lookup (
        code VARCHAR(2) PRIMARY KEY,
        name_en TEXT NOT NULL,
        name_fr TEXT,
        country CHAR(2)
      );
    `);
    log.info('Created cra_province_state_lookup');

    await client.query(`
      CREATE TABLE IF NOT EXISTS cra_program_type_lookup (
        code VARCHAR(2) PRIMARY KEY,
        name_en TEXT NOT NULL,
        name_fr TEXT,
        description_en TEXT,
        description_fr TEXT
      );
    `);
    log.info('Created cra_program_type_lookup');

    // ─── Main Data Tables ────────────────────────────────────────

    // Identification: PK includes fiscal_year for multi-year snapshots
    await client.query(`
      CREATE TABLE IF NOT EXISTS cra_identification (
        bn VARCHAR(15) NOT NULL,
        fiscal_year INTEGER NOT NULL,
        category VARCHAR(10),
        sub_category VARCHAR(10),
        designation CHAR(1),
        legal_name TEXT,
        account_name TEXT,
        address_line_1 TEXT,
        address_line_2 TEXT,
        city TEXT,
        province VARCHAR(2),
        postal_code VARCHAR(10),
        country CHAR(2),
        registration_date DATE,
        language VARCHAR(2),
        contact_phone TEXT,
        contact_email TEXT,
        PRIMARY KEY (bn, fiscal_year)
      );
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_identification_name ON cra_identification USING gin(to_tsvector('english', legal_name));`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_identification_account ON cra_identification USING gin(to_tsvector('english', account_name));`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_identification_category ON cra_identification(category);`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_identification_designation ON cra_identification(designation);`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_identification_province ON cra_identification(province);`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_identification_year ON cra_identification(fiscal_year);`);
    log.info('Created cra_identification with indexes');

    // Web URLs: PK includes fiscal_year
    await client.query(`
      CREATE TABLE IF NOT EXISTS cra_web_urls (
        bn VARCHAR(15) NOT NULL,
        fiscal_year INTEGER NOT NULL,
        sequence_number INTEGER NOT NULL,
        contact_url TEXT,
        PRIMARY KEY (bn, fiscal_year, sequence_number)
      );
    `);
    log.info('Created cra_web_urls');

    // Directors/Officers
    await client.query(`
      CREATE TABLE IF NOT EXISTS cra_directors (
        bn VARCHAR(15) NOT NULL,
        fpe DATE NOT NULL,
        form_id INTEGER,
        sequence_number INTEGER NOT NULL,
        last_name TEXT,
        first_name TEXT,
        initials TEXT,
        position TEXT,
        at_arms_length BOOLEAN,
        start_date DATE,
        end_date DATE,
        PRIMARY KEY (bn, fpe, sequence_number)
      );
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_directors_bn_fpe ON cra_directors(bn, fpe);`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_directors_name ON cra_directors(last_name, first_name);`);
    log.info('Created cra_directors with indexes');

    // Qualified Donees
    await client.query(`
      CREATE TABLE IF NOT EXISTS cra_qualified_donees (
        bn VARCHAR(15) NOT NULL,
        fpe DATE NOT NULL,
        form_id INTEGER,
        sequence_number INTEGER NOT NULL,
        donee_bn VARCHAR(15),
        donee_name TEXT,
        associated BOOLEAN,
        city TEXT,
        province VARCHAR(2),
        total_gifts DECIMAL(18,2),
        gifts_in_kind DECIMAL(18,2),
        number_of_donees INTEGER,
        political_activity_gift BOOLEAN,
        political_activity_amount DECIMAL(18,2),
        PRIMARY KEY (bn, fpe, sequence_number)
      );
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_qualified_donees_bn_fpe ON cra_qualified_donees(bn, fpe);`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_qualified_donees_donee_bn ON cra_qualified_donees(donee_bn);`);
    log.info('Created cra_qualified_donees with indexes');

    // Charitable Programs
    await client.query(`
      CREATE TABLE IF NOT EXISTS cra_charitable_programs (
        bn VARCHAR(15) NOT NULL,
        fpe DATE NOT NULL,
        form_id INTEGER,
        program_type VARCHAR(2),
        description TEXT,
        PRIMARY KEY (bn, fpe, program_type)
      );
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_programs_bn_fpe ON cra_charitable_programs(bn, fpe);`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_programs_description ON cra_charitable_programs USING gin(to_tsvector('english', description));`);
    log.info('Created cra_charitable_programs with indexes');

    // Financial General Info (Sections A/B/C - boolean flags)
    await client.query(`
      CREATE TABLE IF NOT EXISTS cra_financial_general (
        bn VARCHAR(15) NOT NULL,
        fpe DATE NOT NULL,
        form_id INTEGER,
        -- Program areas (API: "Program #N Code", "Program #N %")
        program_area_1 VARCHAR(10),
        program_area_2 VARCHAR(10),
        program_area_3 VARCHAR(10),
        program_percentage_1 INTEGER,
        program_percentage_2 INTEGER,
        program_percentage_3 INTEGER,
        program_description_1 TEXT,          -- "Program #N Desc" Text 60 per dictionary §3.6
        program_description_2 TEXT,
        program_description_3 TEXT,
        -- Internal divisions (pre-2024) and subordinate org fields (2024+)
        internal_division_1510_01 INTEGER,
        internal_division_1510_02 INTEGER,
        internal_division_1510_03 INTEGER,
        internal_division_1510_04 INTEGER,
        internal_division_1510_05 INTEGER,
        field_1510_subordinate BOOLEAN,
        field_1510_parent_bn VARCHAR(15),
        field_1510_parent_name TEXT,
        -- Section A/B/C boolean fields (all years)
        field_1570 BOOLEAN,
        field_1600 BOOLEAN,
        field_1610 BOOLEAN,
        field_1620 BOOLEAN,
        field_1630 BOOLEAN,
        field_1640 BOOLEAN,
        field_1650 BOOLEAN,
        field_1800 BOOLEAN,
        field_2000 BOOLEAN,
        field_2100 BOOLEAN,
        field_2110 BOOLEAN,
        field_2300 BOOLEAN,
        field_2350 BOOLEAN,
        field_2400 BOOLEAN,
        field_2500 BOOLEAN,
        field_2510 BOOLEAN,
        field_2520 BOOLEAN,
        field_2530 BOOLEAN,
        field_2540 BOOLEAN,
        field_2550 BOOLEAN,
        field_2560 BOOLEAN,
        field_2570 BOOLEAN,
        field_2575 BOOLEAN,
        field_2580 BOOLEAN,
        field_2590 BOOLEAN,
        field_2600 BOOLEAN,
        field_2610 BOOLEAN,
        field_2620 BOOLEAN,
        field_2630 BOOLEAN,
        field_2640 BOOLEAN,
        field_2650 BOOLEAN,
        field_2660 TEXT,               -- "Fundraising activity: Specify" (Text 175 per dictionary)
        field_2700 BOOLEAN,
        field_2730 BOOLEAN,
        field_2740 BOOLEAN,
        field_2750 BOOLEAN,
        field_2760 BOOLEAN,
        field_2770 BOOLEAN,
        field_2780 BOOLEAN,
        field_2790 TEXT,               -- "External fundraisers: Specify" (Text 175 per dictionary)
        field_2800 BOOLEAN,
        field_3200 BOOLEAN,
        field_3205 BOOLEAN,
        field_3210 BOOLEAN,
        field_3220 BOOLEAN,
        field_3230 BOOLEAN,
        field_3235 BOOLEAN,
        field_3240 BOOLEAN,
        field_3250 BOOLEAN,
        field_3260 BOOLEAN,
        field_3270 BOOLEAN,
        field_3400 BOOLEAN,
        field_3600 BOOLEAN,
        field_3610 BOOLEAN,
        field_3900 BOOLEAN,
        field_4000 BOOLEAN,
        field_4010 BOOLEAN,
        field_5000 BOOLEAN,
        field_5010 BOOLEAN,
        field_5030 DECIMAL(18,2),       -- Amount 14 per dictionary (v23 only - political activities)
        field_5031 DECIMAL(18,2),       -- Amount 14 per dictionary (v23 only)
        field_5032 DECIMAL(18,2),       -- Amount 14 per dictionary (v23 only)
        field_5450 DECIMAL(18,2),       -- Amount 14 per dictionary (fundraiser gross revenue)
        field_5460 DECIMAL(18,2),       -- Amount 14 per dictionary (fundraiser amounts paid)
        field_5800 BOOLEAN,
        field_5810 BOOLEAN,
        field_5820 BOOLEAN,
        field_5830 BOOLEAN,
        field_5840 BOOLEAN,
        field_5841 BOOLEAN,
        field_5842 INTEGER,             -- Number 10 per dictionary (count of grantees ≤$5,000)
        field_5843 DECIMAL(18,2),       -- Amount 17 per dictionary (total paid to grantees ≤$5,000)
        field_5844 BOOLEAN,
        field_5845 BOOLEAN,
        field_5846 BOOLEAN,
        field_5847 BOOLEAN,
        field_5848 BOOLEAN,
        field_5849 BOOLEAN,
        field_5850 BOOLEAN,
        field_5851 BOOLEAN,
        field_5852 BOOLEAN,
        field_5853 BOOLEAN,
        field_5854 BOOLEAN,
        field_5855 BOOLEAN,
        field_5856 BOOLEAN,
        field_5857 BOOLEAN,
        field_5858 BOOLEAN,
        field_5859 BOOLEAN,
        field_5860 BOOLEAN,
        field_5861 INTEGER,             -- Number 10 per dictionary (DAF account count)
        field_5862 DECIMAL(18,2),       -- Amount 17 per dictionary (DAF total value)
        field_5863 DECIMAL(18,2),       -- Amount 17 per dictionary (DAF donations received)
        field_5864 DECIMAL(18,2),       -- Amount 17 per dictionary (DAF qualifying disbursements)
        PRIMARY KEY (bn, fpe)
      );
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_financial_general_bn_fpe ON cra_financial_general(bn, fpe);`);
    log.info('Created cra_financial_general with indexes');

    // Financial Details (Section D + Schedule 6 - dollar amounts)
    await client.query(`
      CREATE TABLE IF NOT EXISTS cra_financial_details (
        bn VARCHAR(15) NOT NULL,
        fpe DATE NOT NULL,
        form_id INTEGER,
        section_used CHAR(1),
        field_4020 CHAR(1),
        field_4050 BOOLEAN,
        field_4100 DECIMAL(18,2),
        field_4101 DECIMAL(18,2),
        field_4102 DECIMAL(18,2),
        field_4110 DECIMAL(18,2),
        field_4120 DECIMAL(18,2),
        field_4130 DECIMAL(18,2),
        field_4140 DECIMAL(18,2),
        field_4150 DECIMAL(18,2),
        field_4155 DECIMAL(18,2),
        field_4157 DECIMAL(18,2),
        field_4158 DECIMAL(18,2),
        field_4160 DECIMAL(18,2),
        field_4165 DECIMAL(18,2),
        field_4166 DECIMAL(18,2),
        field_4170 DECIMAL(18,2),
        field_4180 DECIMAL(18,2),
        field_4190 DECIMAL(18,2),
        field_4200 DECIMAL(18,2),
        field_4250 DECIMAL(18,2),
        field_4300 DECIMAL(18,2),
        field_4310 DECIMAL(18,2),
        field_4320 DECIMAL(18,2),
        field_4330 DECIMAL(18,2),
        field_4350 DECIMAL(18,2),
        field_4400 BOOLEAN,
        field_4490 BOOLEAN,
        field_4500 DECIMAL(18,2),
        field_4505 DECIMAL(18,2),
        field_4510 DECIMAL(18,2),
        field_4530 DECIMAL(18,2),
        field_4540 DECIMAL(18,2),
        field_4550 DECIMAL(18,2),
        field_4560 DECIMAL(18,2),
        field_4565 BOOLEAN,
        field_4570 DECIMAL(18,2),
        field_4571 DECIMAL(18,2),
        field_4575 DECIMAL(18,2),
        field_4576 DECIMAL(18,2),
        field_4577 DECIMAL(18,2),
        field_4580 DECIMAL(18,2),
        field_4590 DECIMAL(18,2),
        field_4600 DECIMAL(18,2),
        field_4610 DECIMAL(18,2),
        field_4620 DECIMAL(18,2),
        field_4630 DECIMAL(18,2),
        field_4640 DECIMAL(18,2),
        field_4650 DECIMAL(18,2),
        field_4655 TEXT,            -- Text 175 per dictionary §3.7 (specify type of revenue at 4650)
        field_4700 DECIMAL(18,2),
        field_4800 DECIMAL(18,2),
        field_4810 DECIMAL(18,2),
        field_4820 DECIMAL(18,2),
        field_4830 DECIMAL(18,2),
        field_4840 DECIMAL(18,2),
        field_4850 DECIMAL(18,2),
        field_4860 DECIMAL(18,2),
        field_4870 DECIMAL(18,2),
        field_4880 DECIMAL(18,2),
        field_4890 DECIMAL(18,2),
        field_4891 DECIMAL(18,2),
        field_4900 DECIMAL(18,2),
        field_4910 DECIMAL(18,2),
        field_4920 DECIMAL(18,2),
        field_4930 TEXT,            -- Text 175 per dictionary §3.7 (specify expenditures at 4920)
        field_4950 DECIMAL(18,2),
        field_5000 DECIMAL(18,2),
        field_5010 DECIMAL(18,2),
        field_5020 DECIMAL(18,2),
        field_5030 DECIMAL(18,2),
        field_5040 DECIMAL(18,2),
        field_5045 DECIMAL(18,2),
        field_5050 DECIMAL(18,2),
        field_5100 DECIMAL(18,2),
        field_5500 DECIMAL(18,2),
        field_5510 DECIMAL(18,2),
        field_5610 DECIMAL(18,2),
        field_5750 DECIMAL(18,2),
        field_5900 DECIMAL(18,2),
        field_5910 DECIMAL(18,2),
        field_5030_indicator TEXT,
        PRIMARY KEY (bn, fpe)
      );
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_financial_details_bn_fpe ON cra_financial_details(bn, fpe);`);
    log.info('Created cra_financial_details with indexes');

    // Schedule 1 - Foundation Info
    await client.query(`
      CREATE TABLE IF NOT EXISTS cra_foundation_info (
        bn VARCHAR(15) NOT NULL,
        fpe DATE NOT NULL,
        form_id INTEGER,
        field_100 BOOLEAN,          -- Y/N per dictionary §3.8 (acquired control of corporation)
        field_110 BOOLEAN,          -- Y/N per dictionary §3.8 (incurred debts)
        field_111 DECIMAL(18,2),    -- Amount 17 per dictionary §3.8 (v27, restricted funds)
        field_112 DECIMAL(18,2),    -- Amount 17 per dictionary §3.8 (v27, not permitted to spend)
        field_120 BOOLEAN,          -- Y/N per dictionary §3.8 (non-qualifying investments)
        field_130 BOOLEAN,          -- Y/N per dictionary §3.8 (owned >2% shares)
        PRIMARY KEY (bn, fpe)
      );
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_foundation_bn_fpe ON cra_foundation_info(bn, fpe);`);
    log.info('Created cra_foundation_info with indexes');

    // Schedule 2 - Activities Outside Canada Details
    await client.query(`
      CREATE TABLE IF NOT EXISTS cra_activities_outside_details (
        bn VARCHAR(15) NOT NULL,
        fpe DATE NOT NULL,
        form_id INTEGER,
        field_200 DECIMAL(18,2),
        field_210 BOOLEAN,
        field_220 BOOLEAN,
        field_230 TEXT,
        field_240 BOOLEAN,
        field_250 BOOLEAN,
        field_260 BOOLEAN,
        PRIMARY KEY (bn, fpe)
      );
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_activities_details_bn_fpe ON cra_activities_outside_details(bn, fpe);`);
    log.info('Created cra_activities_outside_details with indexes');

    // Schedule 2 - Countries
    await client.query(`
      CREATE TABLE IF NOT EXISTS cra_activities_outside_countries (
        bn VARCHAR(15) NOT NULL,
        fpe DATE NOT NULL,
        form_id INTEGER,
        sequence_number INTEGER NOT NULL,
        country CHAR(2),
        PRIMARY KEY (bn, fpe, sequence_number)
      );
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_activities_countries_bn_fpe ON cra_activities_outside_countries(bn, fpe);`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_activities_countries_country ON cra_activities_outside_countries(country);`);
    log.info('Created cra_activities_outside_countries with indexes');

    // Schedule 2 - Exported Goods
    await client.query(`
      CREATE TABLE IF NOT EXISTS cra_exported_goods (
        bn VARCHAR(15) NOT NULL,
        fpe DATE NOT NULL,
        form_id INTEGER,
        sequence_number INTEGER NOT NULL,
        item_name TEXT,
        item_value DECIMAL(18,2),
        destination TEXT,
        country CHAR(2),
        PRIMARY KEY (bn, fpe, sequence_number)
      );
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_exported_goods_bn_fpe ON cra_exported_goods(bn, fpe);`);
    log.info('Created cra_exported_goods with indexes');

    // Schedule 2 - Resources Sent Outside Canada
    await client.query(`
      CREATE TABLE IF NOT EXISTS cra_resources_sent_outside (
        bn VARCHAR(15) NOT NULL,
        fpe DATE NOT NULL,
        form_id INTEGER,
        sequence_number INTEGER NOT NULL,
        individual_org_name TEXT,
        amount DECIMAL(18,2),
        country CHAR(2),
        PRIMARY KEY (bn, fpe, sequence_number)
      );
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_resources_sent_bn_fpe ON cra_resources_sent_outside(bn, fpe);`);
    log.info('Created cra_resources_sent_outside with indexes');

    // Schedule 3 - Compensation
    await client.query(`
      CREATE TABLE IF NOT EXISTS cra_compensation (
        bn VARCHAR(15) NOT NULL,
        fpe DATE NOT NULL,
        form_id INTEGER,
        field_300 INTEGER,
        field_305 INTEGER,
        field_310 INTEGER,
        field_315 INTEGER,
        field_320 INTEGER,
        field_325 INTEGER,
        field_330 INTEGER,
        field_335 INTEGER,
        field_340 INTEGER,
        field_345 INTEGER,
        field_370 INTEGER,
        field_380 DECIMAL(18,2),
        field_390 DECIMAL(18,2),
        PRIMARY KEY (bn, fpe)
      );
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_compensation_bn_fpe ON cra_compensation(bn, fpe);`);
    log.info('Created cra_compensation with indexes');

    // Schedule 5 - Gifts in Kind
    await client.query(`
      CREATE TABLE IF NOT EXISTS cra_gifts_in_kind (
        bn VARCHAR(15) NOT NULL,
        fpe DATE NOT NULL,
        form_id INTEGER,
        field_500 BOOLEAN,          -- Y/N per dictionary §3.14 (artwork/wine/jewellery)
        field_505 BOOLEAN,          -- Y/N (building materials)
        field_510 BOOLEAN,          -- Y/N (clothing/furniture/food)
        field_515 BOOLEAN,          -- Y/N (vehicles)
        field_520 BOOLEAN,          -- Y/N (cultural properties)
        field_525 BOOLEAN,          -- Y/N (ecological properties)
        field_530 BOOLEAN,          -- Y/N (life insurance policies)
        field_535 BOOLEAN,          -- Y/N (medical equipment/supplies)
        field_540 BOOLEAN,          -- Y/N (privately held securities)
        field_545 BOOLEAN,          -- Y/N (machinery/equipment)
        field_550 BOOLEAN,          -- Y/N (publicly traded securities)
        field_555 BOOLEAN,          -- Y/N (books) — was TEXT storing "Y"/"N" strings
        field_560 BOOLEAN,          -- Y/N (other)       — was TEXT storing "Y"/"N" strings
        field_565 TEXT,             -- Text 175 per dictionary (Other: specify)
        field_580 DECIMAL(18,2),    -- Amount 14 per dictionary
        PRIMARY KEY (bn, fpe)
      );
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_gifts_in_kind_bn_fpe ON cra_gifts_in_kind(bn, fpe);`);
    log.info('Created cra_gifts_in_kind with indexes');

    // Schedule 7 - Political Activity Description
    await client.query(`
      CREATE TABLE IF NOT EXISTS cra_political_activity_desc (
        bn VARCHAR(15) NOT NULL,
        fpe DATE NOT NULL,
        form_id INTEGER,
        description TEXT,
        PRIMARY KEY (bn, fpe)
      );
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_political_desc_bn_fpe ON cra_political_activity_desc(bn, fpe);`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_political_desc_text ON cra_political_activity_desc USING gin(to_tsvector('english', description));`);
    log.info('Created cra_political_activity_desc with indexes');

    // Schedule 7 - Political Activity Funding
    await client.query(`
      CREATE TABLE IF NOT EXISTS cra_political_activity_funding (
        bn VARCHAR(15) NOT NULL,
        fpe DATE NOT NULL,
        form_id INTEGER,
        sequence_number INTEGER NOT NULL,
        activity TEXT,
        amount DECIMAL(18,2),
        country CHAR(2),
        PRIMARY KEY (bn, fpe, sequence_number)
      );
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_political_funding_bn_fpe ON cra_political_activity_funding(bn, fpe);`);
    log.info('Created cra_political_activity_funding with indexes');

    // Schedule 7 - Political Activity Resources
    // staff/volunteers/financial/property are BOOLEAN presence flags per the
    // CRA Open Data Dictionary — source publishes them as "X" markers, not
    // counts/amounts. Prior INTEGER/DECIMAL schema caused parseInt("X")=NaN
    // and dropped every non-null value. See CRA/config/cra-crosswalk.json.
    await client.query(`
      CREATE TABLE IF NOT EXISTS cra_political_activity_resources (
        bn VARCHAR(15) NOT NULL,
        fpe DATE NOT NULL,
        form_id INTEGER,
        sequence_number INTEGER NOT NULL,
        staff BOOLEAN,
        volunteers BOOLEAN,
        financial BOOLEAN,
        property BOOLEAN,
        other_resource TEXT,
        PRIMARY KEY (bn, fpe, sequence_number)
      );
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_political_resources_bn_fpe ON cra_political_activity_resources(bn, fpe);`);
    log.info('Created cra_political_activity_resources with indexes');

    // Non-Qualified Donees
    await client.query(`
      CREATE TABLE IF NOT EXISTS cra_non_qualified_donees (
        bn VARCHAR(15) NOT NULL,
        fpe DATE NOT NULL,
        form_id INTEGER,
        sequence_number INTEGER NOT NULL,
        recipient_name TEXT,
        purpose TEXT,
        cash_amount DECIMAL(18,2),
        non_cash_amount DECIMAL(18,2),
        country TEXT,               -- Text 125 per dictionary §3.18 (list of grant countries; free-text, not 2-char code)
        PRIMARY KEY (bn, fpe, sequence_number)
      );
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_non_qualified_donees_bn_fpe ON cra_non_qualified_donees(bn, fpe);`);
    log.info('Created cra_non_qualified_donees with indexes');

    // Schedule 8 - Disbursement Quota
    await client.query(`
      CREATE TABLE IF NOT EXISTS cra_disbursement_quota (
        bn VARCHAR(15) NOT NULL,
        fpe DATE NOT NULL,
        form_id INTEGER,
        field_805 DECIMAL(18,2),
        field_810 DECIMAL(18,2),
        field_815 DECIMAL(18,2),
        field_820 DECIMAL(18,2),
        field_825 DECIMAL(18,2),
        field_830 DECIMAL(18,2),
        field_835 DECIMAL(18,2),
        field_840 DECIMAL(18,2),
        field_845 DECIMAL(18,2),
        field_850 DECIMAL(18,2),
        field_855 DECIMAL(18,2),
        field_860 DECIMAL(18,2),
        field_865 DECIMAL(18,2),
        field_870 DECIMAL(18,2),
        field_875 DECIMAL(18,2),
        field_880 DECIMAL(18,2),
        field_885 DECIMAL(18,2),
        field_890 DECIMAL(18,2),
        PRIMARY KEY (bn, fpe)
      );
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_disbursement_bn_fpe ON cra_disbursement_quota(bn, fpe);`);
    log.info('Created cra_disbursement_quota with indexes');

    // ─── Views ───────────────────────────────────────────────────

    // Charity profiles with lookup values (uses latest fiscal year)
    await client.query(`
      CREATE OR REPLACE VIEW vw_charity_profiles AS
      SELECT DISTINCT ON (ci.bn)
        ci.bn,
        ci.fiscal_year,
        ci.legal_name,
        ci.account_name,
        ci.address_line_1,
        ci.address_line_2,
        ci.city,
        ci.province,
        psl.name_en AS province_name,
        ci.postal_code,
        ci.country,
        cl.name_en AS country_name,
        ci.category,
        cat.name_en AS category_name,
        ci.sub_category,
        subcat.name_en AS sub_category_name,
        ci.designation,
        dl.name_en AS designation_name,
        dl.description_en AS designation_description
      FROM cra_identification ci
      LEFT JOIN cra_category_lookup cat ON ci.category = cat.code
      LEFT JOIN cra_sub_category_lookup subcat
        ON ci.category = subcat.category_code AND ci.sub_category = subcat.sub_category_code
      LEFT JOIN cra_designation_lookup dl ON ci.designation = dl.code
      LEFT JOIN cra_country_lookup cl ON ci.country = cl.code
      LEFT JOIN cra_province_state_lookup psl ON ci.province = psl.code
      ORDER BY ci.bn, ci.fiscal_year DESC;
    `);
    log.info('Created vw_charity_profiles view');

    // Financial summary by year
    // Schedule 6 field mapping (corrected):
    //   Balance sheet: 4100-4200 (assets), 4300-4350 (liabilities)
    //   Revenue: 4500-4700 (4540=federal govt, 4550=provincial, 4560=municipal)
    //   Expenditures: 4800-4950, allocation: 5000-5100
    await client.query(`
      CREATE OR REPLACE VIEW vw_charity_financials_by_year AS
      SELECT
        fd.bn,
        ci.legal_name,
        ci.account_name,
        fd.fpe AS fiscal_period_end,
        EXTRACT(YEAR FROM fd.fpe) AS fiscal_year,
        fd.field_4700 AS total_revenue,
        fd.field_4500 AS tax_receipted_gifts,
        fd.field_4540 AS federal_government_revenue,
        fd.field_4550 AS provincial_government_revenue,
        fd.field_4560 AS municipal_government_revenue,
        fd.field_4950 AS total_expenditures_before_disbursements,
        fd.field_5000 AS charitable_programs_expenditure,
        fd.field_5010 AS management_and_admin_expenditure,
        fd.field_5020 AS fundraising_expenditure,
        fd.field_5050 AS gifts_to_qualified_donees,
        fd.field_5100 AS total_expenditures,
        fd.field_4200 AS total_assets,
        fd.field_4350 AS total_liabilities,
        (fd.field_4200 - fd.field_4350) AS net_assets
      FROM cra_financial_details fd
      LEFT JOIN cra_identification ci ON fd.bn = ci.bn
        AND ci.fiscal_year = (SELECT MAX(fiscal_year) FROM cra_identification WHERE bn = fd.bn)
      ORDER BY fd.bn, fd.fpe DESC;
    `);
    log.info('Created vw_charity_financials_by_year view');

    // Programs with lookups
    await client.query(`
      CREATE OR REPLACE VIEW vw_charity_programs AS
      SELECT
        cp.bn,
        ci.legal_name,
        ci.account_name,
        cp.fpe AS fiscal_period_end,
        EXTRACT(YEAR FROM cp.fpe) AS fiscal_year,
        cp.program_type,
        ptl.name_en AS program_type_name,
        cp.description
      FROM cra_charitable_programs cp
      LEFT JOIN cra_identification ci ON cp.bn = ci.bn
        AND ci.fiscal_year = (SELECT MAX(fiscal_year) FROM cra_identification WHERE bn = cp.bn)
      LEFT JOIN cra_program_type_lookup ptl ON cp.program_type = ptl.code
      ORDER BY cp.bn, cp.fpe DESC;
    `);
    log.info('Created vw_charity_programs view');

    // ─── Loop Detection & Analysis Tables ─────────────────────────

    // Pruned edge table for cycle detection
    await client.query(`
      CREATE TABLE IF NOT EXISTS cra.loop_edges (
        src         VARCHAR(15) NOT NULL,
        dst         VARCHAR(15) NOT NULL,
        total_amt   NUMERIC NOT NULL DEFAULT 0,
        edge_count  INT NOT NULL DEFAULT 0,
        min_year    INT,
        max_year    INT,
        years       INT[],
        PRIMARY KEY (src, dst)
      );
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_loop_edges_src ON cra.loop_edges (src)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_loop_edges_dst ON cra.loop_edges (dst)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_loop_edges_dst_src ON cra.loop_edges (dst, src)`);

    // Detected cycles
    await client.query(`
      CREATE TABLE IF NOT EXISTS cra.loops (
        id             SERIAL PRIMARY KEY,
        hops           INT NOT NULL,
        path_bns       VARCHAR(15)[] NOT NULL,
        path_display   TEXT NOT NULL UNIQUE,
        bottleneck_amt NUMERIC,
        total_flow     NUMERIC,
        min_year       INT,
        max_year       INT
      );
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_loops_hops ON cra.loops (hops)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_loops_bottleneck ON cra.loops (bottleneck_amt DESC)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_loops_path_bns ON cra.loops USING GIN (path_bns)`);

    // BN-to-loop junction for per-charity queries
    await client.query(`
      CREATE TABLE IF NOT EXISTS cra.loop_participants (
        bn               VARCHAR(15) NOT NULL,
        loop_id          INT NOT NULL REFERENCES cra.loops(id) ON DELETE CASCADE,
        position_in_loop INT NOT NULL,
        sends_to         VARCHAR(15),
        receives_from    VARCHAR(15),
        PRIMARY KEY (loop_id, position_in_loop)
      );
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_loop_part_bn ON cra.loop_participants (bn)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_loop_part_sends ON cra.loop_participants (sends_to)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_loop_part_receives ON cra.loop_participants (receives_from)`);

    // Per-BN aggregate stats and scoring
    await client.query(`
      CREATE TABLE IF NOT EXISTS cra.loop_universe (
        bn                 VARCHAR(15) PRIMARY KEY,
        legal_name         TEXT,
        total_loops        INT DEFAULT 0,
        loops_2hop         INT DEFAULT 0,
        loops_3hop         INT DEFAULT 0,
        loops_4hop         INT DEFAULT 0,
        loops_5hop         INT DEFAULT 0,
        loops_6hop         INT DEFAULT 0,
        loops_7plus        INT DEFAULT 0,
        max_bottleneck     NUMERIC DEFAULT 0,
        total_circular_amt NUMERIC DEFAULT 0,
        scored_at          TIMESTAMP,
        score              INT
      );
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_loop_uni_score ON cra.loop_universe (score DESC NULLS LAST)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_loop_uni_loops ON cra.loop_universe (total_loops DESC)`);

    // Partitioned cycle detection (SCC-based)
    await client.query(`
      CREATE TABLE IF NOT EXISTS cra.partitioned_cycles (
        id             SERIAL PRIMARY KEY,
        hops           INT NOT NULL,
        path_bns       VARCHAR(15)[] NOT NULL,
        path_display   TEXT NOT NULL UNIQUE,
        bottleneck_amt NUMERIC,
        total_flow     NUMERIC,
        min_year       INT,
        max_year       INT,
        tier           VARCHAR(20) NOT NULL,
        source_scc_id  INT,
        source_scc_size INT
      );
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_part_cycles_hops ON cra.partitioned_cycles (hops)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_part_cycles_tier ON cra.partitioned_cycles (tier)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_part_cycles_display ON cra.partitioned_cycles (path_display)`);

    // Hub charities identified during partitioned analysis
    await client.query(`
      CREATE TABLE IF NOT EXISTS cra.identified_hubs (
        bn              VARCHAR(15) PRIMARY KEY,
        legal_name      TEXT,
        scc_id          INT,
        in_degree       INT DEFAULT 0,
        out_degree      INT DEFAULT 0,
        total_degree    INT DEFAULT 0,
        total_inflow    NUMERIC DEFAULT 0,
        total_outflow   NUMERIC DEFAULT 0,
        hub_type        VARCHAR(50)
      );
    `);

    // SCC component membership
    await client.query(`
      CREATE TABLE IF NOT EXISTS cra.scc_components (
        bn             VARCHAR(15) PRIMARY KEY,
        scc_id         INT NOT NULL,
        scc_root       VARCHAR(15) NOT NULL,
        scc_size       INT NOT NULL,
        legal_name     TEXT
      );
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_scc_comp_id ON cra.scc_components (scc_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_scc_comp_size ON cra.scc_components (scc_size DESC)`);

    // SCC summary stats
    await client.query(`
      CREATE TABLE IF NOT EXISTS cra.scc_summary (
        scc_id              INT PRIMARY KEY,
        scc_root            VARCHAR(15) NOT NULL,
        node_count          INT NOT NULL,
        edge_count          INT NOT NULL DEFAULT 0,
        total_internal_flow NUMERIC DEFAULT 0,
        cycle_count_from_loops    INT DEFAULT 0,
        cycle_count_from_johnson  INT DEFAULT 0,
        top_charity_names   TEXT[]
      );
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_scc_summary_size ON cra.scc_summary (node_count DESC)`);

    // Johnson's algorithm cycles
    await client.query(`
      CREATE TABLE IF NOT EXISTS cra.johnson_cycles (
        id             SERIAL PRIMARY KEY,
        hops           INT NOT NULL,
        path_bns       VARCHAR(15)[] NOT NULL,
        path_display   TEXT NOT NULL UNIQUE,
        bottleneck_amt NUMERIC,
        total_flow     NUMERIC,
        min_year       INT,
        max_year       INT
      );
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_johnson_hops ON cra.johnson_cycles (hops)`);

    // Matrix walk census (cross-validation)
    await client.query(`
      CREATE TABLE IF NOT EXISTS cra.matrix_census (
        bn                VARCHAR(15) PRIMARY KEY,
        legal_name        TEXT,
        walks_2           NUMERIC DEFAULT 0,
        walks_3           NUMERIC DEFAULT 0,
        walks_4           NUMERIC DEFAULT 0,
        walks_5           NUMERIC DEFAULT 0,
        walks_6           NUMERIC DEFAULT 0,
        walks_7           NUMERIC DEFAULT 0,
        walks_8           NUMERIC DEFAULT 0,
        max_walk_length   INT DEFAULT 0,
        total_walk_count  NUMERIC DEFAULT 0,
        in_johnson_cycle  BOOLEAN DEFAULT false,
        in_selfjoin_cycle BOOLEAN DEFAULT false,
        scc_id            INT,
        scc_size          INT
      );
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_matrix_census_total ON cra.matrix_census (total_walk_count DESC)`);

    log.info('Created 10 loop detection & analysis tables with indexes');

    log.section('Migration Complete');
    log.info('6 lookup tables + 19 data tables + 10 analysis tables + 3 views created successfully');

  } catch (err) {
    log.error(`Migration failed: ${err.message}`);
    throw err;
  } finally {
    client.release();
    await db.end();
  }
}

migrate().catch((err) => {
  console.error('Fatal migration error:', err);
  process.exit(1);
});
