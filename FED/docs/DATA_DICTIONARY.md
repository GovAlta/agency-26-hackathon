# Federal Grants and Contributions - Data Dictionary

## Source

- **Dataset**: Proactive Publication - Grants and Contributions
- **Portal**: [Government of Canada Open Data](https://open.canada.ca)
- **Resource ID**: `1d15a62f-5656-49ad-8c88-f40ce689d831`
- **Authoritative schema**: `docs/grants.json`, `docs/grants.xlsx` (TBS reporting
  guide; field descriptions in this document quote that spec verbatim)
- **Schema**: `fed`
- **Table**: `fed.grants_contributions`
- **Data is redistributed as-published.** No rows are deleted, mutated, or
  reconciled on import; publisher data-quality defects flow through to the
  database untouched and are surfaced in `05-verify.js` and the "Known source
  defects" section below.

## Main Table: `fed.grants_contributions`

| Column | Type | Description |
|--------|------|-------------|
| `_id` | INTEGER (PK) | **Row primary key.** Assigned by the Open Data API. The only column that is guaranteed unique per row — see `ref_number` caveat below. |
| `ref_number` | TEXT | Department reference number, format `DDD-YYYY-YYYY-QX-XXXXX`. Per TBS spec: "unique reference number given to each entry." In practice, groups all amendments of one agreement (rows share `ref_number` and differ by `amendment_number`). **Publisher defects exist** — see "Known source defects". |
| `amendment_number` | TEXT | `0` for original records, `1, 2, 3, ...` for successive amendments. Per TBS spec: "Numeric only" / `int`. Stored here as TEXT; the values are 100% integer-castable in the live data. Cast to `int` before numeric comparison so `"10"` sorts after `"2"`. |
| `amendment_date` | DATE | Date the amendment took effect. NULL for originals. |
| `agreement_type` | TEXT | `G`=Grant, `C`=Contribution, `O`=Other transfer payment. Some source rows use the full word ("Contribution", "Grant") — see `06-fix-quality.js`. |
| `agreement_number` | TEXT | **Optional per TBS spec** — a free-text department reference. Often a program/award code (e.g. `URU`, `RGPIN`, `EGP`) that is reused across thousands of grants, so **do not use as a join key**. |
| `recipient_type` | TEXT | `A`=Indigenous, `F`=For-profit, `G`=Government, `I`=International, `N`=Not-for-profit, `O`=Other, `P`=Individual, `S`=Academia and public institutions. NULL common in pre-2018 data; TBS made this field mandatory for agreements starting on/after 2025-12-01. |
| `recipient_business_number` | TEXT | Per TBS spec, the 9-digit CRA Business Number (no `RR`/`RC` suffix). In practice the column carries many formats — see "Known source defects". |
| `recipient_legal_name` | TEXT | Legal name (English\|French) |
| `recipient_operating_name` | TEXT | Operating/trade name |
| `research_organization_name` | TEXT | Academic partner organization |
| `recipient_country` | TEXT | ISO country code (e.g., CA) |
| `recipient_province` | TEXT | Province/territory code (e.g., AB, ON, QC) |
| `recipient_city` | TEXT | City name |
| `recipient_postal_code` | TEXT | Canadian postal code (A1A 1A1) |
| `federal_riding_name_en` | TEXT | Federal riding name (English) |
| `federal_riding_name_fr` | TEXT | Federal riding name (French) |
| `federal_riding_number` | TEXT | 5-digit federal riding code |
| `prog_name_en` | TEXT | Program name (English) |
| `prog_name_fr` | TEXT | Program name (French) |
| `prog_purpose_en` | TEXT | Program purpose (English) |
| `prog_purpose_fr` | TEXT | Program purpose (French) |
| `agreement_title_en` | TEXT | Agreement title (English) |
| `agreement_title_fr` | TEXT | Agreement title (French) |
| `agreement_value` | DECIMAL(15,2) | Agreement value in CAD |
| `foreign_currency_type` | TEXT | Foreign currency code (e.g., USD) |
| `foreign_currency_value` | DECIMAL(15,2) | Amount in foreign currency |
| `agreement_start_date` | DATE | Agreement start date |
| `agreement_end_date` | DATE | Agreement end date |
| `coverage` | TEXT | Coverage information |
| `description_en` | TEXT | Description (English) |
| `description_fr` | TEXT | Description (French) |
| `expected_results_en` | TEXT | Expected results (English) |
| `expected_results_fr` | TEXT | Expected results (French) |
| `additional_information_en` | TEXT | Additional info (English) |
| `additional_information_fr` | TEXT | Additional info (French) |
| `naics_identifier` | TEXT | NAICS industry classification code |
| `owner_org` | TEXT | Department code |
| `owner_org_title` | TEXT | Department name (bilingual) |

## Reference/Lookup Tables

### `fed.agreement_type_lookup`
| Code | English | French |
|------|---------|--------|
| G | Grant | subvention |
| C | Contribution | contribution |
| O | Other transfer payment | autre |

### `fed.recipient_type_lookup`
| Code | English | French |
|------|---------|--------|
| A | Indigenous recipients | bénéficiaire autochtone |
| F | For-profit organizations | organisme à but lucratif |
| G | Government | gouvernement |
| I | International (non-government) | organisation internationale |
| N | Not-for-profit organizations and charities | organisme à but non lucratif |
| O | Other | autre |
| P | Individual or sole proprietorships | particulier |
| S | Academia and public institutions | établissement universitaire et institution publique |

Per TBS spec, `recipient_type` became mandatory for agreements with an
`agreement_start_date` on or after 2025-12-01. Earlier records may have NULL
`recipient_type` — ~148K such rows exist (pre-2018 data).

### `fed.country_lookup`
249+ countries with ISO 3166 codes. English and French names.

### `fed.province_lookup`
13 Canadian provinces and territories (AB, BC, MB, NB, NL, NS, NT, NU, ON, PE, QC, SK, YT).

### `fed.currency_lookup`
100+ world currencies with ISO 4217 codes.

## Views

### `fed.vw_grants_decoded`
Joins grants_contributions with all lookup tables to provide human-readable
names for codes. **Does not filter amendments.** Each amendment of the same
agreement appears as a separate row — do not aggregate `agreement_value`
across this view. Use `fed.vw_agreement_current` (for current totals) or
`fed.vw_agreement_originals` (for initial commitments) instead.

### `fed.vw_agreement_current`
One row per distinct agreement, giving its **current committed value** —
i.e. the `agreement_value` on the highest-numbered amendment for the
agreement. This is the view that answers "how much has been committed under
this agreement, taking amendments into account?" Partition key is
`(ref_number, COALESCE(recipient_business_number, recipient_legal_name, _id))`
to survive publisher ref_number collisions (see "Known source defects"); see
the comment on the view in `scripts/01-migrate.js` for the trade-offs.

### `fed.vw_agreement_originals`
All rows with `amendment_number = 0` — i.e. the initial commitment before any
amendment. Use this to answer "what was originally agreed" or "what is the
initial commitment volume per department." If you only care about not
double-counting amendments and don't need amendment-adjusted totals, this
view is the simplest way to get there.

### `fed.vw_grants_by_department`
Aggregated summary: grant count, total value, avg value by department and
agreement type. Filters `is_amendment = false`, so sums reflect original
commitments (not amendment-adjusted totals).

### `fed.vw_grants_by_province`
Aggregated summary: grant count, total value, avg value by province. Filters
`is_amendment = false`, so sums reflect original commitments.

## How to sum `agreement_value` correctly

Per TBS spec, `agreement_value` is **"the total grant or contribution value,
and not the change in agreement value."** Every amendment row re-states the
new total for the whole agreement — it is a cumulative snapshot, not a delta.
The consequence: a naive `SUM(agreement_value)` over all rows double- or
triple-counts amended agreements. As of the current data snapshot:

| Query | $CAD | What it represents |
|-------|------|--------------------|
| `SUM(agreement_value)` across **all** rows | ~$921B | **Wrong.** Counts each amendment snapshot again. |
| `SUM(agreement_value) WHERE is_amendment = false` *(or `vw_agreement_originals`)* | ~$533B | Original commitments only — ignores every upward or downward amendment. |
| `SUM(agreement_value) FROM vw_agreement_current` | ~$816B | **Current total commitment** — takes the latest amendment's value per agreement. |

Pick the column that matches your question:

- "What is the current value of federal commitments?" → `vw_agreement_current`.
- "What was initially agreed?" → `vw_agreement_originals`.
- "Every published snapshot, including amendments" (rarely the right default) →
  query the base table directly.

## Known source defects

No row is modified or deleted during import; publisher defects flow through
untouched and are surfaced by `npm run verify`. Known categories (counts
reflect the current snapshot):

- **`ref_number` collisions across distinct recipients** — ~41K `ref_number`
  values appear under ≥2 different recipients, in violation of the TBS
  "unique reference number given to each entry" rule. Concentrated in pre-2018
  legacy `GC-…` records. Example: `001-2020-2021-Q1-00006` covers a $23,755
  Canadian Heritage Photography Foundation grant *and* a $20.5M→$36.24M
  Women's Shelters Canada contribution.
- **Duplicate `(ref_number, amendment_number)` tuples** — ~26K pairs have
  two or more rows with the same tuple. Unambiguous defect.
- **`recipient_business_number` format drift** — per TBS spec, a 9-digit
  Canadian Business Number. In practice the column contains a polyglot of
  formats: 15-char CRA BNs (~337K), 9-digit BNs (~207K), 17-char values with
  embedded spaces, and ~19K single-character placeholders such as `-`.
  Cross-dataset joins should validate format before trusting the column.
- **`agreement_value` sign and zero** — TBS spec: *"must be greater than 0."*
  ~4.6K rows have negative values (99.7% of them on amendment rows, used as
  termination/reversal markers — a de facto convention not in the spec) and
  ~11.5K rows have `agreement_value = 0`.
- **`agreement_type` free-text variants** — most rows use the spec codes
  `G`/`C`/`O`, but some departments publish full words
  ("Contribution", "Grant", etc.). `06-fix-quality.js` normalizes casing and
  maps common variants; unmatched strings remain as-is.

## Key Indexes

- Agreement type, recipient type, province, country (filter queries)
- Start date, end date (date range queries)
- Agreement value (range queries)
- Owner org (department analysis)
- Full-text search on recipient name and program name (GIN indexes)
- NAICS identifier, federal riding number (classification queries)
- `is_amendment` (for the originals-only filter used by most views)
