# Alberta Open Data — Data Dictionary

## Source

- **Publisher**: Government of Alberta Open Data Program (open.alberta.ca)
- **Schema**: `ab`
- **Tables**: 9 base + 3 views (see `AB/CLAUDE.md` for the full inventory)
- **Licence**: [Open Government Licence – Alberta](https://open.alberta.ca/licence)

Data is redistributed as-published. No rows are deleted, mutated, or
reconciled on import; publisher data-quality defects flow through to the
database untouched and are surfaced in `07-verify.js`.

## Fiscal year semantics

All four Alberta datasets use Alberta government fiscal years, which run
**April 1 → March 31**. The canonical label in the data is
`display_fiscal_year`, formatted `"YYYY - YYYY"` with spaces around the
hyphen (e.g. `"2020 - 2021"` covers payments from 2020-04-01 to 2021-03-31,
confirmed against `MIN/MAX(payment_date)` in the grants data).

For `ab_non_profit.registration_date`, the registry values go back to 1979
and are raw calendar dates — they are **not** fiscal-year-aligned. Treat
them as point-in-time registration dates, not period markers.

## Grants (`ab.ab_grants`)

Payment-level records of Alberta government grants from 2014 onward.

| Column | Type | Description |
|--------|------|-------------|
| `id` | INTEGER (PK) | Row PK (auto-generated at import) |
| `mongo_id` | VARCHAR | `_id.$oid` from the upstream MongoDB export. Unique per source record. |
| `ministry`, `business_unit_name` | TEXT | Funding department and sub-unit |
| `recipient` | TEXT | Organization or individual name as published. Not normalized. A single-space value (`' '`) appears in source data as the legitimate "unnamed recipient" aggregation key from the upstream MongoDB rollups — do not treat it as whitespace noise. |
| `program` | TEXT | Grant program name |
| `amount` | NUMERIC | Payment amount, CAD. **Can be negative** — those rows are reversals / corrections (e.g. $12B of negative entries across the series, ~43K rows). Carried through as-published. |
| `lottery`, `lottery_fund` | TEXT | Source uses string literals `"True"` / `"False"`, not boolean. No `CHECK` constraint — if the upstream source ever shifts to `Y`/`N` or lowercase, equality filters will silently miss rows. |
| `payment_date` | TIMESTAMP | Date of payment |
| `fiscal_year` | TEXT | **Use `display_fiscal_year` instead.** In the current source data, 118 rows in the 2023–2024 window contain calendar-date strings (`"2023-04-06"`, `"2023-05-02"`, …) instead of the expected `"YYYY - YYYY"` string — a source defect carried through without modification. |
| `display_fiscal_year` | TEXT | Canonical fiscal-year label, always `"YYYY - YYYY"`. This is the column to filter and group by. |
| `version`, `created_at`, `updated_at` | — | Import provenance |

### Grant aggregation tables

The source publisher ships four pre-rolled aggregation tables alongside the
raw grant records. These are redundant with `ab_grants` but faster for
dashboards.

| Table | Row count | What it rolls up |
|-------|-----------|------------------|
| `ab_grants_fiscal_years` | 11 | Totals per fiscal year |
| `ab_grants_ministries` | 321 | Per ministry, per fiscal year AND across all years |
| `ab_grants_programs` | ~17K | Per program, per ministry, per fiscal year AND across all years |
| `ab_grants_recipients` | ~420K | Totals per recipient across all years |

**`aggregation_type` (on `ab_grants_ministries` and `ab_grants_programs`)**
distinguishes the two roll-up styles:

| Value | Meaning |
|-------|---------|
| `by_fiscal_year` | Row is a per-fiscal-year subtotal |
| `all_years` | Row is an all-time total for the ministry/program |

**Always filter by `aggregation_type = 'by_fiscal_year'` when joining against
`ab_grants_fiscal_years` or treating rows as annual counts** — otherwise you
will double-count the all-time rollup on top of the annual rows.

## Contracts — Blue Book (`ab.ab_contracts`)

Published competitive-procurement contract awards from the Alberta
Purchasing Connection ("Blue Book"). Columns follow the source spreadsheet:
`ministry`, `recipient` (vendor), `amount`, `display_fiscal_year`, and a
free-text `description` / `contract_type`. Like grants, `display_fiscal_year`
is the canonical period label.

## Sole-source contracts (`ab.ab_sole_source`)

Sole-source contracts of $10,000+ for services, published quarterly per the
Alberta Procurement Accountability Framework. ~15.5K rows.

Key columns beyond the obvious `vendor`, `ministry`, `amount`,
`start_date`/`end_date`, `contract_number`, `contract_services`,
`display_fiscal_year`, and address fields:

### `permitted_situations`

The justification code for why the contract was sole-sourced rather than
openly tendered. The source data uses lowercase letters `a` through `l`
plus `z`. Alberta publishes the twelve permitted situations narratively
(numbered 1–12) on the sole-source contracts page; the letter-to-situation
mapping below is inferred from that positional ordering and should be
independently verified against the Alberta Procurement Accountability
Framework manual before use in citations.

| Code | Count | Description (positional inference from the Alberta list) |
|------|-------|-----------------------------------------------------------|
| `a` | 2 | Procurement from philanthropic institutions, prison labour, or persons with disabilities |
| `b` | 3,570 | Procurement from a public body or non-profit organization |
| `c` | 38 | Services / goods or services for Construction, purchased for representational or promotional purposes outside of Alberta |
| `d` | 7,825 | Health services and social services |
| `e` | — (0 in snapshot) | On behalf of an entity not covered by the NWPTA |
| `f` | 4 | Commercial agreements for sporting or convention facility operators that are incompatible with NWPTA procurement obligations |
| `g` | 2,280 | Only one supplier is able to meet the requirements |
| `h` | 334 | Unforeseeable situation of urgency; services could not be obtained via open procurement |
| `i` | 94 | Confidential / privileged acquisitions where open bidding could compromise government confidentiality, cause disruption, or harm public interest |
| `j` | 967 | Services provided by lawyers and notaries |
| `k` | 74 | Treasury services |
| `l` | 38 | No bids received in response to a call for tenders |
| `z` | 307 | **Sole-sourced outside of the twelve permitted situations** (non-compliant designation per the Alberta page) |

Sources: [Alberta sole-source contracts](https://www.alberta.ca/sole-source-contracts) ·
[Alberta sole-source contracts disclosure table](https://www.alberta.ca/sole-source-contracts-disclosure-table) ·
[Alberta Procurement Accountability Framework Manual (2018)](https://open.alberta.ca/publications/procurement-and-sole-sourcing-policy).

### `special`

Boolean-as-text. Two values only in the current snapshot:

| Value | Count |
|-------|-------|
| `true` | 9,911 |
| `false` | 5,622 |

The semantic meaning of this flag is not documented by the publisher. Until
an authoritative source is found, treat it as opaque source metadata and
quote counts by value rather than interpreting the flag.

## Non-Profit Registry (`ab.ab_non_profit`)

~69K records from the Alberta Corporate Registry covering every registered
non-profit legal entity. Includes `type` (legal form — "Society",
"Agricultural Society", etc.), `legal_name`, `status` code (see
`ab_non_profit_status_lookup`), `registration_date` (back to 1979), and
address.

`ab_non_profit_status_lookup` maps the short status codes (e.g. `A`, `D`,
`S`) to human descriptions — see the view `ab.vw_non_profit_decoded` for
pre-joined output.

## Known source defects

Surfaced by `npm run verify` but **not** corrected on import:

- **`ab_grants.fiscal_year` date contamination** — 118 rows in the
  `"2023 - 2024"` fiscal year have calendar-date strings in the `fiscal_year`
  column. `display_fiscal_year` is still correct for these rows; prefer it.
- **`ab_grants.lottery` / `lottery_fund`** — no `CHECK` constraint. Only
  `"True"` / `"False"` observed today, but the schema permits arbitrary
  strings.
- **`ab_sole_source.special`** — boolean-as-text; undocumented semantics.
- **Cross-dataset name matching is not pre-computed.** `ab_non_profit`,
  `ab_grants.recipient`, and `ab_contracts.recipient` are not reconciled
  at import time. The `general` schema (`general.entity_golden_records`)
  provides cross-dataset entity resolution when you need to join these.

## Views

- `ab.vw_grants_by_ministry` — grants aggregated by ministry / fiscal year
- `ab.vw_grants_by_recipient` — grants aggregated by recipient
- `ab.vw_non_profit_decoded` — `ab_non_profit` joined with status definitions
