# Local Database Recreation Kit

This directory contains everything needed to recreate the AI For Accountability hackathon database in your own PostgreSQL instance.

## Contents

```
.local-db/
├── README.md                # This file
├── export.js                # Export script (maintainers regenerating the dataset)
├── import.js                # Import script (participants setting up locally)
├── manifest.json            # Table inventory with row counts
├── schemas/                 # DDL, split into pre-data and post-data per schema
│   ├── cra.sql              # pre-data: CREATE SCHEMA, SEQUENCES, TABLES (with
│   ├── fed.sql              #   nextval defaults), INDEXES, VIEWS
│   ├── ab.sql
│   ├── general.sql
│   ├── cra_post.sql         # post-data: UNIQUE/CHECK/FOREIGN KEY constraints
│   ├── fed_post.sql         #   and SELECT setval(...) to sync sequences with
│   ├── ab_post.sql          #   loaded row counts
│   └── general_post.sql
└── data/                    # JSON Lines data files (one per table, one row
    ├── cra/                 #   per line, keyed by column name). JSONL was
    ├── fed/                 #   chosen over CSV because jsonb, text[], nulls,
    ├── ab/                  #   and strings with embedded newlines/commas/
    └── general/             #   quotes all round-trip without escaping games.
```

The split into `{schema}.sql` + `{schema}_post.sql` exists so foreign keys and
unique constraints don't block data loading, and so sequences end up pointing
at `MAX(id) + 1` after the JSONL files are ingested. Apply them in that order.

## Quick Start

### Prerequisites

- **PostgreSQL 14+** running locally or on a server you control.
- **Node.js 18+**.
- A database user with:
  - `CREATE` on the database (to create schemas, tables, sequences, functions, views).
  - `INSERT` on the tables being populated.
  - Privilege to `CREATE EXTENSION pg_trgm` and `CREATE EXTENSION fuzzystrmatch`. On most managed Postgres services (Render, RDS, Cloud SQL, Supabase) these are on the default allow-list; on self-hosted Postgres you need superuser — or ask a DBA to run the two `CREATE EXTENSION` statements once, then a regular user can finish the import.

### Data bundle

The `.local-db/data/` directory (JSONL files, ~13 GB total) is not in the repo. Download the data bundle separately and extract it under `.local-db/data/` so the directory structure matches `data/{cra,fed,ab,general}/*.jsonl`.

### Expected import time

A full load is ~23 M rows and batches INSERTs over the network. Plan for:

- **~20–30 min** on a local Postgres (loopback).
- **~1–3 hours** over a typical residential/office link to a remote Postgres. `fed.grants_contributions` alone (1.3 M rows × ~2 KB per row) dominates the total.

Lower `--batch-size` if you hit memory pressure; it won't speed things up but it reduces per-statement RAM use.

### 1. Create a database

```sql
CREATE DATABASE hackathon;
```

### 2. Install dependencies

```bash
cd .local-db
npm install
```

### 3. Set your connection string

Create a `.env` file in this directory:

```
DB_CONNECTION_STRING=postgresql://your_user:your_password@localhost:5432/hackathon
```

### 4. Run the import

```bash
# Full import (DDL + data for all 4 schemas)
npm run import

# Import just one schema
node import.js --schema cra

# Import DDL only (no data)
node import.js --schema-only

# Drop and recreate (if re-importing)
node import.js --drop
```

The import creates all schemas, tables, indexes, and views, then loads the JSONL data using batch INSERTs with `ON CONFLICT DO NOTHING` for idempotency. After each schema's data is loaded it applies the matching `_post.sql` for UNIQUE/CHECK/FK constraints and sequence `setval()`.

### 5. Verify

After import, the script runs automatic row-count verification against the manifest. You can also verify manually:

```sql
SELECT schemaname, COUNT(*) AS tables
FROM pg_tables
WHERE schemaname IN ('cra', 'fed', 'ab', 'general')
GROUP BY schemaname ORDER BY schemaname;
```

## Alternative: psql bulk DDL (data still goes through import.js)

`psql` can apply the SQL files directly; the JSONL data is loaded through
`import.js` because `\copy` doesn't understand JSONL:

```bash
# 1. Apply pre-data DDL
for schema in cra fed ab general; do
  psql -d hackathon -f "schemas/${schema}.sql"
done

# 2. Load data via import.js (skips DDL since it's already applied)
node import.js --data-only

# 3. Apply post-data DDL
for schema in cra fed ab general; do
  psql -d hackathon -f "schemas/${schema}_post.sql"
done
```

## Dataset Summary

| Schema | Tables + views | Approx rows | Description |
|--------|----------------|-------------|-------------|
| `cra` | 49 tables + 3 views | ~8.76M | CRA T3010 charity filings (2020-2024), plus accountability-analysis tables (loop detection, SCC decomposition, overhead/government-funding rollups, T3010 violation flags, donee-quality scoring) |
| `fed` | 6 tables + 3 views | ~1.28M | Federal grants and contributions |
| `ab` | 9 tables + 3 views | ~2.61M | Alberta grants, contracts, sole-source, non-profit registry |
| `general` | 14 tables + 2 views | ~10.46M | **Cross-dataset entity resolution pipeline output**, including `entities` (golden records), `entity_source_links`, `entity_golden_records` (final compiled table), `entity_merge_candidates`, `entity_merges`, `entity_resolution_log`, `ministries`/`ministries_crosswalk`/`ministries_history`, and the Splink probabilistic-matching tables (`splink_predictions`, `splink_aliases`, `splink_build_metadata`). See `/general/README.md` for the full pipeline. |

Both `export.js` and `import.js` auto-discover tables via `information_schema` — no code change is needed when new tables are added to any schema. A re-run regenerates the manifest, DDL files, and JSONL data automatically. The export also captures sequences (with `nextval(...)` defaults preserved), all PRIMARY KEY / UNIQUE / CHECK / FOREIGN KEY constraints, and sequence `setval()` statements so the recreated database is a faithful clone.

## Import Options

| Flag | Description |
|------|-------------|
| `--schema cra` | Import only one schema |
| `--schema-only` | Apply DDL without loading data |
| `--data-only` | Load data only (tables must already exist) |
| `--batch-size 5000` | Rows per INSERT (default: 5000, lower = less memory) |
| `--drop` | Drop and recreate schemas before import (destructive) |

## Re-exporting (for maintainers)

To regenerate the export from the live database:

```bash
DB_CONNECTION_STRING=postgresql://admin:pass@host:5432/db npm run export
```

This overwrites `schemas/`, `data/` (JSONL files), and `manifest.json` with fresh data.

## Data Licensing

- **Code**: MIT License (Government of Alberta)
- **CRA Data**: [Open Government Licence - Canada](https://open.canada.ca/en/open-government-licence-canada)
- **Federal Data**: [Open Government Licence - Canada](https://open.canada.ca/en/open-government-licence-canada)
- **Alberta Data**: [Open Government Licence - Alberta](https://open.alberta.ca/licence)
