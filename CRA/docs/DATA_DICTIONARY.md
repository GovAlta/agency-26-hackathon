# CRA T3010 Charity Data Dictionary

> **Database**: PostgreSQL
> **Coverage**: Fiscal Years 2020--2024 (5 years)
> **Last Updated**: 2026-04-18
>
> **2026-04-18 schema refresh:** Field types were reconciled against the CRA
> Open Data Dictionary v2.0 (`docs/guides-forms/OPEN-DATA-DICTIONARY-V2.0 ENG.md`).
> Affected: `cra_foundation_info.field_100/110/120/130` (DECIMAL→BOOLEAN, added
> new `field_111/112`), `cra_gifts_in_kind.field_500-545/555/560` (INT/TEXT→BOOLEAN),
> `cra_financial_general.field_2660/2790` (BOOLEAN→TEXT),
> `cra_financial_general.field_5030/5031/5032/5450/5460/5843/5862-5864`
> (BOOLEAN→DECIMAL), `cra_financial_general.field_5842/5861` (BOOLEAN→INTEGER),
> `cra_financial_details.field_4655/4930` (DECIMAL→TEXT),
> `cra_non_qualified_donees.country` (CHAR(2)→TEXT),
> `cra_financial_general.program_description_1/2/3` (new columns).
> See `data/reports/full-reload-verify.md` for the 6-level verification
> (2,714 checks, 0 failures).

---

## Table of Contents

1. [Overview](#1-overview)
2. [Lookup Tables](#2-lookup-tables)
3. [Data Tables](#3-data-tables)
4. [Views](#4-views)
5. [Key Concepts](#5-key-concepts)
6. [Data Sources & References](#6-data-sources--references)

---

## 1. Overview

This data dictionary documents the PostgreSQL schema used to store **CRA T3010 Registered Charity Information Return** data. The T3010 is the mandatory annual filing that every registered charity in Canada must submit to the Canada Revenue Agency (CRA).

| Attribute             | Value                                                      |
|-----------------------|------------------------------------------------------------|
| **Data Source**       | CRA T3010 Registered Charity Information Return            |
| **Data Portal**       | Government of Canada Open Data Portal (open.canada.ca)     |
| **Coverage**          | 2020, 2021, 2022, 2023, 2024 (5 fiscal years)             |
| **Authoritative Ref** | CRA T4033 Guide -- *Completing the Registered Charity Information Return* (canada.ca) |
| **Database Engine**   | PostgreSQL                                                 |

The schema is organized into three layers:

- **Lookup tables** (6) -- reference/dimension tables for coded values
- **Data tables** (19) -- fact tables holding filing data keyed by Business Number and fiscal period
- **Views** (3) -- pre-joined convenience views for common queries

### Naming Conventions

| Convention              | Example                        | Meaning                                   |
|-------------------------|--------------------------------|-------------------------------------------|
| `cra_` prefix           | `cra_identification`           | All base tables use the `cra_` prefix     |
| `vw_` prefix            | `vw_charity_profiles`          | All views use the `vw_` prefix            |
| `_lookup` suffix        | `cra_category_lookup`          | Lookup/dimension tables                   |
| `field_XXXX`            | `field_4100`                   | Maps directly to T3010 line number XXXX   |
| `bn`                    | `870814944RR0001`              | Business Number (primary identifier)      |
| `fpe`                   | `2023-03-31`                   | Fiscal Period End date                    |

---

## 2. Lookup Tables

There are 6 lookup tables providing human-readable labels for coded values used throughout the data tables.

---

### 2.1 `cra_category_lookup`

CRA charity category codes. Each registered charity is assigned one of 30 category codes describing its primary area of activity.

| Column      | Data Type     | Description                              |
|-------------|---------------|------------------------------------------|
| `code`      | VARCHAR(10)   | CRA category code (e.g. `0001`, `0215`). **Primary Key.** |
| `name_en`   | TEXT          | English category name                    |
| `name_fr`   | TEXT          | French category name                     |

**Row count**: 30 categories (codes range from `0001` to `0215`)

---

### 2.2 `cra_sub_category_lookup`

Sub-category codes that further refine each charity category.

| Column              | Data Type     | Description                                          |
|---------------------|---------------|------------------------------------------------------|
| `category_code`     | VARCHAR(10)   | Parent category code (FK to `cra_category_lookup.code`). **PK (composite).** |
| `sub_category_code` | VARCHAR(10)   | Sub-category code within the parent category. **PK (composite).** |
| `name_en`           | TEXT          | English sub-category name                            |
| `name_fr`           | TEXT          | French sub-category name                             |

**Primary Key**: (`category_code`, `sub_category_code`)
**Row count**: 247 sub-categories

---

### 2.3 `cra_designation_lookup`

Charity designation types. Every registered charity in Canada falls into one of three legal designations.

| Column           | Data Type   | Description                                    |
|------------------|-------------|------------------------------------------------|
| `code`           | CHAR(1)     | Designation code. **Primary Key.**             |
| `name_en`        | TEXT        | English designation name                       |
| `name_fr`        | TEXT        | French designation name                        |
| `description_en` | TEXT        | Extended English description                   |

**Values**:

| Code | Name (EN)              | Description                                                    |
|------|------------------------|----------------------------------------------------------------|
| `A`  | Public Foundation      | Receives funding from multiple arm's-length donors; primarily funds other charities or charitable activities |
| `B`  | Private Foundation     | Generally funded by a single donor or related group; subject to stricter disbursement rules |
| `C`  | Charitable Organization| Directly operates charitable programs; the most common designation |

---

### 2.4 `cra_country_lookup`

Country codes used across the schema for addresses and activity locations.

| Column    | Data Type   | Description                                    |
|-----------|-------------|------------------------------------------------|
| `code`    | CHAR(2)     | Country code. **Primary Key.**                 |
| `name_en` | TEXT        | English country name                           |
| `name_fr` | TEXT        | French country name                            |

**Notes**: Uses ISO 3166-1 alpha-2 codes (e.g. `CA` = Canada, `US` = United States) plus CRA custom codes `QM` through `QZ` for CRA-specific classifications.

---

### 2.5 `cra_province_state_lookup`

Province and state codes for Canadian provinces/territories and US states.

| Column    | Data Type    | Description                                   |
|-----------|--------------|-----------------------------------------------|
| `code`    | VARCHAR(2)   | Province or state code. **Primary Key.**       |
| `name_en` | TEXT         | English province/state name                    |
| `name_fr` | TEXT         | French province/state name                     |

**Examples**: `ON` = Ontario, `BC` = British Columbia, `QC` = Quebec, `CA` = California, `NY` = New York

---

### 2.6 `cra_program_type_lookup`

Program status types used in the `cra_charitable_programs` table.

| Column           | Data Type    | Description                                  |
|------------------|--------------|----------------------------------------------|
| `code`           | VARCHAR(2)   | Program type code. **Primary Key.**          |
| `name_en`        | TEXT         | English program type name                    |
| `name_fr`        | TEXT         | French program type name                     |
| `description_en` | TEXT         | Extended English description                 |

**Values**:

| Code | Name (EN)   | Description                                        |
|------|-------------|----------------------------------------------------|
| `OP` | Ongoing     | Program is currently active and ongoing             |
| `NP` | New         | Program is newly established in this fiscal period  |
| `NA` | Not Active  | Program is no longer active                         |

---

## 3. Data Tables

There are 19 data tables corresponding to the various sections and schedules of the T3010 form. Each table is keyed by Business Number (`bn`) and either fiscal year or Fiscal Period End date (`fpe`).

---

### 3.1 `cra_identification`

Core charity registration and contact information. One row per charity per dataset year.

| Column              | Data Type     | Nullable | Description                                                              |
|---------------------|---------------|----------|--------------------------------------------------------------------------|
| `bn`                | VARCHAR(15)   | NOT NULL | Business Number (e.g. `870814944RR0001`). Format: 9-digit BN root + `RR` + 4-digit program number. |
| `fiscal_year`       | INTEGER       | NOT NULL | The dataset year (2020--2024). This is the year the data was published, NOT a value from the API. |
| `category`          | VARCHAR(10)   |          | CRA charity category code. FK to `cra_category_lookup.code`.            |
| `sub_category`      | VARCHAR(10)   |          | Sub-category code within the category.                                   |
| `designation`       | CHAR(1)       |          | Charity designation: `A`, `B`, or `C`. FK to `cra_designation_lookup.code`. |
| `legal_name`        | TEXT          |          | Official registered legal name of the charity.                           |
| `account_name`      | TEXT          |          | Operating or account name (may differ from legal name).                  |
| `address_line_1`    | TEXT          |          | Mailing address line 1.                                                  |
| `address_line_2`    | TEXT          |          | Mailing address line 2.                                                  |
| `city`              | TEXT          |          | City or municipality.                                                    |
| `province`          | VARCHAR(2)    |          | Province or state code. FK to `cra_province_state_lookup.code`.          |
| `postal_code`       | VARCHAR(10)   |          | Postal code or ZIP code.                                                 |
| `country`           | CHAR(2)       |          | Country code. FK to `cra_country_lookup.code`.                           |
| `registration_date` | DATE          |          | *Reserved column. Not populated by the CRA Open Data T3010 feed (absent from §3.1 of the CRA Open Data Dictionary v2.0). Always NULL. Kept for a future integration with the separate CRA Charity Registry export that does include this field.* |
| `language`          | VARCHAR(2)    |          | *Reserved column. Not populated. See `registration_date` note.*          |
| `contact_phone`     | TEXT          |          | *Reserved column. Not populated. See `registration_date` note.*          |
| `contact_email`     | TEXT          |          | *Reserved column. Not populated. See `registration_date` note.*          |

**Primary Key**: (`bn`, `fiscal_year`)
**Source CSV/API**: Identification resource from CRA Open Data
**T3010 Form Reference**: Page 1 -- Identification

---

### 3.2 `cra_directors`

Board directors, officers, and trustees listed on the T3010. Each row represents one individual associated with a filing.

| Column            | Data Type     | Nullable | Description                                                           |
|-------------------|---------------|----------|-----------------------------------------------------------------------|
| `bn`              | VARCHAR(15)   | NOT NULL | Business Number.                                                      |
| `fpe`             | DATE          | NOT NULL | Fiscal Period End date.                                               |
| `form_id`         | INTEGER       |          | T3010 form version ID (internal CRA versioning, e.g. 23--27).        |
| `sequence_number` | INTEGER       | NOT NULL | Row sequence number within the filing (1-based).                      |
| `last_name`       | TEXT          |          | Director's last/family name.                                          |
| `first_name`      | TEXT          |          | Director's first/given name.                                          |
| `initials`        | TEXT          |          | Director's middle initial(s).                                         |
| `position`        | TEXT          |          | Role held (e.g. `PRESIDENT`, `TREASURER`, `DIRECTOR`, `SECRETARY`).   |
| `at_arms_length`  | BOOLEAN       |          | Whether the director is at arm's length from the charity (T/F).       |
| `start_date`      | DATE          |          | Date the person started in this position.                             |
| `end_date`        | DATE          |          | Date the person ended in this position (NULL if still active).        |

**Primary Key**: (`bn`, `fpe`, `sequence_number`)
**Source CSV/API**: Directors resource from CRA Open Data
**T3010 Form Reference**: Section B -- Directors/Trustees and Like Officials (via Form T1235 worksheet)

---

### 3.3 `cra_financial_details`

Detailed financial data from Section D (Financial Information) and Schedule 6 (Detailed Financial Information) of the T3010. This is the largest and most complex table, containing line-by-line financial figures.

> **Section D vs. Schedule 6**: The T3010 has two financial sections. **Section D** is a simplified form for small charities (revenue < $100K) with fewer line items. **Schedule 6** is the detailed form for larger charities (revenue > $100K) with a full balance sheet and granular expenditure breakdown. The line numbers that appear in both sections share the same meanings (e.g., 4540 = federal government revenue in both). Schedule 6 simply has additional lines that Section D omits (e.g., the full balance sheet lines 4100-4200, detailed expenditure lines 4800-4880). The `section_used` column indicates which section was completed: `D` or `6`.

#### Statement of Financial Position (Balance Sheet)

| Column                | Data Type      | Nullable | Description                                                          |
|-----------------------|----------------|----------|----------------------------------------------------------------------|
| `bn`                  | VARCHAR(15)    | NOT NULL | Business Number.                                                     |
| `fpe`                 | DATE           | NOT NULL | Fiscal Period End date.                                              |
| `form_id`             | INTEGER        |          | T3010 form version ID.                                               |
| `section_used`        | CHAR(1)        |          | Which section the charity completed: `D` (Section D -- short form) or `6` (Schedule 6 -- detailed). |
| `field_4020`          | CHAR(1)        |          | Type of accounting used: `A` = accrual, `C` = cash basis. *(Both Section D and Schedule 6.)* |
| `field_4050`          | BOOLEAN        |          | Did the charity own land or buildings during the fiscal period? *(Section D only.)* |
| `field_4100`          | DECIMAL(15,2)  |          | **Cash, bank accounts, and short-term investments.** *(Schedule 6 -- balance sheet asset. Section D does not use this line.)* |
| `field_4101`          | DECIMAL(15,2)  |          | Cash and bank accounts (subset of 4100). **2024+ new field.** *(Schedule 6 only.)* |
| `field_4102`          | DECIMAL(15,2)  |          | Short-term investments (subset of 4100). **2024+ new field.** *(Schedule 6 only.)* |
| `field_4110`          | DECIMAL(15,2)  |          | **Amounts receivable from non-arm's length persons.** *(Schedule 6 -- balance sheet asset.)* |
| `field_4120`          | DECIMAL(15,2)  |          | **Amounts receivable from all others.** *(Schedule 6 -- balance sheet asset.)* Section D does not use this line number. |
| `field_4130`          | DECIMAL(15,2)  |          | **Investments in non-arm's length persons.** *(Schedule 6 -- balance sheet asset.)* |
| `field_4140`          | DECIMAL(15,2)  |          | **Long-term investments.** *(Schedule 6 -- balance sheet asset.)* |
| `field_4150`          | DECIMAL(15,2)  |          | **Inventories.** *(Schedule 6 -- balance sheet asset.)* |
| `field_4155`          | DECIMAL(15,2)  |          | **Land and buildings in Canada.** *(Schedule 6 -- balance sheet asset.)* |
| `field_4157`          | DECIMAL(15,2)  |          | Land and buildings in Canada used for charitable programs or administration (subset of 4155). **2024+ new field.** *(Schedule 6 only.)* |
| `field_4158`          | DECIMAL(15,2)  |          | Land and buildings in Canada used for other purposes (subset of 4155). **2024+ new field.** *(Schedule 6 only.)* |
| `field_4160`          | DECIMAL(15,2)  |          | **Other capital assets in Canada.** *(Schedule 6 -- balance sheet asset.)* |
| `field_4165`          | DECIMAL(15,2)  |          | **Capital assets outside Canada.** *(Schedule 6 -- balance sheet asset.)* |
| `field_4166`          | DECIMAL(15,2)  |          | **Accumulated amortization of capital assets** (negative value). *(Schedule 6 -- balance sheet contra-asset.)* |
| `field_4170`          | DECIMAL(15,2)  |          | **Other assets.** *(Schedule 6 -- balance sheet asset.)* Section D does not use this line number. |
| `field_4180`          | DECIMAL(15,2)  |          | 10-year gift balance field. **Removed in v24 (Form ID 27).** *(Pre-2024 only.)* |
| `field_4190`          | DECIMAL(15,2)  |          | **Impact investments.** **2024+ new field.** *(Schedule 6 -- balance sheet asset.)* |
| `field_4200`          | DECIMAL(15,2)  |          | **Total assets** (sum of balance sheet asset lines). *(Both Section D and Schedule 6.)* |
| `field_4250`          | DECIMAL(15,2)  |          | **Property not used in charitable activities** (amount included in lines 4150-4170 not used in charitable activities). *(Schedule 6 only.)* |
| `field_4300`          | DECIMAL(15,2)  |          | **Accounts payable and accrued liabilities.** *(Schedule 6 -- balance sheet liability.)* |
| `field_4310`          | DECIMAL(15,2)  |          | **Deferred revenue.** *(Schedule 6 -- balance sheet liability.)* |
| `field_4320`          | DECIMAL(15,2)  |          | **Amounts owing to non-arm's length persons.** *(Schedule 6 -- balance sheet liability.)* |
| `field_4330`          | DECIMAL(15,2)  |          | **Other liabilities.** *(Schedule 6 -- balance sheet liability.)* |
| `field_4350`          | DECIMAL(15,2)  |          | **Total liabilities** (add lines 4300 to 4330). *(Both Section D and Schedule 6.)* |

#### Revenue (Schedule 6 / Section D)

| Column                | Data Type      | Nullable | Description                                                          |
|-----------------------|----------------|----------|----------------------------------------------------------------------|
| `field_4400`          | BOOLEAN        |          | Did the charity borrow from, loan to, or invest assets with non-arm's length persons? *(Section D only -- Y/N flag.)* |
| `field_4490`          | BOOLEAN        |          | Did the charity issue tax receipts for gifts? *(Section D only -- Y/N flag.)* |
| `field_4500`          | DECIMAL(15,2)  |          | **Total eligible amount of all gifts for which the charity has issued or will issue tax receipts.** *(Both Section D and Schedule 6.)* |
| `field_4505`          | DECIMAL(15,2)  |          | 10-year gift field. **Removed in v24.** *(Pre-2024 only.)* |
| `field_4510`          | DECIMAL(15,2)  |          | **Total amount received from other registered charities.** *(Both Section D and Schedule 6 -- revenue.)* |
| `field_4530`          | DECIMAL(15,2)  |          | **Total other gifts received for which a tax receipt was NOT issued** (excluding amounts at lines 4575 and 4630). *(Both Section D and Schedule 6 -- revenue.)* |
| `field_4540`          | DECIMAL(15,2)  |          | **Total revenue received from federal government.** *(Schedule 6 only -- revenue. Section D does not break out government revenue by level.)* |
| `field_4550`          | DECIMAL(15,2)  |          | **Total revenue received from provincial/territorial governments.** *(Schedule 6 only -- revenue. Section D does not break out government revenue by level.)* |
| `field_4560`          | DECIMAL(15,2)  |          | **Total revenue received from municipal/regional governments.** *(Schedule 6 only -- revenue. Section D does not break out government revenue by level.)* |
| `field_4565`          | BOOLEAN        |          | Did the charity receive any revenue from any level of government in Canada? *(Section D only -- Y/N flag.)* |
| `field_4570`          | DECIMAL(15,2)  |          | **Total government revenue (all levels combined).** *(Section D only. Schedule 6 breaks this into 4540 + 4550 + 4560 instead.)* |
| `field_4571`          | DECIMAL(15,2)  |          | **Total tax-receipted revenue from all sources outside of Canada** (government and non-government). *(Both Section D and Schedule 6 -- revenue.)* |
| `field_4575`          | DECIMAL(15,2)  |          | **Total non-tax-receipted revenue from all sources outside of Canada** (government and non-government). *(Both Section D and Schedule 6 -- revenue.)* |
| `field_4576`          | DECIMAL(15,2)  |          | **Total interest and investment income from impact investments.** **2024+ new field.** *(Schedule 6 only -- revenue subset of 4580.)* |
| `field_4577`          | DECIMAL(15,2)  |          | **Total interest and investment income from persons not at arm's length.** **2024+ new field.** *(Schedule 6 only -- revenue subset of 4580.)* |
| `field_4580`          | DECIMAL(15,2)  |          | **Total interest and investment income received or earned.** *(Schedule 6 only -- revenue.)* |
| `field_4590`          | DECIMAL(15,2)  |          | **Gross proceeds from disposition of assets.** *(Schedule 6 only -- revenue.)* |
| `field_4600`          | DECIMAL(15,2)  |          | **Net proceeds from disposition of assets** (may be negative). *(Schedule 6 only -- revenue.)* |
| `field_4610`          | DECIMAL(15,2)  |          | **Gross income received from rental of land and/or buildings.** *(Schedule 6 only -- revenue.)* |
| `field_4620`          | DECIMAL(15,2)  |          | **Total non-tax-receipted revenues received for memberships, dues, and association fees.** *(Schedule 6 only -- revenue.)* |
| `field_4630`          | DECIMAL(15,2)  |          | **Total non-tax-receipted revenue from fundraising.** *(Both Section D and Schedule 6 -- revenue.)* |
| `field_4640`          | DECIMAL(15,2)  |          | **Total revenue from sale of goods and services** (except to any level of government in Canada). *(Both Section D and Schedule 6 -- revenue.)* |
| `field_4650`          | DECIMAL(15,2)  |          | **Other revenue** not already included in the amounts above. *(Both Section D and Schedule 6 -- revenue.)* |
| `field_4655`          | TEXT           |          | **Specify type(s) of revenue** included in the amount reported at line 4650. *(Schedule 6 only -- free-text description per CRA Open Data Dictionary §3.7.)* |
| `field_4700`          | DECIMAL(15,2)  |          | **Total revenue** (sum of all revenue lines). *(Both Section D and Schedule 6.)* |

#### Expenditures (Schedule 6 / Section D)

| Column                | Data Type      | Nullable | Description                                                          |
|-----------------------|----------------|----------|----------------------------------------------------------------------|
| `field_4800`          | DECIMAL(15,2)  |          | **Advertising and promotion.** *(Schedule 6 only -- expenditure.)* |
| `field_4810`          | DECIMAL(15,2)  |          | **Travel and vehicle expenses.** *(Both Section D and Schedule 6 -- expenditure.)* |
| `field_4820`          | DECIMAL(15,2)  |          | **Interest and bank charges.** *(Schedule 6 only -- expenditure.)* |
| `field_4830`          | DECIMAL(15,2)  |          | **Licences, memberships, and dues.** *(Schedule 6 only -- expenditure.)* |
| `field_4840`          | DECIMAL(15,2)  |          | **Office supplies and expenses.** *(Schedule 6 only -- expenditure.)* |
| `field_4850`          | DECIMAL(15,2)  |          | **Occupancy costs.** *(Schedule 6 only -- expenditure.)* |
| `field_4860`          | DECIMAL(15,2)  |          | **Professional and consulting fees.** *(Both Section D and Schedule 6 -- expenditure.)* |
| `field_4870`          | DECIMAL(15,2)  |          | **Education and training for staff and volunteers.** *(Schedule 6 only -- expenditure.)* |
| `field_4880`          | DECIMAL(15,2)  |          | **Total expenditure on all compensation** (enter the amount reported at line 390 in Schedule 3, if applicable). *(Schedule 6 only -- expenditure.)* |
| `field_4890`          | DECIMAL(15,2)  |          | **Fair market value of all donated goods used in the charity's own activities.** *(Schedule 6 only -- expenditure.)* |
| `field_4891`          | DECIMAL(15,2)  |          | **Purchased supplies and assets.** *(Schedule 6 only -- expenditure.)* |
| `field_4900`          | DECIMAL(15,2)  |          | **Amortization of capitalized assets.** *(Schedule 6 only -- expenditure.)* |
| `field_4910`          | DECIMAL(15,2)  |          | **Research grants and scholarships as part of the charity's own activities.** *(Schedule 6 only -- expenditure.)* |
| `field_4920`          | DECIMAL(15,2)  |          | **All other expenditures** not included in the amounts above (excluding qualifying disbursements). *(Both Section D and Schedule 6 -- expenditure.)* |
| `field_4930`          | TEXT           |          | **Specify type(s) of expenditures** included in the amount reported at line 4920. *(Schedule 6 only -- free-text description per CRA Open Data Dictionary §3.7.)* |
| `field_4950`          | DECIMAL(15,2)  |          | **Total expenditures before qualifying disbursements** (sum of lines 4800 to 4920 for Schedule 6; sum of 4860 + 4810 + 4920 for Section D). *(Both Section D and Schedule 6.)* |

#### Expenditure Allocation (Schedule 6 / Section D)

| Column                | Data Type      | Nullable | Description                                                          |
|-----------------------|----------------|----------|----------------------------------------------------------------------|
| `field_5000`          | DECIMAL(15,2)  |          | **Total expenditures on charitable activities** (subset of line 4950). *(Both Section D and Schedule 6.)* |
| `field_5010`          | DECIMAL(15,2)  |          | **Total expenditures on management and administration** (subset of line 4950). *(Both Section D and Schedule 6.)* |
| `field_5020`          | DECIMAL(15,2)  |          | **Total expenditures on fundraising** (subset of line 4950). *(Schedule 6 only.)* |
| `field_5030`          | DECIMAL(15,2)  |          | Schedule 6 expenditure breakdown field. *(Schedule 6 only.)* |
| `field_5040`          | DECIMAL(15,2)  |          | **Total other expenditures included in line 4950** (subset of line 4950). *(Schedule 6 only.)* |
| `field_5045`          | DECIMAL(15,2)  |          | **Total amount of grants made to all non-qualified donees (grantees).** *(Both Section D and Schedule 6.)* |
| `field_5050`          | DECIMAL(15,2)  |          | **Total amount of gifts made to all qualified donees (excluding enduring property and specified gifts).** *(Both Section D and Schedule 6.)* |
| `field_5100`          | DECIMAL(15,2)  |          | **Total expenditures** (add lines 4950 + 5045 + 5050). *(Both Section D and Schedule 6.)* |

#### Other Financial Information

| Column                | Data Type      | Nullable | Description                                                          |
|-----------------------|----------------|----------|----------------------------------------------------------------------|
| `field_5500`          | DECIMAL(15,2)  |          | **Permission to accumulate property**: amount accumulated for the fiscal period, including income earned on accumulated funds. |
| `field_5510`          | DECIMAL(15,2)  |          | **Permission to accumulate property**: amount disbursed for the fiscal period for the specified purpose. |
| `field_5610`          | DECIMAL(15,2)  |          | **Total eligible amount of tax-receipted tuition fees.** *(Schedule 6 only.)* |
| `field_5750`          | DECIMAL(15,2)  |          | **Disbursement quota reduction**: if the charity has received approval to make a reduction to its disbursement quota, the amount for the fiscal period. |
| `field_5900`          | DECIMAL(15,2)  |          | **Property not used in charitable activities**: average value during the 24 months before the **beginning** of the fiscal period. |
| `field_5910`          | DECIMAL(15,2)  |          | **Property not used in charitable activities**: average value during the 24 months before the **end** of the fiscal period. |

**Primary Key**: (`bn`, `fpe`)
**Source CSV/API**: Financial resource from CRA Open Data
**T3010 Form Reference**: Section D -- Financial Information; Schedule 6 -- Detailed Financial Information

> **Note on field naming**: All `field_XXXX` columns map directly to T3010 line numbers. Consult the **CRA T4033 Guide** for authoritative line-by-line descriptions.

> **Note on version changes**: Fields marked "2024+" were introduced with Form ID 27 (the 2024 T3010 revision). Fields marked "Removed in v24" are present in earlier data but absent from 2024+ filings. See the CanadianCharityLaw.ca reference for a detailed change log.

---

### 3.4 `cra_financial_general`

Boolean flags and program area allocations from Sections A, B, and C of the T3010. These capture yes/no responses to regulatory questions.

| Column                       | Data Type     | Nullable | Description                                                            |
|------------------------------|---------------|----------|------------------------------------------------------------------------|
| `bn`                         | VARCHAR(15)   | NOT NULL | Business Number.                                                       |
| `fpe`                        | DATE          | NOT NULL | Fiscal Period End date.                                                |
| `form_id`                    | INTEGER       |          | T3010 form version ID.                                                 |
| `program_area_1`             | VARCHAR(10)   |          | Primary program area code. FK to `cra_category_lookup`.                |
| `program_area_2`             | VARCHAR(10)   |          | Secondary program area code.                                           |
| `program_area_3`             | VARCHAR(10)   |          | Tertiary program area code.                                            |
| `program_percentage_1`       | INTEGER       |          | Percentage of resources allocated to program area 1 (0--100).          |
| `program_percentage_2`       | INTEGER       |          | Percentage of resources allocated to program area 2 (0--100).          |
| `program_percentage_3`       | INTEGER       |          | Percentage of resources allocated to program area 3 (0--100).          |
| `internal_division_1510_01`  | INTEGER       |          | Internal division field 1. **Pre-2024 only.**                          |
| `internal_division_1510_02`  | INTEGER       |          | Internal division field 2. **Pre-2024 only.**                          |
| `internal_division_1510_03`  | INTEGER       |          | Internal division field 3. **Pre-2024 only.**                          |
| `internal_division_1510_04`  | INTEGER       |          | Internal division field 4. **Pre-2024 only.**                          |
| `internal_division_1510_05`  | INTEGER       |          | Internal division field 5. **Pre-2024 only.**                          |
| `field_1510_subordinate`     | BOOLEAN       |          | Is the charity subordinate to a parent organization? **2024+ only.**   |
| `field_1510_parent_bn`       | VARCHAR(15)   |          | Business Number of the parent organization. **2024+ only.**            |
| `field_1510_parent_name`     | TEXT          |          | Name of the parent organization. **2024+ only.**                       |
| `field_1570`                 | BOOLEAN       |          | Has the charity wound-up, dissolved, or terminated operations? *(Section A, line A2.)* |
| `field_1600`                 | BOOLEAN       |          | Is the charity designated as a public foundation or private foundation? *(Section A, line A3.)* |
| `field_1800`                 | BOOLEAN       |          | Did the charity carry on activities outside Canada?                    |
| `field_2000`                 | BOOLEAN       |          | Did the charity make gifts or transfer funds to qualified donees or other organizations? *(Section C, line C3.)* |
| `field_2100`                 | BOOLEAN       |          | Did the charity carry on, fund, or provide resources for any activity/program/project outside Canada (excluding qualifying disbursements)? *(Section C, line C4.)* |
| `field_2500`                 | BOOLEAN       |          | Fundraising method used: Advertisements/print/radio/TV commercials. *(Section C, line C6.)* |
| `field_2510`                 | BOOLEAN       |          | Fundraising method used: Auctions. *(Section C, line C6.)* |
| `field_2520`                 | BOOLEAN       |          | Fundraising method used: Collection plate/boxes. *(Section C, line C6.)* -- *Note: line 2520 not on v24 printed form; may be pre-2024 or a sub-field. Verify against source data.* |
| `field_2530`                 | BOOLEAN       |          | Fundraising method used: Collection plate/boxes. *(Section C, line C6.)* |
| `field_2540`                 | BOOLEAN       |          | Fundraising method used: Door-to-door solicitation. *(Section C, line C6.)* |
| `field_2550`                 | BOOLEAN       |          | Fundraising method used: Draws/lotteries. *(Section C, line C6.)* |
| `field_2560`                 | BOOLEAN       |          | Fundraising method used: Fundraising dinners/galas/concerts. *(Section C, line C6.)* |
| `field_2600`                 | BOOLEAN       |          | Fundraising method used: Targeted corporate donations/sponsorships. *(Section C, line C6.)* |
| `field_2610`                 | BOOLEAN       |          | Fundraising method used: Targeted contacts. *(Section C, line C6.)* |
| `field_2620`                 | BOOLEAN       |          | Fundraising method used: Telephone/TV solicitations. *(Section C, line C6.)* |
| `field_2630`                 | BOOLEAN       |          | Fundraising method used: Tournament/sporting events. *(Section C, line C6.)* |
| `field_2640`                 | BOOLEAN       |          | Fundraising method used: Cause-related marketing. *(Section C, line C6.)* |
| `field_2650`                 | BOOLEAN       |          | Fundraising method used: Other. *(Section C, line C6.)* |
| `field_2660`                 | TEXT          |          | Fundraising method: Specify (free-text description for "Other"). *(Section C, line C6 — Text 175 per CRA Open Data Dictionary §3.6.)* |
| `field_2700`                 | BOOLEAN       |          | Did the charity pay external fundraisers? *(Section C, line C7.)* |
| `field_2730`                 | BOOLEAN       |          | External fundraisers: Commissions. *(Section C, line C7.)* |
| `field_2740`                 | BOOLEAN       |          | External fundraisers: Bonuses. *(Section C, line C7.)* |
| `field_2750`                 | BOOLEAN       |          | External fundraisers: Finder's fees. *(Section C, line C7.)* |
| `field_2760`                 | BOOLEAN       |          | External fundraisers: Set fee for services. *(Section C, line C7.)* |
| `field_2770`                 | BOOLEAN       |          | External fundraisers: Honoraria. *(Section C, line C7.)* |
| `field_2780`                 | BOOLEAN       |          | External fundraisers: Other. *(Section C, line C7.)* |
| `field_2790`                 | TEXT          |          | External fundraisers: Specify (free-text). *(Section C, line C7 — Text 175 per §3.6.)* |
| `field_2800`                 | BOOLEAN       |          | Did the fundraiser issue tax receipts on behalf of the charity? *(Section C, line C7.)* |
| `field_5030`                 | DECIMAL(15,2) |          | Total amount spent by the charity on political activities. *(v23 only — Amount 14 per §3.6. Removed in v24+.)* |
| `field_5031`                 | DECIMAL(15,2) |          | Of amount at 5030, total gifts made to qualified donees for political activities. *(v23 only.)* |
| `field_5032`                 | DECIMAL(15,2) |          | Total received from outside Canada directed to political activities. *(v23 only.)* |
| `field_5450`                 | DECIMAL(15,2) |          | Gross revenue collected by external fundraisers on behalf of the charity. *(Section C, line C7 — Amount 14 per §3.6.)* |
| `field_5460`                 | DECIMAL(15,2) |          | Amounts paid to and/or retained by external fundraisers. *(Section C, line C7 — Amount 14 per §3.6.)* |
| `field_3200`                 | BOOLEAN       |          | Did the charity compensate any directors/trustees or like officials, or persons not at arm's length, for services provided (other than expense reimbursement)? *(Section C, line C8.)* |
| `field_3400`                 | BOOLEAN       |          | Did the charity incur any expenses for compensation of employees during the fiscal period? If yes, must complete Schedule 3. *(Section C, line C9.)* |
| `field_5800`                 | BOOLEAN       |          | Did the charity acquire a non-qualifying security? *(Section C, line C12.)* |
| `field_5810`                 | BOOLEAN       |          | Did the charity allow any of its donors to use any of its property (except for permissible uses)? *(Section C, line C13.)* |
| `field_5820`                 | BOOLEAN       |          | Did the charity issue any of its tax receipts for donations on behalf of another organization? *(Section C, line C14.)* |
| `field_5830`                 | BOOLEAN       |          | Did the charity have direct partnership holdings at any time during the fiscal period? *(Section C, line C15.)* |
| `field_5840`                 | BOOLEAN       |          | Did the charity make qualifying disbursements by way of grants to non-qualified donees (grantees)? *(Section C, line C16. v26+.)* |
| `field_5841`                 | BOOLEAN       |          | Did the charity make grants to any grantees totalling more than $5,000 in the fiscal period? *(v26+.)* |
| `field_5842`                 | INTEGER       |          | Number of grantees that received grants totalling $5,000 or less in the fiscal period. *(v26+, Number 10 per §3.6.)* |
| `field_5843`                 | DECIMAL(15,2) |          | Total amount paid to grantees that received grants totalling $5,000 or less in the fiscal period. *(v26+, Amount 17 per §3.6.)* |
| `field_5850`                 | BOOLEAN       |          | In the 24 months before the beginning of the fiscal period, did the average value of the charity's property not used in charitable activities exceed the threshold ($100K for charitable orgs, $25K for foundations)? *(Section C, line C17. v27+.)* |
| `field_5860`                 | BOOLEAN       |          | Did the charity hold any donor advised funds (DAFs) during the fiscal period? *(Section C, line C18. v27+.)* |
| `field_5861`                 | INTEGER       |          | Total number of DAF accounts held at the end of the fiscal period. *(v27+, Number 10 per §3.6.)* |
| `field_5862`                 | DECIMAL(15,2) |          | Total value of all DAF accounts held at the end of the fiscal period. *(v27+, Amount 17 per §3.6.)* |
| `field_5863`                 | DECIMAL(15,2) |          | Total value of donations to DAF accounts received during the fiscal period. *(v27+, Amount 17.)* |
| `field_5864`                 | DECIMAL(15,2) |          | Total value of qualifying disbursements from DAFs during the fiscal period. *(v27+, Amount 17 per §3.6.)* |
| `program_description_1`      | TEXT          |          | Program Area #1 description (free text, up to 60 chars per CRA Open Data Dictionary §3.6). |
| `program_description_2`      | TEXT          |          | Program Area #2 description (free text, up to 60 chars). |
| `program_description_3`      | TEXT          |          | Program Area #3 description (free text, up to 60 chars). |

**Primary Key**: (`bn`, `fpe`)
**Source CSV/API**: General financial resource from CRA Open Data
**T3010 Form Reference**: Sections A, B, C -- General Information; various form questions

---

### 3.5 `cra_qualified_donees`

Gifts made by the charity to other qualified donees (other registered charities, RCAAAs, municipalities, etc.). Each row represents one recipient.

| Column                    | Data Type      | Nullable | Description                                                      |
|---------------------------|----------------|----------|------------------------------------------------------------------|
| `bn`                      | VARCHAR(15)    | NOT NULL | Business Number of the filing charity.                           |
| `fpe`                     | DATE           | NOT NULL | Fiscal Period End date.                                          |
| `form_id`                 | INTEGER        |          | T3010 form version ID.                                           |
| `sequence_number`         | INTEGER        | NOT NULL | Row sequence number within the filing.                           |
| `donee_bn`                | VARCHAR(15)    |          | Business Number of the recipient charity/donee.                  |
| `donee_name`              | TEXT           |          | Name of the recipient charity/donee.                             |
| `associated`              | BOOLEAN        |          | Is the donee associated with the filing charity?                 |
| `city`                    | TEXT           |          | City of the donee.                                               |
| `province`                | VARCHAR(2)     |          | Province/state of the donee.                                     |
| `total_gifts`             | DECIMAL(15,2)  |          | Total value of gifts made to this donee.                         |
| `gifts_in_kind`           | DECIMAL(15,2)  |          | Value of non-cash (in-kind) gifts made to this donee.            |
| `number_of_donees`        | INTEGER        |          | *Reserved column. Not populated by the CRA Open Data qualified_donees feed (absent from §3.4 of the CRA Open Data Dictionary v2.0). Always NULL. Use `COUNT(*)` grouped by `(bn, fpe)` to compute the donee count if needed.* |
| `political_activity_gift` | BOOLEAN        |          | Was the gift related to political activities?                    |
| `political_activity_amount`| DECIMAL(15,2) |          | Amount of gift related to political activities.                  |

**Primary Key**: (`bn`, `fpe`, `sequence_number`)
**Source CSV/API**: Qualified donees resource from CRA Open Data
**T3010 Form Reference**: Section C, Question C3 (line 2000) -- Gifts to Qualified Donees (via Form T1236 worksheet)

---

### 3.6 `cra_charitable_programs`

Descriptions of the charity's charitable programs. Each row represents one program categorized by its operational status.

| Column         | Data Type    | Nullable | Description                                              |
|----------------|--------------|----------|----------------------------------------------------------|
| `bn`           | VARCHAR(15)  | NOT NULL | Business Number.                                         |
| `fpe`          | DATE         | NOT NULL | Fiscal Period End date.                                  |
| `form_id`      | INTEGER      |          | T3010 form version ID.                                   |
| `program_type` | VARCHAR(2)   | NOT NULL | Program status code: `OP`, `NP`, or `NA`. FK to `cra_program_type_lookup.code`. |
| `description`  | TEXT         |          | Free-text narrative description of the program.          |

**Primary Key**: (`bn`, `fpe`, `program_type`)
**Source CSV/API**: Programs resource from CRA Open Data
**T3010 Form Reference**: Section C -- Programs and General Information

---

### 3.7 `cra_non_qualified_donees`

Gifts to non-qualified donees (organizations that are not registered charities or other qualified donees under the Income Tax Act).

| Column            | Data Type      | Nullable | Description                                                 |
|-------------------|----------------|----------|-------------------------------------------------------------|
| `bn`              | VARCHAR(15)    | NOT NULL | Business Number.                                            |
| `fpe`             | DATE           | NOT NULL | Fiscal Period End date.                                     |
| `form_id`         | INTEGER        |          | T3010 form version ID.                                      |
| `sequence_number` | INTEGER        | NOT NULL | Row sequence number within the filing.                      |
| `recipient_name`  | TEXT           |          | Name of the recipient organization or individual.           |
| `purpose`         | TEXT           |          | Purpose or reason for the gift.                             |
| `cash_amount`     | DECIMAL(15,2)  |          | Cash amount given.                                          |
| `non_cash_amount` | DECIMAL(15,2)  |          | Value of non-cash gifts.                                    |
| `country`         | TEXT           |          | Grant country/countries — free-text list (Text 125 per CRA Open Data Dictionary §3.18). May contain a single 2-char code, a full country name, or a space-separated list for multi-country grants. **Not** a 2-letter code and **not** a FK to `cra_country_lookup`. |

**Primary Key**: (`bn`, `fpe`, `sequence_number`)
**Source CSV/API**: Non-qualified donees resource from CRA Open Data (v26+)
**T3010 Form Reference**: T1441 — Qualifying disbursements: Grants to non-qualified donees (grantees)

---

### 3.8 `cra_foundation_info`

Financial information specific to foundations (designation `A` or `B`). Corresponds to Schedule 1 of the T3010.

| Column      | Data Type      | Nullable | Description                                     |
|-------------|----------------|----------|-------------------------------------------------|
| `bn`        | VARCHAR(15)    | NOT NULL | Business Number.                                |
| `fpe`       | DATE           | NOT NULL | Fiscal Period End date.                         |
| `form_id`   | INTEGER        |          | T3010 form version ID.                          |
| `field_100` | BOOLEAN        |          | Did the foundation acquire control of a corporation? *(Schedule 1 Y/N per CRA Open Data Dictionary §3.8.)* |
| `field_110` | BOOLEAN        |          | Did the foundation incur any debts during the fiscal period other than current operating expenses / investments / administering charitable programs? *(Schedule 1 Y/N.)* |
| `field_111` | DECIMAL(15,2)  |          | Total value of all restricted funds held at the end of the fiscal period. *(v27+, Amount 17 per §3.8.)* |
| `field_112` | DECIMAL(15,2)  |          | Of that amount, portion the foundation was not permitted to spend due to a funder's written trust or direction. *(v27+.)* |
| `field_120` | BOOLEAN        |          | During the fiscal period, did the foundation hold shares, rights to acquire such shares, or debt owing to it that are non-qualifying investments? *(Schedule 1 Y/N.)* |
| `field_130` | BOOLEAN        |          | Did the foundation own more than 2% of any class of shares of a corporation at any time during the fiscal period? *(Schedule 1 Y/N.)* |

**Primary Key**: (`bn`, `fpe`)
**Source CSV/API**: Foundation information resource from CRA Open Data
**T3010 Form Reference**: Schedule 1 -- Foundations

---

### 3.9 `cra_activities_outside_details`

Summary-level information about activities conducted outside Canada. Corresponds to Schedule 2 header fields.

| Column      | Data Type      | Nullable | Description                                                       |
|-------------|----------------|----------|-------------------------------------------------------------------|
| `bn`        | VARCHAR(15)    | NOT NULL | Business Number.                                                  |
| `fpe`       | DATE           | NOT NULL | Fiscal Period End date.                                           |
| `form_id`   | INTEGER        |          | T3010 form version ID.                                            |
| `field_200` | DECIMAL(15,2)  |          | Total expenditures on activities outside Canada (excluding qualifying disbursements). |
| `field_210` | BOOLEAN        |          | Resources provided for programs outside Canada to any other individual or entity (excluding qualifying disbursements)? |
| `field_220` | BOOLEAN        |          | Projects undertaken outside Canada funded by Global Affairs?       |
| `field_230` | TEXT           |          | Total amount of funds expended for Global-Affairs-funded programs. *(Per CRA Open Data Dictionary §3.9 this is an Amount 14 value; stored as TEXT because source emits it that way. Cast to numeric in queries if needed.)* |
| `field_240` | BOOLEAN        |          | Schedule 2 Y/N flag.                                              |
| `field_250` | BOOLEAN        |          | Schedule 2 Y/N flag.                                              |
| `field_260` | BOOLEAN        |          | Schedule 2 Y/N flag.                                              |

**Primary Key**: (`bn`, `fpe`)
**Source CSV/API**: Activities outside Canada resource from CRA Open Data
**T3010 Form Reference**: Schedule 2 -- Activities Outside Canada

---

### 3.10 `cra_activities_outside_countries`

Countries where the charity conducted activities outside Canada. One row per country per filing.

| Column            | Data Type    | Nullable | Description                                                    |
|-------------------|--------------|----------|----------------------------------------------------------------|
| `bn`              | VARCHAR(15)  | NOT NULL | Business Number.                                               |
| `fpe`             | DATE         | NOT NULL | Fiscal Period End date.                                        |
| `form_id`         | INTEGER      |          | T3010 form version ID.                                         |
| `sequence_number` | INTEGER      | NOT NULL | Row sequence number within the filing.                         |
| `country`         | CHAR(2)      |          | Country code where activities were conducted. FK to `cra_country_lookup.code`. |

**Primary Key**: (`bn`, `fpe`, `sequence_number`)
**Source CSV/API**: Activities outside countries resource from CRA Open Data
**T3010 Form Reference**: Schedule 2 -- Activities Outside Canada (country list)

---

### 3.11 `cra_exported_goods`

Goods exported by the charity outside Canada. One row per exported item per filing.

| Column            | Data Type      | Nullable | Description                                                 |
|-------------------|----------------|----------|-------------------------------------------------------------|
| `bn`              | VARCHAR(15)    | NOT NULL | Business Number.                                            |
| `fpe`             | DATE           | NOT NULL | Fiscal Period End date.                                     |
| `form_id`         | INTEGER        |          | T3010 form version ID.                                      |
| `sequence_number` | INTEGER        | NOT NULL | Row sequence number within the filing.                      |
| `item_name`       | TEXT           |          | Description of the exported item.                           |
| `item_value`      | DECIMAL(15,2)  |          | Value of the exported item.                                 |
| `destination`     | TEXT           |          | Destination description.                                    |
| `country`         | CHAR(2)        |          | Destination country code. FK to `cra_country_lookup.code`.  |

**Primary Key**: (`bn`, `fpe`, `sequence_number`)
**Source CSV/API**: Exported goods resource from CRA Open Data
**T3010 Form Reference**: Schedule 2 -- Activities Outside Canada (exported goods)

---

### 3.12 `cra_resources_sent_outside`

Resources (financial or otherwise) transferred to individuals or organizations outside Canada.

| Column              | Data Type      | Nullable | Description                                                |
|---------------------|----------------|----------|------------------------------------------------------------|
| `bn`                | VARCHAR(15)    | NOT NULL | Business Number.                                           |
| `fpe`               | DATE           | NOT NULL | Fiscal Period End date.                                    |
| `form_id`           | INTEGER        |          | T3010 form version ID.                                     |
| `sequence_number`   | INTEGER        | NOT NULL | Row sequence number within the filing.                     |
| `individual_org_name`| TEXT          |          | Name of the individual or organization receiving resources.|
| `amount`            | DECIMAL(15,2)  |          | Dollar amount of resources transferred.                    |
| `country`           | CHAR(2)        |          | Country of the recipient. FK to `cra_country_lookup.code`. |

**Primary Key**: (`bn`, `fpe`, `sequence_number`)
**Source CSV/API**: Resources sent outside resource from CRA Open Data
**T3010 Form Reference**: Schedule 2 -- Activities Outside Canada (resources transferred)

---

### 3.13 `cra_compensation`

Employee compensation information from Schedule 3. Reports the number of employees in various compensation brackets and total compensation paid.

| Column      | Data Type      | Nullable | Description                                                     |
|-------------|----------------|----------|-----------------------------------------------------------------|
| `bn`        | VARCHAR(15)    | NOT NULL | Business Number.                                                |
| `fpe`       | DATE           | NOT NULL | Fiscal Period End date.                                         |
| `form_id`   | INTEGER        |          | T3010 form version ID.                                          |
| `field_300` | INTEGER        |          | **Number of permanent, full-time, compensated positions** in the fiscal period. *(This is the total count, NOT a compensation bracket.)* |
| `field_305` | INTEGER        |          | Number of top-10 full-time positions compensated $1--$39,999.   |
| `field_310` | INTEGER        |          | Number of top-10 full-time positions compensated $40,000--$79,999. |
| `field_315` | INTEGER        |          | Number of top-10 full-time positions compensated $80,000--$119,999. |
| `field_320` | INTEGER        |          | Number of top-10 full-time positions compensated $120,000--$159,999. |
| `field_325` | INTEGER        |          | Number of top-10 full-time positions compensated $160,000--$199,999. |
| `field_330` | INTEGER        |          | Number of top-10 full-time positions compensated $200,000--$249,999. |
| `field_335` | INTEGER        |          | Number of top-10 full-time positions compensated $250,000--$299,999. |
| `field_340` | INTEGER        |          | Number of top-10 full-time positions compensated $300,000--$349,999. |
| `field_345` | INTEGER        |          | Number of top-10 full-time positions compensated $350,000+.     |
| `field_370` | INTEGER        |          | **Number of part-time or part-year (e.g., seasonal) employees** during the fiscal period. |
| `field_380` | DECIMAL(15,2)  |          | **Total expenditure on compensation for part-time or part-year employees** in the fiscal period. |
| `field_390` | DECIMAL(15,2)  |          | **Total expenditure on ALL compensation** in the fiscal period (full-time + part-time). This is the amount entered on line 4880 of Schedule 6. |

**Primary Key**: (`bn`, `fpe`)
**Source CSV/API**: Compensation resource from CRA Open Data
**T3010 Form Reference**: Schedule 3 -- Compensation

> **Note**: Compensation brackets are in increments of approximately $40,000. The exact bracket boundaries should be confirmed against the current T4033 guide, as they may shift between form versions.

---

### 3.14 `cra_gifts_in_kind`

Non-cash gifts (gifts in kind) received by the charity. Corresponds to Schedule 5.

| Column      | Data Type      | Nullable | Description                                                   |
|-------------|----------------|----------|---------------------------------------------------------------|
| `bn`        | VARCHAR(15)    | NOT NULL | Business Number.                                              |
| `fpe`       | DATE           | NOT NULL | Fiscal Period End date.                                       |
| `form_id`   | INTEGER        |          | T3010 form version ID.                                        |
| `field_500` | BOOLEAN        |          | Non-cash gift type received: Artwork/wine/jewellery. *(Schedule 5.)* |
| `field_505` | BOOLEAN        |          | Non-cash gift type received: Building materials. *(Schedule 5.)* |
| `field_510` | BOOLEAN        |          | Non-cash gift type received: Clothing/furniture/food. *(Schedule 5.)* |
| `field_515` | BOOLEAN        |          | Non-cash gift type received: Vehicles. *(Schedule 5.)* |
| `field_520` | BOOLEAN        |          | Non-cash gift type received: Cultural properties. *(Schedule 5.)* |
| `field_525` | BOOLEAN        |          | Non-cash gift type received: Ecological properties. *(Schedule 5.)* |
| `field_530` | BOOLEAN        |          | Non-cash gift type received: Life insurance policies. *(Schedule 5.)* |
| `field_535` | BOOLEAN        |          | Non-cash gift type received: Medical equipment/supplies. *(Schedule 5.)* |
| `field_540` | BOOLEAN        |          | Non-cash gift type received: Privately-held securities. *(Schedule 5.)* |
| `field_545` | BOOLEAN        |          | Non-cash gift type received: Machinery/equipment/computers/software. *(Schedule 5.)* |
| `field_550` | BOOLEAN        |          | Non-cash gift type received: Publicly traded securities/commodities/mutual funds. *(Schedule 5.)* |
| `field_555` | BOOLEAN        |          | Non-cash gift type received: Books. *(Schedule 5.)* |
| `field_560` | BOOLEAN        |          | Non-cash gift type received: Other. *(Schedule 5.)* |
| `field_565` | TEXT           |          | Specify type(s) of "Other" non-cash gifts. *(Schedule 5.)* |
| `field_580` | DECIMAL(15,2)  |          | **Total amount of tax-receipted non-cash gifts.** *(Schedule 5, line 580.)* |

**Primary Key**: (`bn`, `fpe`)
**Source CSV/API**: Gifts in kind resource from CRA Open Data
**T3010 Form Reference**: Schedule 5 -- Non-Cash Gifts

---

### 3.15 `cra_political_activity_desc`

Text description of political activities conducted by the charity. Corresponds to Schedule 7 (description section).

| Column        | Data Type    | Nullable | Description                                            |
|---------------|--------------|----------|--------------------------------------------------------|
| `bn`          | VARCHAR(15)  | NOT NULL | Business Number.                                       |
| `fpe`         | DATE         | NOT NULL | Fiscal Period End date.                                |
| `form_id`     | INTEGER      |          | T3010 form version ID.                                 |
| `description` | TEXT         |          | Free-text description of political activities.         |

**Primary Key**: (`bn`, `fpe`)
**Source CSV/API**: Political activity description resource from CRA Open Data
**T3010 Form Reference**: Schedule 7 -- Political Activities (description)

---

### 3.16 `cra_political_activity_funding`

Financial details of political activities. Each row represents one political activity and its funding.

| Column            | Data Type      | Nullable | Description                                              |
|-------------------|----------------|----------|----------------------------------------------------------|
| `bn`              | VARCHAR(15)    | NOT NULL | Business Number.                                         |
| `fpe`             | DATE           | NOT NULL | Fiscal Period End date.                                  |
| `form_id`         | INTEGER        |          | T3010 form version ID.                                   |
| `sequence_number` | INTEGER        | NOT NULL | Row sequence number within the filing.                   |
| `activity`        | TEXT           |          | Description of the political activity.                   |
| `amount`          | DECIMAL(15,2)  |          | Dollar amount spent on this activity.                    |
| `country`         | CHAR(2)        |          | Country where the activity took place. FK to `cra_country_lookup.code`. |

**Primary Key**: (`bn`, `fpe`, `sequence_number`)
**Source CSV/API**: Political activity funding resource from CRA Open Data
**T3010 Form Reference**: Schedule 7 -- Political Activities (funding details)

---

### 3.17 `cra_political_activity_resources`

Resources (staff, volunteers, financial, property) dedicated to political activities.

| Column            | Data Type      | Nullable | Description                                                |
|-------------------|----------------|----------|------------------------------------------------------------|
| `bn`              | VARCHAR(15)    | NOT NULL | Business Number.                                           |
| `fpe`             | DATE           | NOT NULL | Fiscal Period End date.                                    |
| `form_id`         | INTEGER        |          | T3010 form version ID.                                     |
| `sequence_number` | INTEGER        | NOT NULL | Row sequence number within the filing.                     |
| `staff`           | INTEGER        |          | Number of staff assigned to political activities.          |
| `volunteers`      | INTEGER        |          | Number of volunteers assigned to political activities.     |
| `financial`       | DECIMAL(15,2)  |          | Financial resources dedicated to political activities.     |
| `property`        | DECIMAL(15,2)  |          | Value of property used for political activities.           |
| `other_resource`  | TEXT           |          | Description of other resources used.                       |

**Primary Key**: (`bn`, `fpe`, `sequence_number`)
**Source CSV/API**: Political activity resources resource from CRA Open Data
**T3010 Form Reference**: Schedule 7 -- Political Activities (resources)

---

### 3.18 `cra_disbursement_quota`

Disbursement quota calculations from Schedule 8. The disbursement quota is the minimum amount a charity must spend on charitable programs or gifts to qualified donees.

| Column      | Data Type      | Nullable | Description                                              |
|-------------|----------------|----------|----------------------------------------------------------|
| `bn`        | VARCHAR(15)    | NOT NULL | Business Number.                                         |
| `fpe`       | DATE           | NOT NULL | Fiscal Period End date.                                  |
| `form_id`   | INTEGER        |          | T3010 form version ID.                                   |
| `field_805` | DECIMAL(15,2)  |          | Average value of property not used in charitable activities or administration (from line 5900). *(Schedule 8, Step 1.)* |
| `field_810` | DECIMAL(15,2)  |          | Total accumulated property less all disbursements for specified purpose (if permission to accumulate was granted). *(Schedule 8, Step 1.)* |
| `field_815` | DECIMAL(15,2)  |          | Line 805 minus line 810 (if negative, enter 0). *(Schedule 8, Step 1.)* |
| `field_820` | DECIMAL(15,2)  |          | If line 815 is $1M or less: line 815 multiplied by 3.5%. *(Schedule 8, Step 1.)* |
| `field_825` | DECIMAL(15,2)  |          | If line 815 is over $1M: line 815 minus $1,000,000. *(Schedule 8, Step 1.)* |
| `field_830` | DECIMAL(15,2)  |          | If line 815 is over $1M: line 825 multiplied by 5%. *(Schedule 8, Step 1.)* |
| `field_835` | DECIMAL(15,2)  |          | If line 815 is over $1M: line 830 plus $35,000. *(Schedule 8, Step 1.)* |
| `field_840` | DECIMAL(15,2)  |          | **Disbursement quota requirement** for the current fiscal period (line 820 or line 835). *(Schedule 8, Step 1.)* |
| `field_845` | DECIMAL(15,2)  |          | Total expenditures on charitable activities (from line 5000). *(Schedule 8, Step 1.)* |
| `field_850` | DECIMAL(15,2)  |          | Total amount of grants to non-qualified donees (from line 5045). *(Schedule 8, Step 1.)* |
| `field_855` | DECIMAL(15,2)  |          | Total amount of gifts to qualified donees (from line 5050). *(Schedule 8, Step 1.)* |
| `field_860` | DECIMAL(15,2)  |          | Sum of lines 845 to 855. *(Schedule 8, Step 1.)* |
| `field_865` | DECIMAL(15,2)  |          | Line 860 minus line 840 -- disbursement quota excess or shortfall. *(Schedule 8, Step 1.)* |
| `field_870` | DECIMAL(15,2)  |          | Average value of property not used in charitable activities prior to the next fiscal period (from line 5910). *(Schedule 8, Step 2.)* |
| `field_875` | DECIMAL(15,2)  |          | If line 870 is $1M or less: line 870 multiplied by 3.5%. *(Schedule 8, Step 2.)* |
| `field_880` | DECIMAL(15,2)  |          | If line 870 is over $1M: line 870 minus $1,000,000. *(Schedule 8, Step 2.)* |
| `field_885` | DECIMAL(15,2)  |          | If line 870 is over $1M: line 880 multiplied by 5%. *(Schedule 8, Step 2.)* |
| `field_890` | DECIMAL(15,2)  |          | If line 870 is over $1M: line 885 plus $35,000. Estimated DQ for next fiscal period. *(Schedule 8, Step 2.)* |

**Primary Key**: (`bn`, `fpe`)
**Source CSV/API**: Disbursement quota resource from CRA Open Data
**T3010 Form Reference**: Schedule 8 -- Disbursement Quota

---

### 3.19 `cra_web_urls`

Website URLs associated with the charity. Unlike most data tables, this is keyed by `fiscal_year` rather than `fpe`.

| Column            | Data Type    | Nullable | Description                                           |
|-------------------|--------------|----------|-------------------------------------------------------|
| `bn`              | VARCHAR(15)  | NOT NULL | Business Number.                                      |
| `fiscal_year`     | INTEGER      | NOT NULL | Dataset year (2020--2024).                            |
| `sequence_number` | INTEGER      | NOT NULL | Row sequence number (supports multiple URLs per charity). |
| `contact_url`     | TEXT         |          | Website URL for the charity.                          |

**Primary Key**: (`bn`, `fiscal_year`, `sequence_number`)
**Source CSV/API**: Web URLs resource from CRA Open Data
**T3010 Form Reference**: Identification section -- Website address

> **Note on row count**: The source JSON contains 169,473 rows across 2020-2024 but
> the table holds 169,123 rows. The 350-row delta is due to exact-duplicate
> `(BN, fiscal_year, sequence_number)` tuples in the CKAN source — the same URL
> emitted more than once per charity per year — which `ON CONFLICT DO NOTHING`
> correctly collapses at import time. The delta is not data loss; every unique
> URL from the source is preserved. Verified by `scripts/data-quality/06-full-reload-verify.js`
> (Level 1 row-count parity is computed against *unique* source keys).

---

## 4. Views

Three convenience views are provided for common query patterns. These views join data tables with their corresponding lookup tables to provide human-readable labels.

---

### 4.1 `vw_charity_profiles`

Joins `cra_identification` with all relevant lookup tables to produce a denormalized charity profile.

**Joins**:
- `cra_identification` (base)
- `cra_category_lookup` on `category`
- `cra_sub_category_lookup` on `category` + `sub_category`
- `cra_designation_lookup` on `designation`
- `cra_country_lookup` on `country`
- `cra_province_state_lookup` on `province`

**Key Output Columns**: `bn`, `fiscal_year`, `legal_name`, `account_name`, category name (EN/FR), sub-category name (EN/FR), designation name (EN), full address fields with province and country names, `registration_date`, `language`, `contact_phone`, `contact_email`.

**Typical Use**: Look up a charity's profile by BN, search charities by category or location, list all charities in a province.

---

### 4.2 `vw_charity_financials_by_year`

Financial summary view that aliases cryptic `field_XXXX` column names to descriptive names for the most commonly used financial metrics.

**Base Table**: `cra_financial_details`

**Key Output Columns** (with human-readable aliases):

> **WARNING**: The view SQL in the database may still contain incorrect field mappings from the original build. The correct mappings are documented below. Verify the actual view definition with `\d+ vw_charity_financials_by_year` before relying on alias names.

| View Alias (correct) | Source Column | Meaning (per T3010 form) |
|------------|---------------|---------|
| `total_revenue` | field_4700 | Total revenue |
| `tax_receipted_gifts` | field_4500 | Total eligible amount of tax-receipted gifts |
| `gifts_from_other_charities` | field_4510 | Total amount received from other registered charities |
| `federal_government_revenue` | field_4540 | Total revenue received from federal government *(Schedule 6 only)* |
| `provincial_government_revenue` | field_4550 | Total revenue received from provincial/territorial governments *(Schedule 6 only)* |
| `municipal_government_revenue` | field_4560 | Total revenue received from municipal/regional governments *(Schedule 6 only)* |
| `total_expenditures_before_disbursements` | field_4950 | Total expenditures before qualifying disbursements |
| `charitable_programs_expenditure` | field_5000 | Total expenditures on charitable activities |
| `management_and_admin_expenditure` | field_5010 | Total expenditures on management and administration |
| `fundraising_expenditure` | field_5020 | Total expenditures on fundraising *(Schedule 6 only)* |
| `gifts_to_qualified_donees` | field_5050 | Total amount of gifts made to qualified donees |
| `total_expenditures` | field_5100 | Total expenditures (4950 + 5045 + 5050) |
| `total_assets` | field_4200 | Total assets (balance sheet) |
| `total_liabilities` | field_4350 | Total liabilities (balance sheet) |
| `net_assets` | field_4200 - field_4350 | Net assets (computed) |

**Typical Use**: Year-over-year financial trend analysis, benchmarking charities by revenue or expenditure, sector-wide financial summaries.

---

### 4.3 `vw_charity_programs`

Joins `cra_charitable_programs` with `cra_program_type_lookup` to include human-readable program type labels.

**Joins**:
- `cra_charitable_programs` (base)
- `cra_program_type_lookup` on `program_type`

**Key Output Columns**: `bn`, `fpe`, `program_type`, program type name (EN/FR), `description`.

**Typical Use**: Browse a charity's program descriptions, filter charities by program status (ongoing vs. new vs. inactive).

---

## 4a. Pre-computed Analysis Tables

The following **21 tables** are produced by the advanced-analysis pipeline
(`scripts/advanced/*.js` and `scripts/data-quality/*.js`), not by the 19-dataset
import. They are materialized on disk so participants don't have to recompute
them, but they are NOT part of the raw CRA Open Data feed. `npm run drop` +
`npm run setup` does not recreate them — run `npm run analyze:all` for the
loop/SCC/scoring outputs and the data-quality / donee-name / overhead scripts
for the rest.

### Loop-detection pipeline (`scripts/advanced/`)

| Table                    | Produced by                          | Contents |
|--------------------------|--------------------------------------|----------|
| `loops`                  | `01-detect-all-loops.js`             | Every 2-to-6-hop cycle found in the gift-to-qualified-donee graph. One row per directed cycle. |
| `loop_edges`             | `01-detect-all-loops.js`             | Edges (donor→donee) that participate in any detected cycle. |
| `loop_participants`      | `01-detect-all-loops.js`             | Flattened view: one row per (BN, loop) participation. |
| `loop_universe`          | `01-detect-all-loops.js`             | Per-BN rollup of how many cycles the charity participates in, by hop count. |
| `loop_financials`        | `07-loop-financial-analysis.js`      | Per-loop flow volumes (gifts given/received around the cycle). |
| `loop_charity_financials`| `07-loop-financial-analysis.js`      | Per-charity-in-loop financial profile (revenue, expenditures, gifts). |
| `loop_edge_year_flows`   | `07-loop-financial-analysis.js`      | Per-edge per-year gift amounts (for same-year / adjacent-year symmetry analysis). |
| `scc_components`         | `03-scc-decomposition.js`            | Strongly Connected Components of the gift graph (Tarjan). |
| `scc_summary`            | `03-scc-decomposition.js`            | Per-SCC rollup (size, total gift flow). |
| `matrix_census`          | `04-matrix-power-census.js`          | Walk-based cycle census (cross-validation of `loops`). |
| `partitioned_cycles`     | `05-partitioned-cycles.js`           | Johnson's algorithm run per-SCC (scalable cycle enumeration). |
| `johnson_cycles`         | `06-johnson-cycles.js`               | Cross-validation Johnson's run over the full graph. |
| `identified_hubs`        | `02-score-universe.js`               | Hub charities by in/out-degree and dollar flow. |

### Scoring & risk outputs

| Table                        | Produced by                    | Contents |
|------------------------------|--------------------------------|----------|
| `overhead_by_charity`        | `09-overhead-analysis.js`      | Per-BN per-year overhead ratios (admin + fundraising ÷ programs). |
| `overhead_by_year`           | `09-overhead-analysis.js`      | Yearly aggregate overhead distribution. |
| `overhead_by_year_designation`| `09-overhead-analysis.js`     | Yearly overhead aggregate by charity designation (A/B/C). |
| `govt_funding_by_charity`    | `08-govt-funding.js`           | Per-BN per-year federal/provincial/municipal government revenue share. |
| `govt_funding_by_year`       | `08-govt-funding.js`           | Yearly aggregate government-funding share across all charities. |

### Data-quality violation tables (`scripts/data-quality/`)

| Table                              | Produced by                           | Contents |
|------------------------------------|---------------------------------------|----------|
| `t3010_sanity_violations`          | `02-t3010-arithmetic-impossibilities.js` | Sanity-check failures (e.g., negative revenue). |
| `t3010_arithmetic_violations`      | `02-t3010-arithmetic-impossibilities.js` | Arithmetic-rule failures (line-sum reconciliation). |
| `t3010_impossibility_violations`   | `02-t3010-arithmetic-impossibilities.js` | Impossible-combination flags (e.g., compensation > total expenses). |
| `donee_name_quality`               | `10-donee-trigram-fallback.js`        | Trigram-similarity scores for recipient-name normalization. |
| `_dnq_canonical`                   | `10-donee-trigram-fallback.js`        | Helper: canonical normalized donee names. |
| `identification_name_history`      | `03-identification-backfill-check.js` | Per-BN history of legal/account name changes across years. |

> **Note**: These tables are intentionally *not* created by `01-migrate.js` —
> they are outputs of long-running analysis jobs (the 6-hop loop detection
> takes ~2 hours). On a fresh database they will be absent. Run
> `npm run analyze:all` followed by `npm run data-quality` to recreate them.

---

## 5. Key Concepts

### Business Number (BN)

The **Business Number** is the primary identifier for a registered charity in Canada.

| Component            | Format         | Example           |
|----------------------|----------------|-------------------|
| BN root              | 9 digits       | `870814944`       |
| Program type         | 2 letters       | `RR`              |
| Program number       | 4 digits       | `0001`            |
| **Full BN**          | **15 characters** | **`870814944RR0001`** |

- The `RR` program type code designates a registered charity account
- The 4-digit program number distinguishes multiple charity accounts under the same BN root (most charities use `0001`)
- The 9-digit BN root may also have other program accounts (e.g., `RP` for payroll, `RT` for GST/HST)

### Fiscal Period End (FPE)

The **Fiscal Period End** (`fpe`) is the date on which a charity's fiscal year ends. This is the primary temporal key for most data tables.

- Charities choose their own fiscal year-end (it does not have to be December 31 or March 31)
- The T3010 must be filed within 6 months of the FPE
- A single dataset year (e.g., 2023) contains filings from charities with various FPE dates

### Fiscal Year vs. FPE

Two different temporal keys are used across the schema:

| Key            | Used In                                    | Meaning                                      |
|----------------|--------------------------------------------|----------------------------------------------|
| `fiscal_year`  | `cra_identification`, `cra_web_urls`       | The CRA Open Data **dataset year** (2020--2024). Assigned during data loading, not sourced from the API. |
| `fpe`          | All other data tables                      | The charity's actual **Fiscal Period End date** from their T3010 filing.  |

### Form ID

The `form_id` field tracks the internal CRA form version used for a given filing.

| Form ID | Approximate Period | Notes                                        |
|---------|--------------------|----------------------------------------------|
| 23      | ~2020              | Earlier T3010 version                        |
| 24      | ~2021              |                                              |
| 25      | ~2022              |                                              |
| 26      | ~2023              |                                              |
| 27      | 2024+              | Major revision -- new fields added, some removed |

Form ID **27** corresponds to the **2024 T3010 form revision**, which introduced several new line items (e.g., `field_4101`, `field_4102`, `field_4157`, `field_4158`, `field_4190`, `field_4576`, `field_4577`, Schedule 8 disbursement quota fields, and DAF questions at `field_5860`--`field_5864`) and removed others (e.g., `field_4180`, `field_4505`).

### field_XXXX Naming Convention

All columns named `field_XXXX` map directly to line numbers on the T3010 form:

- **Lines 100--130**: Schedule 1 (Foundations)
- **Lines 200--260**: Schedule 2 (Activities Outside Canada)
- **Lines 300--390**: Schedule 3 (Compensation)
- **Lines 500--580**: Schedule 5 (Non-Cash Gifts)
- **Lines 805--890**: Schedule 8 (Disbursement Quota)
- **Lines 1510--1800**: Sections A/B/C (General Information)
- **Lines 2000--3400**: Sections A/B/C (Continued)
- **Lines 4020--4050**: Section D / Schedule 6 preamble (accounting basis, land ownership)
- **Lines 4100--4200**: Schedule 6 Statement of Financial Position -- Assets (balance sheet)
- **Lines 4250**: Schedule 6 Property not used in charitable activities
- **Lines 4300--4350**: Schedule 6 Statement of Financial Position -- Liabilities (balance sheet)
- **Lines 4400--4490**: Section D only (boolean questions about borrowing, tax receipts)
- **Lines 4500--4700**: Section D / Schedule 6 Revenue (tax-receipted gifts, government revenue, investment income, other revenue)
- **Lines 4800--4950**: Section D / Schedule 6 Expenditures (operating costs, compensation, total before qualifying disbursements)
- **Lines 5000--5100**: Section D / Schedule 6 Expenditure Allocation and Qualifying Disbursements (charitable activities, management/admin, fundraising, gifts to qualified donees, total expenditures)
- **Lines 5500--5510**: Permission to accumulate property
- **Lines 5610**: Tax-receipted tuition fees (Schedule 6 only)
- **Lines 5750**: Disbursement quota reduction
- **Lines 5800--5864**: Disbursement quota and DAF questions (in `cra_financial_general`)
- **Lines 5900--5910**: Property not used in charitable activities (average values)

The **CRA T4033 Guide** is the authoritative source for the meaning of each line number.

### Charity Designation

| Code | Designation              | Key Characteristics                                          |
|------|--------------------------|--------------------------------------------------------------|
| `A`  | Public Foundation        | Receives funding from multiple arm's-length sources. Primarily makes gifts to other qualified donees. Must have >50% arm's-length board members. |
| `B`  | Private Foundation       | Typically funded by a single donor, family, or related group. Subject to stricter rules on investments and self-dealing. More than 50% of directors are NOT at arm's length from each other. |
| `C`  | Charitable Organization  | Directly operates its own charitable programs. The most common designation. More than 50% of board members must be at arm's length from each other. |

---

## 6. Data Sources & References

### Primary Sources

| Source | URL |
|--------|-----|
| **CRA T3010 Form** | https://www.canada.ca/en/revenue-agency/services/forms-publications/forms/t3010.html |
| **T4033 Guide** (line-by-line instructions) | https://www.canada.ca/en/revenue-agency/services/forms-publications/publications/t4033/t4033-completing-registered-charity-information-return.html |
| **CRA Open Data Portal** | https://open.canada.ca |

### Data Dictionaries & Technical References

| Source | URL |
|--------|-----|
| **CRA Data Dictionary (2023)** | https://www.canadiancharitylaw.ca/wp-content/uploads/2025/02/CRA-open-data-data-dictionary-for-T3010.pdf |
| **CanadianCharityLaw.ca -- T3010 field changes** | https://www.canadiancharitylaw.ca/blog/detailed-information-on-changes-to-the-t3010-line-numbers-from-cra-for-registered-charities-and-cra-data-dictionary/ |
| **CharityData.ca** | https://www.charitydata.ca |

### Analysis & Commentary

| Source | URL |
|--------|-----|
| **Open Data Impact -- Opening Canada's T3010 Data** | https://odimpact.org/case-opening-canadas-t3010-charity-information-return-data.html |
| **Carters Charity Law Bulletin #525** | https://www.carters.ca/pub/bulletin/charity/2024/chylb525.pdf |
| **Miller Thomson -- New T3010 Analysis** | https://www.millerthomson.com/en/insights/social-impact/new-t3010-annual-information-return-charities/ |
| **CCCC -- New T3010 Guide** | https://www.cccc.org/news_blogs/legal/2024/01/15/new-t3010-for-january-2024/ |

---

*This data dictionary was prepared for the Pronghorn Red Hackathon. For questions about specific T3010 line items, consult the CRA T4033 Guide.*
