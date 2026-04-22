# AI For Accountability - Part 1: CRA T3010 Charity Data Pipeline

**Hackathon: AI For Accountability** | April 29, 2026 | Government of Alberta

A complete, reproducible data pipeline that downloads, transforms, and loads **5 years of CRA T3010 charity disclosure data** (2020-2024) into PostgreSQL for AI-driven accountability analysis.

---

## What's In This Dataset

| Metric | Value |
|--------|-------|
| **Total rows loaded** | ~8.76M (7.3M T3010 raw + ~1.42M pre-computed analysis) |
| **T3010 raw-data rows** | ~7.3M |
| **Fiscal years** | 2020, 2021, 2022, 2023, 2024 |
| **Registered charities per year** | ~72,000 – 85,000 |
| **Dataset categories** | 19 per year (93 total, some years missing disbursement_quota) |
| **Database tables** | 49 + 3 views (6 lookup + 19 raw-data + 24 pre-computed analysis) |
| **Data source** | Canada Revenue Agency T3010 via Government of Canada Open Data API |

### Important Note on 2024 Data

The 2024 dataset represents a **partial year**. CRA requires charities to file within 6 months of their fiscal year end. Charities with December 31, 2024 year-ends have until June 30, 2025 to file. The 2024 data contains 71,954 identification records vs ~84,000 in prior complete years. The Dec 31 year-end cohort (the largest group) shows 37,693 filings in 2024 vs ~48,500 in complete years - consistent with a filing lag, not data loss. A refresh of the 2024 data will be requested from the Government of Canada as filings complete.

The 2024 data was also filed on a **revised T3010 form** (Version 24, released January 8, 2024), which added new fields (donor advised funds, impact investments, asset breakdowns) and removed deprecated fields. Our schema captures the union of all form versions - NULLs where a field doesn't exist for a given year. See [DATA_DICTIONARY.md](docs/DATA_DICTIONARY.md) for details.

---

## Database Access

This project uses a two-tier access model:

| File | Committed to Repo? | Access Level | Who Uses It |
|------|:------------------:|-------------|------------|
| `.env.public` | Yes | **Read-only** (SELECT only) | Hackathon participants, AI agents |
| `.env` | No (gitignored) | **Full admin** (read/write) | Data pipeline operators |

**Participants:** After obtaining a read-only `.env.public` (distributed out-of-band — see [SECURITY.md](../SECURITY.md)) and running `npm install`, you can immediately query ~8.76M rows of CRA data (7.3M T3010 raw data plus ~1.42M pre-computed accountability-analysis tables). No setup or data loading required.

**Administrators:** Use `.env` with admin credentials to load data or manage the schema. To rotate the read-only credentials:
```bash
npm run readonly:revoke    # Terminates sessions, drops user, deletes .env.public
npm run readonly:create    # Creates new user with fresh password, writes .env.public
```

The `lib/db.js` module loads `.env` first. If no `.env` exists, it falls back to `.env.public` automatically.

---

## Quick Start

### Prerequisites

- **Node.js 18+**
- **PostgreSQL** database (connection string in `.env`)

### Option A: Full Pipeline (download + load everything)

```bash
npm install
npm run setup            # Runs: migrate → seed → fetch → import → verify
```

Or step by step:

```bash
npm install
npm run migrate          # Creates cra schema, 6 lookup + 19 data + 24 analysis tables + 3 views
npm run seed             # Load 620 lookup rows
npm run fetch            # Download 2020-2024 from Government of Canada Open Data API (93 datasets)
npm run import           # Load cached JSON into PostgreSQL (7,338,550 rows)
npm run verify           # Run 195 verification checks
```

To tear down and rebuild:

```bash
npm run reset            # Runs: drop → setup
```

### Option B: Use the Pre-Loaded Database (read-only)

A read-only connection is provided in `.env.public`. No setup required - just query:

```bash
npm install
# .env.public is included in the repo with read-only credentials
node -e "const db = require('./lib/db'); db.query('SELECT COUNT(*) FROM cra_identification').then(r => { console.log(r.rows[0]); db.end(); })"
```

The `lib/db.js` module automatically falls back to `.env.public` if no `.env` file exists. This means hackathon participants can clone the repo, run `npm install`, and immediately query the database or run the analysis scripts.

---

## Project Structure

```
CRA/
├── .env.public                  # Read-only DB credentials (committed, safe to share)
├── config/datasets.js           # UUID registry for all 93 datasets across 5 years
├── lib/                         # Shared libraries
│   ├── db.js                    #   PostgreSQL connection pool (.env → .env.public fallback)
│   ├── api-client.js            #   Gov of Canada API (retries, pagination, cache)
│   ├── transformers.js          #   Data type converters
│   └── logger.js                #   Timestamped logging
├── scripts/                     # Pipeline scripts (run in order)
│   ├── 01-migrate.js            #   Create schema + all tables (lookup, data, analysis)
│   ├── 02-seed-codes.js         #   Seed lookup tables (620 rows)
│   ├── 03-fetch-data.js         #   Download 2020-2024 from API
│   ├── 04-import-data.js        #   Import cached JSON to database
│   ├── 05-verify.js             #   195 verification checks
│   ├── drop-tables.js           #   Drop all tables (destructive)
│   ├── clear-cache.js           #   Delete cached API data
│   ├── download-data.js         #   Export tables as CSV/JSON by year
│   ├── create-readonly-user.js  #   Create read-only DB user + .env.public
│   └── revoke-readonly-user.js  #   Revoke read-only user + delete .env.public
├── scripts/advanced/            # Analysis scripts
│   ├── 01-detect-all-loops.js   #   Brute-force 2-6 hop cycle detection
│   ├── 02-score-universe.js     #   Deterministic 0-30 risk scoring
│   ├── 03-scc-decomposition.js  #   Tarjan SCC decomposition
│   ├── 04-matrix-power-census.js#   Walk census (cross-validation)
│   ├── 05-partitioned-cycles.js #   SCC-partitioned Johnson's
│   ├── 06-johnson-cycles.js     #   Johnson's algorithm (cross-validation)
│   ├── lookup-charity.js        #   Interactive network lookup
│   └── risk-report.js           #   Interactive risk report
├── data/
│   ├── cache/                   #   Source data (JSON) by year
│   ├── downloads/               #   Exported CSV/JSON (gitignored)
│   ├── reports/                 #   Analysis reports (gitignored)
│   └── 5 Year Inventory.xlsx    #   UUID lookup spreadsheet
├── tests/                       # Automated test suite
│   ├── unit/                    #   Unit tests (no DB required)
│   └── integration/             #   Schema + data integrity tests
├── docs/
│   ├── ARCHITECTURE.md          #   System architecture & design decisions
│   ├── DATA_DICTIONARY.md       #   Complete field reference with CRA mappings
│   ├── SAMPLE_QUERIES.sql       #   Ready-to-run analytical queries
│   └── guides-forms/            #   Authoritative CRA source documents (ground truth)
├── LICENSE                      #   MIT (Government of Alberta)
└── README.md                    #   This file
```

---

## Pipeline Commands

All data for all five fiscal years (2020-2024) loads through a single unified pipeline using the Government of Canada Open Data API.

```bash
npm run fetch            # Downloads via CKAN datastore_search API
npm run import           # Loads cached JSON into PostgreSQL
```

- **Source**: `https://open.canada.ca/data/en/api/3/action/datastore_search`
- **Pagination**: 10,000 records per page, automatic offset tracking
- **Retry**: 5 attempts with exponential backoff (2s - 32s)
- **Caching**: Downloaded data saved as JSON in `data/cache/{year}/`
- **UUID Registry**: `config/datasets.js` maps 93 dataset/year combinations to API resource IDs
- **Per-year control**: `npm run fetch:2020`, `npm run import:2023`, etc.

### npm Scripts

| Script | Description |
|--------|-------------|
| `npm run setup` | Full pipeline: migrate + seed + fetch + import + verify |
| `npm run reset` | Drop all tables then run setup |
| `npm run migrate` | Create cra schema, all tables, views |
| `npm run seed` | Load 620 lookup rows |
| `npm run fetch` | Download all 93 datasets from API |
| `npm run import` | Load cached JSON into PostgreSQL |
| `npm run verify` | Run 195 verification checks |
| `npm run drop` | Drop all tables |
| `npm run fetch:2020` ... `fetch:2024` | Fetch a single year |
| `npm run import:2020` ... `import:2024` | Import a single year |
| `npm run analyze:all` | Full pipeline: loops → scc → partitioned → johnson → matrix → financial → score (~2 hrs, dominated by 6-hop loops) |
| `npm run analyze:full` | `drop:loops --yes` + `analyze:all` — clean-slate re-run |
| `npm run analyze:loops` | Brute-force cycle detection (2-6 hop, ~100 min for 6-hop) |
| `npm run analyze:scc` | Tarjan SCC decomposition (<1 s) |
| `npm run analyze:partitioned` | SCC-partitioned cycle detection (~14 s) |
| `npm run analyze:johnson` | Johnson's algorithm cycles, capped at 6 hops |
| `npm run analyze:matrix` | Matrix-power walk census (cross-validates loops / Johnson) |
| `npm run analyze:financial` | Per-loop and per-charity financial recomputation (reads `cra.loops`) |
| `npm run analyze:score` | Deterministic 0-30 risk scoring (~45 min) |
| `npm run drop:loops` | Drops all 13 loop/SCC/matrix/financial tables (`-- --yes` to skip prompt) |
| `npm run lookup -- --name "..."` | Interactive charity network lookup |
| `npm run risk -- --bn ...` | Interactive risk report |
| `npm run download` | Export tables as CSV/JSON |
| `npm run readonly:create` | Create read-only DB user |
| `npm run readonly:revoke` | Revoke read-only DB user |

---

## Checks and Balances

### Verification Pipeline

Every data load is verified for completeness and integrity:

| Check | What It Verifies |
|-------|-----------------|
| API source count | Fetched records == API's reported total |
| DB row count | Database rows match fetched records (1% tolerance for invalid rows) |
| Balance report | Side-by-side: API Total / Fetched / DB Rows for all 93 datasets |
| Data quality | BN format (15 chars), designation values (A/B/C), province codes (2 chars) |
| Cross-year | All fiscal years present, financial data spans multiple FPE years |
| Unit tests | Transformers, cache I/O, UUID validation, dataset config |
| Integration tests | Schema existence, lookup population, row counts, data quality |

### Idempotency Guarantees

| Operation | Mechanism |
|-----------|-----------|
| Schema creation | `CREATE TABLE IF NOT EXISTS` |
| Lookup seeding | `INSERT ON CONFLICT DO UPDATE` |
| Data import | `INSERT ON CONFLICT DO NOTHING` |
| Cache | Skips datasets already downloaded |

### Results Achieved

- 93/93 datasets fetched and imported
- 7,338,550 total rows loaded
- 195/195 verification checks passed

---

## Downloading Data

Export any table as CSV or JSON, optionally filtered by fiscal year:

```bash
# Download all tables, all years, as CSV
npm run download

# Download just 2024 data
npm run download -- --year 2024

# Download as JSON
npm run download -- --year 2023 --format json

# Download a single table
npm run download -- --table cra_directors --year 2024 --format csv
```

Files are saved to `data/downloads/` (gitignored). Works with the read-only `.env.public` credentials.

---

## Database Schema

All CRA tables live in the `cra` schema. The connection's `search_path` includes `cra`, so queries work with or without the schema prefix:

```sql
-- Both of these work:
SELECT * FROM cra_identification WHERE fiscal_year = 2024;
SELECT * FROM cra.cra_identification WHERE fiscal_year = 2024;
```

This namespacing keeps CRA data separate from other datasets that may be added in the future.

### Key Concepts

| Concept | Description |
|---------|-------------|
| **BN** | Business Number: `870814944RR0001` (9 digits + RR + 4-digit program #) |
| **FPE** | Fiscal Period End: the date when a charity's fiscal year ends |
| **Form ID** | CRA internal version (23-27). Form ID 27 = 2024 T3010 revision |
| **field_XXXX** | Maps directly to T3010 line numbers (see T4033 guide) |
| **Designation** | A = Public Foundation, B = Private Foundation, C = Charitable Organization |
| **DECIMAL(18,2)** | All financial fields use this precision to handle outlier values |

### Data Tables

| Table | Description | PK | Rows |
|-------|-------------|-----|------|
| `cra_identification` | Charity name, address, category | (bn, fiscal_year) | 421,866 |
| `cra_directors` | Board members and officers | (bn, fpe, seq) | 2,873,624 |
| `cra_financial_details` | Revenue, expenditures, assets (Section D / Schedule 6) | (bn, fpe) | 420,849 |
| `cra_financial_general` | Program areas, Y/N flags (Sections A-C) | (bn, fpe) | 422,683 |
| `cra_qualified_donees` | Gifts to qualified donees | (bn, fpe, seq) | 1,664,343 |
| `cra_charitable_programs` | Program descriptions | (bn, fpe, type) | 478,691 |
| `cra_compensation` | Employee compensation (Schedule 3) | (bn, fpe) | 216,380 |
| `cra_foundation_info` | Foundation data (Schedule 1) | (bn, fpe) | 422,569 |
| `cra_non_qualified_donees` | Grants to non-qualified donees (grantees) | (bn, fpe, seq) | 29,270 |
| `cra_gifts_in_kind` | Non-cash gifts (Schedule 5) | (bn, fpe) | 54,575 |
| `cra_web_urls` | Contact URLs | (bn, fiscal_year, seq) | 169,123 |
| `cra_activities_outside_*` | International activities (Schedule 2) | various | ~70,000 combined |
| `cra_political_activity_*` | Political activities (Schedule 7) | various | ~550 combined |
| `cra_disbursement_quota` | Disbursement calculations (Schedule 8) | (bn, fpe) | 22,151 |

See [docs/DATA_DICTIONARY.md](docs/DATA_DICTIONARY.md) for complete column-level documentation.

### Useful Queries

```sql
-- Search charities by name
SELECT bn, legal_name, city, province, designation
FROM cra_identification
WHERE legal_name ILIKE '%search term%' AND fiscal_year = 2024;

-- Revenue trends for a charity across 5 years
SELECT EXTRACT(YEAR FROM fpe) AS year, field_4700 AS revenue,
       field_5100 AS expenditures, field_4200 AS assets
FROM cra_financial_details
WHERE bn = '123456789RR0001'
ORDER BY fpe;

-- Top 20 charities by revenue (latest year)
SELECT ci.legal_name, fd.field_4700 AS revenue
FROM cra_financial_details fd
JOIN cra_identification ci ON fd.bn = ci.bn AND ci.fiscal_year = 2023
WHERE fd.fpe >= '2023-01-01' AND fd.fpe <= '2023-12-31'
ORDER BY fd.field_4700 DESC NULLS LAST LIMIT 20;

-- Directors serving on multiple charities (network analysis)
SELECT last_name, first_name, COUNT(DISTINCT bn) AS charities
FROM cra_directors
WHERE fpe >= '2023-01-01'
GROUP BY last_name, first_name
HAVING COUNT(DISTINCT bn) > 5
ORDER BY charities DESC;

-- Charities with international spending
SELECT ci.legal_name, aod.field_200 AS intl_spending
FROM cra_activities_outside_details aod
JOIN cra_identification ci ON aod.bn = ci.bn AND ci.fiscal_year = 2024
WHERE aod.fpe >= '2024-01-01' AND aod.field_200 > 0
ORDER BY aod.field_200 DESC LIMIT 20;
```

---

## Advanced Analysis: Circular Gifting Detection

The `scripts/advanced/` directory contains a multi-method pipeline for detecting circular funding patterns, stored in database tables for direct SQL querying.

### Quick Start

```bash
npm run analyze:all          # Full pipeline — see step list below (~2 hrs, dominated by 6-hop loops)
```

If you want to repopulate from scratch (because upstream CRA data changed
or because a prior run left orphan rollup rows — see `KNOWN-DATA-ISSUES.md`
C-9):

```bash
npm run analyze:full         # drop:loops --yes + analyze:all
```

`analyze:full` is safe to run anytime — every stage's migrate is
idempotent (`CREATE TABLE / INDEX IF NOT EXISTS`), so scripts self-bootstrap
against a freshly dropped DB without a `--migrate` flag.

Or step-by-step:

```bash
npm run analyze:loops        # 01 — brute-force self-join, 2-6 hops (~100 min for 6-hop)
npm run analyze:scc          # 03 — Tarjan SCC decomposition (<1 s)
npm run analyze:partitioned  # 05 — SCC-partitioned Johnson's (~14 s)
npm run analyze:johnson      # 06 — Johnson's on full graph, capped at 6 hops
npm run analyze:matrix       # 04 — matrix-power walk census (cross-validates 01/06)
npm run analyze:financial    # 07 — per-loop / per-charity financial recomputation
npm run analyze:score        # 02 — 0-30 risk scoring (~45 min)
```

Order matters: 01 produces `loop_edges` / `loops` consumed by 03, 05, 06, 07;
03 produces `scc_components` consumed by 04 and 05; 06 produces
`johnson_cycles` used by 04 for the `in_johnson_cycle` flag. 02 is a
read-only scorer and must run last.

Drop and rebuild anything:

```bash
npm run drop:loops           # interactive — confirm "yes" at the prompt
npm run drop:loops -- --yes  # non-interactive
```

### Scripts

| # | Script | What It Does | Speed |
|---|--------|-------------|-------|
| 01 | `01-detect-all-loops.js` | **Primary.** Iterative dead-end pruning (237K to ~54K edges), then N-way self-joins per hop. Temporal constraint (year window +/-1). Ground truth results. | 2-5 hop: ~8 min. 6-hop: ~2.5 hrs |
| 02 | `02-score-universe.js` | Risk scoring: circular + financial + temporal factors for every charity in a loop. Reads from `cra.loop_participants`. | ~4 min (1,501 BNs) |
| 03 | `03-scc-decomposition.js` | Tarjan's SCC. Shows network structure: 1 giant SCC (8,971 nodes, mostly denominational) + 338 small SCCs. | <1 sec |
| 04 | `04-matrix-power-census.js` | Closed-walk census via matrix powers. Cross-validation diagnostic. Counts walks (not simple cycles). | ~5 min |
| 05 | `05-partitioned-cycles.js` | Johnson's algorithm per SCC. Small SCCs get full enumeration. Giant SCC gets hub removal + fragmentation. Fast but misses most cycles routing through hubs. | ~40 sec |
| 06 | `06-johnson-cycles.js` | Johnson's on full graph, cap at 6 hops. Slower than 05 because giant SCC is not partitioned out. | ~80 min |

### Measured runtime (2026-04-19, Render Pro-16GB, max-hops 6)

The hackathon tested `analyze:full` end-to-end. Numbers below are the
per-phase wall clock for future reference when budgeting a re-run. The
6-hop query is the dominant cost — everything else is measured in
single-digit minutes.

| Phase | Wall clock | Output |
|-------|-----------:|--------|
| 01 edge build + iterative pruning | 2 s | 243,940 → 53,771 edges (78% pruned) |
| 01 2-hop | 0.2 s | 508 cycles |
| 01 3-hop | 0.5 s | 236 cycles |
| 01 4-hop | 3.2 s | 472 cycles |
| 01 5-hop | 7 min 36 s | 1,161 cycles |
| 01 6-hop | **2 h 34 min** | 3,431 cycles |
| 01 participant + universe build | <1 s | 30,003 participants, 1,501 universe BNs |
| 03 Tarjan SCC | <1 s | 347 SCCs, 10,177 components |
| 05 partitioned (Tier 1 + Tier 2) | <1 min | 108 cycles, 20 hubs |
| 06 Johnson's full graph (max-hops 6) | **1 h 21 min** | 4,759 cycles |
| 04 matrix-power census | 4 min 52 s | 10,177 rows |
| 07 loop-financial analysis | ~1 min | refreshed 5,808 / 30,003 / 1,501 rollups |
| 02 scorer | ~4 min | 1,501 scored 0–23 (top CANADA GIVES at 23/30) |
| **Total** | **~4 h 20 min** | |

If you lower `--max-hops 5` on script 01, the total collapses to roughly
30 minutes (the 2 h 34 min 6-hop cost dominates). If you only need
ground-truth loops and don't need Johnson's cross-validation or the
matrix census, drop scripts 04 and 06 — they add another 1 h 26 min of
compute but do not change the `loops`, `loop_universe`, or `loop_*_financials` tables that the risk-report, lookup, and dossier tools
read from.

### How They Relate

- **01 (brute force)** is the ground truth. Every cycle it finds is a verified, non-redundant, temporally-constrained simple cycle. Use this for authoritative results.
- **05 (partitioned)** is the fast complement. It finds ~60% of what 01 finds in 14 seconds. The missing ~40% are cycles that route through mega-hub platforms (CanadaHelps, Watch Tower, etc.).
- **03 (SCC)** tells you the shape: one giant interconnected component (8,971 nodes, mostly JW denominational + DAF platforms) and 338 small clusters of 2-50 nodes.
- **02 (scoring)** runs after 01 completes. Reads `cra.loop_participants` to score each charity.

### Analysis Tables

All results stored in the `cra` schema (queryable by hackathon participants):

| Table | Rows | Purpose |
|-------|------|---------|
| `loop_edges` | 53,771 | Pruned gift edge graph (threshold + dead-end removal) |
| `loops` | 5,808 | Detected cycles (brute force ground truth) |
| `loop_participants` | 30,003 | Per-charity cycle membership with send/receive partners |
| `loop_universe` | 1,501 | Per-charity aggregate stats and risk scores |
| `scc_components` | 10,177 | Which SCC each charity belongs to |
| `scc_summary` | 347 | Per-SCC statistics |
| `partitioned_cycles` | 108 | Cycles from SCC-partitioned Johnson's |
| `identified_hubs` | 20 | Mega-hub platforms identified in the giant SCC |
| `johnson_cycles` | 4,601 | Johnson's algorithm results (cross-validation; simple cycles only after the 2026-04-19 fix — see `KNOWN-DATA-ISSUES.md` C-12) |
| `matrix_census` | 10,177 | Walk census results (cross-validation) |
| `loop_financials` | 5,808 | Per-loop bottleneck + flow recomputed within the loop's year window |
| `loop_edge_year_flows` | 30,003 | Per-edge gift totals restricted to each loop's year window |
| `loop_charity_financials` | 1,501 | Per-BN overhead proxy + loop-related inflow / outflow |

### CLI Options

```bash
# Brute force with custom threshold and year window
node scripts/advanced/01-detect-all-loops.js --threshold 10000 --max-hops 6 --year-window 0

# Partitioned with no hub removal (gets more cycles but slower)
node scripts/advanced/05-partitioned-cycles.js --tier2-threshold 5000 --no-hub-removal

# Johnson's capped at depth 5 (practical limit)
node scripts/advanced/06-johnson-cycles.js --max-hops 5
```

### Risk Score (0-30)

| Category | Max | Factors |
|----------|-----|---------|
| **Circular** | 6 | Reciprocal giving, multiple cycles, multi-year, large amounts, shared directors, CRA associated flag |
| **Financial** | 12 | High overhead (>40%), charity-funded (>50%), pass-through, low programs (<20%), compensation > programs, circular >> programs |
| **Temporal** | 12 | Same-year round-trips across all hop sizes (0-4), adjacent-year round-trips (0-4), persistent multi-year patterns (0-2), multi-hop temporal completion (0-2) |

Temporal scoring covers all cycle sizes (2-6 hop), not just direct 2-hop exchanges. For each cycle a charity participates in, it checks whether money sent to the next hop came back from the previous hop within the same fiscal year or N+1. This catches both direct reciprocation and multi-hop round-tripping.

### Interactive Deep Dives

```bash
# Look up a charity's full network
npm run lookup -- --name "charity name"
npm run lookup -- --bn 123456789RR0001
npm run lookup -- --name "charity name" --hops 5

# Generate a risk report for a specific charity
npm run risk -- --name "some charity"
npm run risk -- --bn 123456789RR0001
```

**Lookup** shows: outgoing/incoming gifts, reciprocal flows, 3-6 hop loops, shared directors.
Files saved: `data/reports/lookup-{BN}.json` + `lookup-{BN}.txt`

**Risk report** shows: scored risk factors, multi-year financials, same-year symmetric flows, adjacent-year round-trips, shared directors.
Files saved: `data/reports/risk-{BN}.json` + `risk-{BN}.md`

### Generated Reports (`data/reports/`)

| File | Source | Description |
|------|--------|-------------|
| `universe-scored.json` | Scoring | Full scored results for every charity |
| `universe-scored.csv` | Scoring | Flat file for analysis tools (Excel, Python, R) |
| `universe-top50.txt` | Scoring | Human-readable top 50 with all factors |
| `lookup-{BN}.*` | Lookup | Per-charity network analysis |
| `risk-{BN}.*` | Risk | Per-charity risk report with financials |

---

## Data Quality: Finding Problems in the CRA Open Data

The `scripts/data-quality/` directory contains three deterministic
checks against the published T3010 dataset. Every finding is
reproducible from the scripts and every rule is traceable to explicit
text in the CRA T3010 form or the CRA Open Data Dictionary v2.0. The
suite intentionally does **not** include threshold rules, sign rules,
or cross-field inequalities that depend on non-negativity assumptions —
see *Methodology* below for why.

### Quick Start

```bash
npm run data-quality             # runs all three data-quality checks (~2 minutes)
```

Or individually:

```bash
npm run data-quality:donees      # 01 — Gift-record BN ↔ name linkage quality (~35 s)
npm run data-quality:arithmetic  # 02 — T3010 arithmetic-identity violations (~20 s)
npm run data-quality:backfill    # 03 — Identification-table backfill check (~15 s)
```

Reports land in `data/reports/data-quality/` as Markdown + JSON. Derived
tables persist to the `cra` schema so anyone with read access can query
them directly. Script 03 uses a table that script 01 creates, so run
`:donees` before `:backfill` if you invoke them individually.

### Scripts

| # | Script | What It Answers | Persisted Table |
|---|--------|-----------------|-----------------|
| 01 | `01-donee-bn-name-mismatches.js` | How much of the \$66.9B in charity-to-charity gifts cannot be programmatically joined from `cra_qualified_donees` to `cra_identification`? Includes MALFORMED_BN defect taxonomy (BN format violations — the only format-rule impossibility), UNREGISTERED_BN list, and per-year single-filer case studies (e.g. the Calgary Foundation's `"Sec. 149.1(1)"` BN use in FY 2020 and FY 2022). | `cra.donee_name_quality` |
| 02 | `02-t3010-arithmetic-impossibilities.js` | How many T3010 financial filings violate one of **ten** structural rules stated directly in the T3010 form or the CRA Open Data Dictionary v2.0? Covers the expenditure tree (IDENTITY_5100, PARTITION_4950), the balance sheet (IDENTITY_4200, IDENTITY_4350), cross-schedule equalities that the dictionary says "must be pre-populated" (COMP_4880_EQ_390, DQ_845/850/855_EQ_5000/5045/5050), and Schedule 3 dependencies (SCH3_DEP_FORWARD, SCH3_DEP_REVERSE). | `cra.t3010_arithmetic_violations` |
| 03 | `03-identification-backfill-check.js` | Does `cra_identification` preserve historical legal names across years? Spot-checks seven well-known rebrands by BN and measures how much of the NAME_MISMATCH \$ would be rescuable if historical names were preserved. | `cra.identification_name_history` |

### Methodology — what we flag and what we do NOT flag

Every rule in this suite must be traceable to an observable fact in one
of three published sources:

1. The CRA T3010 Registered Charity Information Return itself
   (`docs/guides-forms/T3010.md` and `docs/guides-forms/codes_en.pdf`).
2. The CRA Open Data Dictionary v2.0
   (`docs/guides-forms/OPEN-DATA-DICTIONARY-V2.0 ENG.md`).
3. The ingested dataset as loaded into the `cra` schema.

**The suite flags:**

- Direct arithmetic identities printed on the T3010 form (the form
  *defines* field_5100 as a sum of three specific lines — a filing
  where the reported total contradicts that definition is
  inconsistent on its face).
- Direct partition relationships stated with form text like "Of the
  amount at line X" (sub-lines so designated cannot, together, exceed
  the parent line).
- BN format violations against CRA's 15-character business-number
  format `^[0-9]{9}RR[0-9]{4}$`.
- Observable coverage facts about the published dataset (e.g. how many
  BNs in `cra_identification` show any `legal_name` variation across
  the fiscal years loaded).

**The suite deliberately does NOT flag:**

- **Magnitude thresholds.** The T3010 imposes no bound on any
  financial field. Large legitimate filings (provincial health
  authorities, school boards) cross any threshold a third-party
  analyst might pick. Known typos such as FINCA CANADA FY 2023
  (\$222B compensation on \$1.8M revenue) are still caught here
  *because they violate the IDENTITY_5100 arithmetic identity*, not
  because of their magnitude.
- **Sign rules.** The T3010 form explicitly instructs filers to
  "show a negative amount with brackets" on field_4600 (Net proceeds
  from disposition of assets), and the CRA Open Data Dictionary v2.0
  records that every financial field in the extract has a length of
  14 "including one digit reserved for a potential negative sign."
  Sophisticated foundations (Mastercard Foundation, Azrieli
  Foundation, The Winnipeg Foundation, Fondation Lucie et André
  Chagnon, and many others) have legitimately reported negative
  field_4700 (total revenue) in years with investment losses. These
  filings reconcile correctly and are not data errors.
- **Cross-field inequalities that depend on non-negativity.** Rules
  like "compensation must not exceed total expenditures" or "gifts
  to qualified donees must not exceed total expenditures" are
  derivable from the form's arithmetic *only* if one assumes every
  expenditure sub-line is non-negative. The form text does not say
  that. We therefore do not claim those as impossibilities.
- **Plausibility flags.** "Total expenditures > revenue + total
  assets", "expenditure-to-revenue ratio > 100×", and similar
  cross-section ratios are not in the form text and have plausible
  legitimate explanations (a foundation drawing from a large
  endowment, a charity that has taken on debt). They are out of
  scope for this suite.

The goal of this discipline is that every claim in a generated
report survives a hostile read by a reviewer who has the T3010 form
and the data dictionary in front of them.

### Insights You Will Find When You Run These

#### From `01-donee-bn-name-mismatches.js`

* **\$8.97 billion (13.4%) of charity-to-charity gift dollars** over
  2020–2024 cannot be joined programmatically from `cra_qualified_donees`
  to `cra_identification` on the stated BN. The report splits this into
  four categories: PLACEHOLDER_BN, **MALFORMED_BN** (format violations),
  **UNREGISTERED_BN** (well-formed BNs not in the identification table),
  and NAME_MISMATCH (valid BNs whose donee_name doesn't match the
  canonical legal name).
* **\$1.95 billion of that sits under BNs that fail CRA's own 15-character
  format** (`^[0-9]{9}RR[0-9]{4}$`) — the only format-rule
  impossibility. The report includes a full **defect taxonomy** (embedded
  space, RC/RP/RT payroll-program codes where registered-charity codes
  belong, missing RR suffix, single R, truncated suffix, non-numeric BN)
  with three worked examples per defect class so the exact row, filer,
  and dollar amount are visible.
* **The "Toronto" single-filer case study**: Jewish Foundation of Greater
  Toronto's FY 2023 return lists `donee_bn = 'Toronto'` on all 434 of
  its Schedule 5 line items, totalling \$42,953,866. The single largest
  line (\$22,576,875) is to the United Jewish Appeal of Greater Toronto.
  This appears as a dedicated section in the report with per-year
  record counts for every filer who used the same malformed BN on 20+
  records.
* **Well-known registered charities absent from the identification
  roster** (UNREGISTERED_BN bucket — not an impossibility, just a
  factual count of failed joins): Sunnybrook Health Sciences Centre,
  BC Cancer Agency (under three different spellings), Hockey Canada,
  University of Ottawa Heart Institute, CancerCare Manitoba, PEI's
  Queen Elizabeth Hospital.

#### From `02-t3010-arithmetic-impossibilities.js`

The script runs **10 rules** across four families. Every rule is
traced to a specific line number in the T3010 form or the CRA Open
Data Dictionary v2.0 — the suite never claims a rule that isn't
printed in CRA's own documentation.

**Expenditure-tree identities:**

* **IDENTITY_5100** — the T3010 form defines `field_5100` as
  *"Total expenditures (add lines 4950, 5045 and 5050)"* (form line
  657). Any filing where the reported `field_5100` does not equal
  the sum of its three components (within \$1 rounding tolerance) is
  inconsistent with the form's own definition. FINCA CANADA FY 2023
  is caught here — its reported \$222B expenditures cannot be
  reconciled to the sum of its components.
* **PARTITION_4950** — the form groups fields 5000, 5010, 5020, and
  5040 under the heading *"Of the amounts at lines 4950"* (form
  line 644), explicitly designating each as a subset of field_4950.
  Their sum therefore cannot exceed field_4950.

**Balance-sheet identities** (strict: only fires when both the total
AND at least one component field are populated in the extract, so
Section D filers who report only the total are not miscounted):

* **IDENTITY_4200** — `field_4200` (total assets) must equal the sum
  of asset lines 4100, 4110, 4120, 4130, 4140, 4150, 4155, 4160,
  4165, 4166, 4170, plus 4180 (pre-v27) or 4190 (v27+). Form line
  584: *"Total assets (add lines 4100, 4110 to 4155, and 4160 to
  4170)"*.
* **IDENTITY_4350** — `field_4350` (total liabilities) must equal
  `field_4300 + 4310 + 4320 + 4330`. Form line 572: *"Total
  liabilities (add lines 4300 to 4330)"*.

**Cross-schedule equalities** — these are constraints the CRA Open
Data Dictionary v2.0 literally says "must be pre-populated":

* **COMP_4880_EQ_390** — Schedule 6 `field_4880` must equal Schedule
  3 `field_390`. Form line 631: *"Total expenditure on all
  compensation (enter the amount reported at line 390 in Schedule 3,
  if applicable) — 4880"*.
* **DQ_845_EQ_5000** — Schedule 8 line 845 must equal Schedule 6
  `field_5000`. Dictionary line 1023: *"Must be pre-populated with
  the amount from line 5000 from Schedule 6 of this return"*.
* **DQ_850_EQ_5045** — Schedule 8 line 850 must equal Schedule 6
  `field_5045`. Dictionary line 1024.
* **DQ_855_EQ_5050** — Schedule 8 line 855 must equal Schedule 6
  `field_5050`. Dictionary line 1025.

**Schedule dependencies** — the form's own "If yes" logic:

* **SCH3_DEP_FORWARD** — if `field_3400` (C9) = TRUE, a Schedule 3
  row must exist in `cra_compensation`. Form line 133: *"Did the
  charity incur any expenses for compensation of employees during
  the fiscal period? ... Important: If yes, you must complete
  Schedule 3, Compensation."*
* **SCH3_DEP_REVERSE** — if a Schedule 3 row exists, `field_3400`
  (C9) must = TRUE. Form line 467 (Schedule 3 instructions): *"If
  you complete this section, you must answer yes to question C9."*

Every violation in the report surfaces the filer's BN, the fiscal
year, the legal name as filed, and the plain-English description of
the violation citing the specific form line or dictionary entry.

#### From `03-identification-backfill-check.js`

This script reports observable coverage facts, not impossibilities:

* **Only ~0.86% of BNs** (~784 of 91,129) show any `legal_name` variation
  at all across five years of filings — implausibly low in a sector
  that rebrands routinely. CRA has overwritten the current legal name
  onto every historical row.
* **Seven well-known rebrands** are spot-checked by BN (Ryerson → TMU,
  Grey Bruce → BrightShores, Calgary Zoo Foundation → Wilder Institute,
  Markham Stouffville → Oak Valley, Toronto General & Western → UHN
  Foundation, St. Michael's → Unity Health Toronto, JHF → Moral Arc).
  For six of the seven, the pre-rebrand name is not recoverable
  anywhere in `cra_identification`. Donors who wrote the old name on
  a 2021 gift record cannot be matched to the charity's current BN
  through the identification table.
* The report also computes how much of the NAME_MISMATCH dollar total
  from script 01 would be "rescuable" by a historical-name join if
  CRA had preserved the history. The answer — small, because the
  history isn't preserved — is itself the finding.

### Why These Matter

CRA's charitable-sector oversight framework rests on the T3010 data
being accurate and linkable:

- **Disbursement quota compliance** under *Income Tax Act* s. 149.1
  requires that qualifying disbursements actually reached qualified
  donees. The audit trail is the donee_bn on each gift. When the BN
  does not resolve, the compliance check cannot be mechanically
  performed.
- **Financial disclosure** assumes the arithmetic on each return is
  internally consistent. IDENTITY_5100, PARTITION_4950, IDENTITY_4200,
  IDENTITY_4350, and the four cross-schedule equality rules all
  measure cases where published totals contradict the components the
  same filing reports.
- **Schedule dependencies** are stated on the form itself. C9 ↔
  Schedule 3 is bi-directional in the form text; violations in
  either direction are structural form errors.
- **Public understanding** of charitable-sector dollar flows depends
  on the data being joinable. When \$9 billion of gifts can't be
  traced donor-to-recipient, and \$2 billion of that sits under BNs
  that don't pass a one-line regex, the dataset is not fit for the
  oversight purpose CRA publishes it for.

**The scripts make no accusations.** They measure the gap between what
the T3010 framework assumes about its data and what the published
dataset actually delivers. Closing the gap is mechanical: input
validation at filing time, no-backfill publication of legal-name
history, arithmetic checks against the form's own definitions,
structural BN format validation. Every fix is deterministic; none
requires sector judgement.

See `scripts/data-quality/README.md` for full methodology
documentation, the persisted-table schema, and instructions for
adding new rules. New rules are welcome provided they meet the
methodology standard: every rule must be traceable to explicit text
in the T3010 form or the CRA Open Data Dictionary v2.0.

### Independent Verification (pre-validated exemplars)

Every violation the pipeline surfaces is reproducible against
independent third-party sources that scrape the same CRA Open Data
this repo ingests. The table below lists three violations that have
been pre-validated against `charitydata.ca` — every field matches to
the dollar. A reviewer can reproduce any of them in under two minutes.

| Rule | Charity | BN | FY | What's wrong | 3rd-party verification |
|---|---|---|---|---|---|
| `IDENTITY_5100` | **CENTREVILLE PRESBYTERIAN CHURCH** | `129955928RR0001` | **2024** | `field_4950` reported as **\$5,204,352,043** (\$5.2 billion) on a rural Ontario church whose revenue is \$62K and reasonable total expenditures are \$54,543. Five-orders-of-magnitude typo on one line. | [charitydata.ca](https://www.charitydata.ca/charity/centreville-presbyterian-church/129955928RR0001/) |
| `COMP_4880_EQ_390` | **FRASER HEALTH AUTHORITY** | `887612463RR0001` | **2020** | Schedule 6 `field_4880` = **\$2,008,634,000** but Schedule 3 `field_390` = **\$2,008,634**. Same digits, exactly 1000× ratio — one side in dollars, one in thousands. Form says they must match. | [charitydata.ca](https://www.charitydata.ca/charity/fraser-health-authority/887612463RR0001/) |
| `IDENTITY_5100` | **MSC CANADA** | `119042489RR0001` | **2021** | `field_4950 = $147,218,191` but the sum of its own 12 operating sub-lines (4800–4920) is \$15,647,885. Reported 5100 = \$19.6M (consistent with sub-lines). 4950 is ~9.4× the real value. | [charitydata.ca](https://www.charitydata.ca/charity/msc-canada/119042489RR0001/) |

**Reviewer recipe** (under 2 minutes per charity):

1. Open the `charitydata.ca` URL above.
2. Scroll to the fiscal year in question.
3. Compare the T3010 line values in the third-party view against the
   "Supporting detail" column in
   `data/reports/data-quality/t3010-arithmetic-impossibilities.md`.
4. Confirm the contradiction against the form text quoted in the
   rule's citation (also in the report).

If any value in our report differs from the third-party source, that
is a data-ingestion bug worth filing. **We have not found one.** If any
value matches but the rule still fires, the filing genuinely violates
the T3010 form's own arithmetic — which is the claim we make.

### Running the full pipeline from a clean clone

```bash
git clone <this-repo>
cd hackathon/CRA
npm install                      # Node 18+ required
# .env.public ships with read-only credentials for the Render-hosted
# database, so no manual configuration is required to run the
# data-quality scripts. They will connect and read from the cra schema.

npm run data-quality             # ~2 minutes; runs all three scripts in order
```

On completion you will have:

| File | What's in it |
|---|---|
| `data/reports/data-quality/donee-bn-name-mismatches.md` | $8.97B un-joinable gifts across four categories; malformed-BN defect taxonomy; case studies including the 434 `Toronto`-BN Jewish Foundation filing and the Calgary Foundation FY 2020 + FY 2022 `Sec. 149.1(1)` pattern |
| `data/reports/data-quality/t3010-arithmetic-impossibilities.md` | 10 rules × their form/dictionary citations; **30,856 distinct BNs** flagged; top-20 violators per rule with full BN + FY + legal name + field values |
| `data/reports/data-quality/identification-backfill-check.md` | Only 0.86% of BNs have any legal-name variation across 2020–2024; 6 of 7 spot-checked rebrands have the pre-rebrand name completely erased from `cra_identification` |

Each report's JSON counterpart (`.json`) is identical content in
structured form for downstream tooling. Each derived table persists to
the `cra` schema (`cra.donee_name_quality`,
`cra.t3010_arithmetic_violations`, `cra.identification_name_history`)
so anyone with read-only access can query them directly without
rerunning the scripts.

### Headline numbers (from the latest run of this pipeline)

| | |
|---|---:|
| Total gift records analysed                                  | **1,664,343** |
| Gift dollars analysed                                        | **\$66.88B** |
| Gift records flagged (PLACEHOLDER / MALFORMED / UNREGISTERED / NAME_MISMATCH) | **260,102** |
| Dollars on flagged records                                   | **\$8.97B** (13.41% of all gifts) |
| Of which `MALFORMED_BN` (BN format violations)               | \$1.95B |
| Total T3010 arithmetic-identity violations (10 rules)        | **54,010** rows |
| Distinct BNs with ≥ 1 arithmetic violation                   | **30,856** |
| BNs in `cra_identification` showing any name variation across 5 years | **0.86%** (784 / 91,129) |
| Known rebrands where pre-rebrand name is still recoverable   | **1 of 7 spot-checks** |

---

## AI Agent Integration

This project includes a `CLAUDE.md` file and skill definitions in `.claude/skills/` that enable AI coding agents (Claude Code, Copilot, etc.) to perform deep analytical profiling on the dataset.

### Available Skills

| Skill | File | What It Does |
|-------|------|-------------|
| **Profile Charity** | `.claude/skills/profile-charity.md` | Full profiling workflow: risk score, network, year-by-year flows, charity type assessment |
| **Detect Circular Patterns** | `.claude/skills/detect-circular-patterns.md` | Run and interpret the full analysis pipeline |
| **Compare Charities** | `.claude/skills/compare-charities.md` | Side-by-side financial and risk comparison |
| **Analyze Network** | `.claude/skills/analyze-network.md` | Map gift-flow network, identify clusters and hubs |
| **Temporal Flow Analysis** | `.claude/skills/temporal-flow-analysis.md` | Same-year and adjacent-year symmetric flow analysis |

### Using with an AI Agent

Open the project in Claude Code or any agent-enabled IDE. The agent will read `CLAUDE.md` for context and can follow the skill workflows to profile charities, interpret scoring, and produce evidence-backed findings. Example prompts:

- "Profile the charity with BN 123456789RR0001"
- "Run the circular pattern detection and show me the top results"
- "Compare these three charities on financial metrics and circular risk"
- "Analyze the gift network around this charity"
- "Show me the year-by-year timing of flows between these two charities"

The `CLAUDE.md` also documents the complete analytical methodology developed during the original analysis, including the five-phase approach (identify universe, triage by charity type, deep dive, temporal analysis, contextual validation).

---

## Design Decisions

| Decision | Rationale |
|----------|-----------|
| **Node.js only** | Matches existing codebase; single language for entire pipeline |
| **No ORM** | Direct SQL for transparency; hackathon participants can read every query |
| **Local JSON cache** | Avoids repeated API calls; enables offline re-import |
| **Batch INSERT (1,000 rows)** | Balances throughput vs. query size limits over network to Render |
| **ON CONFLICT DO NOTHING** | Idempotent imports - safe to re-run without duplicates |
| **Additive schema** | Union of all form versions; NULL for fields not in a given version |
| **fiscal_year on identification** | API identification data has no FPE; fiscal_year enables multi-year |
| **snake_case table names** | Industry standard; matches Phase 3 visualization schema |
| **DECIMAL(18,2)** | Financial fields need precision to handle outlier values |
| **Consolidated migration** | Single `01-migrate.js` creates everything including analysis tables |
| **Unified API pipeline** | All 5 years (including 2024) load through the same API pathway |

---

## Testing

```bash
npm run test:unit           # Unit tests (no database needed)
npm run test:integration    # Schema + data verification (requires database)
npm run verify              # 195 verification checks across all years
```

---

## Troubleshooting

| Issue | Solution |
|-------|----------|
| API timeout during fetch | Cached data preserved; re-run `npm run fetch` to resume |
| Import fails midway | Re-run the import - idempotent, skips existing rows |
| Missing 2024 data | This is partial-year data; not all charities have filed yet |
| Schema mismatch | Run `npm run migrate` to bring schema up to date |
| Permission denied on queries | You're using the read-only account; this is expected for INSERT/UPDATE/DELETE |
| Need to rotate credentials | Admin runs `npm run readonly:revoke && npm run readonly:create` |
| No DB_CONNECTION_STRING | Copy `.env.example` to `.env` (admin) or use `.env.public` (read-only) |

---

## Bibliography and References

### Primary Sources

- **CRA T3010 Form**: [canada.ca/t3010](https://www.canada.ca/en/revenue-agency/services/forms-publications/forms/t3010.html) - The official registered charity information return
- **T4033 Guide**: [Completing the T3010](https://www.canada.ca/en/revenue-agency/services/forms-publications/publications/t4033/t4033-completing-registered-charity-information-return.html) - Line-by-line instructions for every field in the T3010
- **Government of Canada Open Data Portal**: [open.canada.ca](https://open.canada.ca) - Public API for charity data (CKAN datastore)
- **CRA Open Data Data Dictionary**: [PDF](https://www.canadiancharitylaw.ca/wp-content/uploads/2025/02/CRA-open-data-data-dictionary-for-T3010.pdf) - Official field descriptions for open data release

### T3010 Version 24 (2024 Form Revision)

- **Charity Law Group**: [Form T3010 New Version](https://www.charitylawgroup.ca/charity-law-questions/form-t3010-new-version-in-january-2024) - Summary of January 2024 changes
- **CCCC**: [New T3010 for January 2024](https://www.cccc.org/news_blogs/legal/2024/01/15/new-t3010-for-january-2024/) - Detailed field-by-field analysis
- **CanadianCharityLaw.ca**: [Questions Added or Removed](https://www.canadiancharitylaw.ca/blog/more-information-on-questions-that-will-be-added-or-removed-from-the-t3010-version-24/) - Specific line number changes
- **Miller Thomson**: [What Charities Need to Know](https://www.millerthomson.com/en/insights/social-impact/new-t3010-annual-information-return-charities/) - Legal analysis of form changes
- **Carters**: [Charity Law Bulletin #525](https://www.carters.ca/pub/bulletin/charity/2024/chylb525.pdf) - Comprehensive legal bulletin
- **Carters**: [Understanding New Changes](https://www.carters.ca/pub/seminar/charity/2024/C&NFP/Understanding-New-Changes-to-the-T3010-Charity-Return-TMan-2024-11-12.pdf) - Presentation on T3010 changes
- **CRA Filing Requirements**: [When to File](https://www.canada.ca/en/revenue-agency/services/charities-giving/charities/operating-a-registered-charity/filing-t3010-charity-return/when-file.html) - 6-month deadline after fiscal year end

### Data Analysis References

- **CharityData.ca**: [charitydata.ca](https://www.charitydata.ca) - Interactive T3010 data explorer with field-level CRA guide links
- **CanadianCharityLaw.ca**: [T3010 Line Number Changes](https://www.canadiancharitylaw.ca/blog/detailed-information-on-changes-to-the-t3010-line-numbers-from-cra-for-registered-charities-and-cra-data-dictionary/) - Historical field evolution
- **CharityData.ca T3010 v24 Updates**: [Major Updates](https://www.canadiancharitylaw.ca/blog/major-updates-to-charitydata-ca-to-incorporate-new-questions-in-t3010-version-24/) - How CharityData.ca adapted to form changes
- **Open Data Impact**: [Opening Canada's T3010 Data](https://odimpact.org/case-opening-canadas-t3010-charity-information-return-data.html) - Case study on T3010 open data impact
- **IJF Methodology**: [Charities Databases](https://theijf.org/charities-databases-methodology) - Investigative Journalism Foundation's approach to CRA data

---

## Data Licensing

- **Code**: MIT License (Government of Alberta - Pronghorn Red Team)
- **Data**: [Open Government Licence - Canada](https://open.canada.ca/en/open-government-licence-canada)
