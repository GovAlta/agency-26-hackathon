# Federal Grants and Contributions Data Pipeline

**AI For Accountability Hackathon** - Federal Grants & Contributions dataset from the Government of Canada Open Data Portal.

## Overview

This pipeline downloads, loads, verifies, and analyzes the **Proactive Publication - Grants and Contributions** dataset. The database contains **1,275,521 records** of federal government grants, contributions, and other transfer payments across **51 departments**, **422K unique recipients**, and **9,311 programs**.

- **Source**: [Government of Canada Open Data Portal](https://open.canada.ca)
- **Resource ID**: `1d15a62f-5656-49ad-8c88-f40ce689d831`
- **Schema**: `fed` (companion to `cra` schema for CRA charity data)

## Quick Start

```bash
# Install dependencies
npm install

# Full pipeline (migrate -> seed -> fetch -> import -> fix-quality -> verify).
# Run steps in this order — fix-quality populates the `is_amendment` flag
# used by the analytical views declared in migrate (defaults to false on a
# fresh install, then updated from `amendment_number` during fix-quality).
npm run setup

# Run all advanced analysis
npm run analyze:all
```

## Project Structure

```
FED/
├── .claude/                    # Claude Code skills
│   └── skills/                     # 5 interactive analysis skills
│       ├── provincial-briefing/    # /provincial-briefing AB
│       ├── recipient-profile/      # /recipient-profile NextStar
│       ├── risk-assessment/        # /risk-assessment top 20
│       ├── program-analysis/       # /program-analysis innovation
│       └── department-audit/       # /department-audit Health Canada
├── config/                     # Dataset configuration
│   ├── dataset-inventory.json      # UUID registry
│   └── datasets.js                 # Runtime config
├── lib/                        # Shared libraries
│   ├── db.js                       # PostgreSQL pool (fed schema)
│   ├── api-client.js               # Open Data API client (batch-file)
│   ├── transformers.js             # Type converters + SQL helpers
│   └── logger.js                   # Timestamped logging
├── scripts/                    # Pipeline scripts
│   ├── 01-migrate.js               # Schema + table creation
│   ├── 02-seed-reference.js        # Lookup table population
│   ├── 03-fetch-data.js            # API download (128 batch files)
│   ├── 04-import-data.js           # Database import
│   ├── 05-verify.js                # Verification & balance
│   ├── 06-fix-quality.js           # Normalize types, provinces, add is_amendment
│   ├── run-dashboard.js            # Summary queries for dashboarding
│   ├── drop-tables.js              # Drop all fed tables
│   ├── clear-cache.js              # Clear downloaded data
│   └── advanced/                   # Advanced analysis scripts
│       ├── 01-provincial-equity.js     # Per-capita provincial analysis
│       ├── 02-for-profit-deep-dive.js  # For-profit recipient analysis
│       ├── 03-amendment-creep.js       # Amendment pattern detection
│       ├── 04-recipient-concentration.js # Vendor concentration (HHI)
│       ├── 05-zombie-and-ghost.js      # Zombie & ghost capacity
│       ├── 06-entity-export.js         # Export for external research
│       ├── 07-risk-register.js         # 7-dimension risk scoring
│       └── 08-individual-recipients.js # Individual grant analysis
├── data/
│   ├── cache/                  # Downloaded batch files (gitignored)
│   └── reports/                # Analysis outputs (JSON/CSV/TXT)
├── docs/
│   ├── DATA_DICTIONARY.md          # Complete field reference
│   └── SAMPLE_QUERIES.sql          # 35+ ready-to-run queries
├── reference/                  # Government reference files
│   ├── data-schema.json            # Official schema with value lists
│   └── data-dictionary.xlsx        # Official data dictionary
├── tests/                      # 18 unit + 8 integration tests
├── legacy/                     # Original Phase 1 scripts (reference)
├── CLAUDE.md                   # Agent guide with skills reference
├── .env                        # Admin DB credentials (gitignored)
├── .env.public                 # Read-only DB credentials
└── .env.example                # Template
```

## npm Scripts

### Data Pipeline

| Script | Description |
|--------|-------------|
| `npm run migrate` | Create schema, tables, indexes, views |
| `npm run seed` | Populate lookup tables from data-schema.json |
| `npm run fetch` | Download 1.275M records (128 batches, resumable) |
| `npm run import` | Load cached data into PostgreSQL |
| `npm run fix-quality` | Normalize agreement types, provinces, add is_amendment |
| `npm run verify` | Verify completeness (15/15 checks, balanced) |
| `npm run setup` | Full pipeline (all above) |
| `npm run reset` | Drop + full setup |

### Analysis & Dashboards

| Script | Description |
|--------|-------------|
| `npm run dashboard` | Run summary queries -> data/reports/dashboard.json |
| `npm run analyze:equity` | Per-capita provincial funding analysis |
| `npm run analyze:forprofit` | For-profit recipient deep dive |
| `npm run analyze:amendments` | Amendment creep detection |
| `npm run analyze:concentration` | Vendor/recipient concentration (HHI) |
| `npm run analyze:zombies` | Zombie recipients & ghost capacity |
| `npm run analyze:export` | Entity export for external research (CSV) |
| `npm run analyze:risk` | Comprehensive 7-dimension risk register |
| `npm run analyze:individuals` | Individual grant recipients analysis |
| `npm run analyze:all` | Run all 8 advanced scripts |

### Utilities

| Script | Description |
|--------|-------------|
| `npm run drop` | Drop all fed tables (destructive!) |
| `npm run clear-cache` | Delete cached batch files |
| `npm run test:unit` | Run 18 unit tests |
| `npm run test:integration` | Run 8 integration tests |

## Database Schema

All tables in the `fed` schema:

- **`fed.grants_contributions`** - Main data (1.275M rows, 40 columns)
- **`fed.agreement_type_lookup`** - G=Grant, C=Contribution, O=Other
- **`fed.recipient_type_lookup`** - 8 recipient categories (F/N/G/A/P/S/I/O)
- **`fed.country_lookup`** - 250 ISO country codes
- **`fed.province_lookup`** - 13 provinces/territories
- **`fed.currency_lookup`** - 94 ISO currency codes
- **`fed.vw_grants_decoded`** - Grants with decoded lookup values
- **`fed.vw_grants_by_department`** - Summary by department
- **`fed.vw_grants_by_province`** - Summary by province

## Risk Register

The risk register (`npm run analyze:risk`) scores **109,795 non-government entities** across 7 dimensions (0-35 scale):

| Dimension | What it measures |
|-----------|-----------------|
| **Cessation** (0-5) | No new grants in recent years |
| **Identity** (0-5) | No business number, weak identity |
| **Amendment** (0-5) | High amendment rate, value growth |
| **Concentration** (0-5) | Dominates programs, single-dept |
| **Dependency** (0-5) | Very few grants, single source |
| **Opacity** (0-5) | Missing descriptions, results |
| **Scale** (0-5) | Outsized single grants |

Results: **846 CRITICAL** (>=15) | **6,931 HIGH** (10-14) | **9,459 MEDIUM** (6-9)

## Claude Skills

Interactive analysis skills (invoke with `/skill-name argument`):

| Skill | Usage | Description |
|-------|-------|-------------|
| `/provincial-briefing` | `/provincial-briefing AB` | Provincial funding briefing with per-capita |
| `/recipient-profile` | `/recipient-profile NextStar` | Deep profile of a grant recipient |
| `/risk-assessment` | `/risk-assessment top 20` | Risk factor analysis |
| `/program-analysis` | `/program-analysis innovation` | Federal program analysis |
| `/department-audit` | `/department-audit Health` | Department audit |

## Hackathon Challenges Supported

| # | Challenge | Scripts |
|---|-----------|---------|
| 1 | Zombie Recipients | `analyze:zombies`, `analyze:risk` |
| 2 | Ghost Capacity | `analyze:zombies`, `analyze:forprofit` |
| 4 | Amendment Creep | `analyze:amendments`, `analyze:risk` |
| 5 | Vendor Concentration | `analyze:concentration` |
| 7 | Policy Misalignment | `analyze:equity` |
| 8 | Duplicative Funding | `analyze:concentration`, `analyze:equity` |
| 9 | Contract Intelligence | `analyze:amendments`, `dashboard` |
| 10 | Adverse Media | `analyze:export` (CSV for external lookups) |
