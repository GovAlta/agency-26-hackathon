# CLAUDE.md - Agent Guide for CRA T3010 Charity Data Analysis

This file provides context and skills for AI agents (Claude Code, Copilot, etc.) working with the CRA T3010 charity accountability dataset.

## Project Overview

This is a hackathon package containing 5 years (2020-2024) of CRA T3010 charity disclosure data loaded into PostgreSQL (~7.3M raw T3010 rows + ~1.3M pre-computed analysis rows = ~8.6M total, across 46 tables + 3 views: 6 lookup, 19 raw-data, 21 analysis). It includes a deterministic analysis pipeline for detecting circular gifting patterns and scoring accountability risk.

## Key Commands

```bash
# Data pipeline
npm run setup              # Full data load (migrate + seed + fetch + import + verify)
# Analysis pipeline (deterministic)
npm run analyze:all        # Full pipeline: loops → scc → partitioned → johnson → matrix → financial → score (~2 hrs, dominated by 6-hop loops)
npm run analyze:full       # drop:loops --yes + analyze:all — clean-slate rerun

# Interactive deep dives
npm run lookup -- --name "charity name"    # Network analysis
npm run lookup -- --bn 123456789RR0001     # By business number
npm run risk -- --name "charity name"      # Risk report
npm run risk -- --bn 123456789RR0001       # By business number

# Tests
npm run test:unit          # 54 unit tests (no DB)
npm run test:integration   # Schema + data integrity
```

## Database Connection

The project uses a two-tier access model:

- **`.env`** (gitignored) - Admin credentials with full read/write. Used for data loading.
- **`.env.public`** (committed) - Read-only credentials for hackathon participants and AI agents.

`lib/db.js` loads `.env` first. If no `.env` exists, it falls back to `.env.public` automatically. This means you can clone the repo, run `npm install`, and immediately query the database without any configuration.

All queries go through `lib/db.js` which handles SSL (Render PostgreSQL) and sets `search_path=cra,public`.

## Database Schema

All CRA tables live in the **`cra` schema** (not `public`). The `search_path` is set automatically, so queries work with or without the schema prefix:

```sql
SELECT * FROM cra_identification;         -- works (search_path)
SELECT * FROM cra.cra_identification;     -- also works (explicit)
```

### Key Tables

- **cra_identification** - Charity name, address, category. PK: `(bn, fiscal_year)`
- **cra_directors** - Board members. PK: `(bn, fpe, sequence_number)`
- **cra_financial_details** - Revenue, expenditures, assets (Section D / Schedule 6). PK: `(bn, fpe)`
- **cra_financial_general** - Program areas, Y/N flags. PK: `(bn, fpe)`
- **cra_qualified_donees** - Gifts to qualified donees. PK: `(bn, fpe, sequence_number)`
- **cra_compensation** - Employee compensation ranges. PK: `(bn, fpe)`

Key fields: `bn` = 15-char Business Number, `fpe` = fiscal period end date, `field_XXXX` = T3010 line numbers (see `docs/DATA_DICTIONARY.md`).

## Downloading Data

Participants who prefer flat files can export any table as CSV or JSON:

```bash
npm run download                                        # All tables, all years, CSV
npm run download -- --year 2024                         # Single year
npm run download -- --format json --table cra_directors # Single table, JSON
```

Files are saved to `data/downloads/` (gitignored). Uses read-only credentials.

## Skills

Skills are documented in `.claude/skills/` and can be invoked by describing the task. Each skill follows the analytical methodology developed during the original analysis session.

### Available Skills

1. **profile-charity** - Deep profile of a single charity's finances, network, and flows
2. **detect-circular-patterns** - Find circular gifting patterns in the dataset
3. **compare-charities** - Side-by-side comparison of multiple charities
4. **analyze-network** - Map the gift-flow network around a charity
5. **temporal-flow-analysis** - Analyze same-year and adjacent-year symmetric flows

## Understanding Charity Types

The single most important factor for insightful analysis is understanding that **different charity types have fundamentally different financial structures**. Applying the same expectations to a public foundation and a charitable organization will produce misleading results.

### CRA Designation Types

The T3010 `designation` field classifies every charity into one of three types:

#### Designation A: Public Foundation

**What it is:** An organization whose primary purpose is to fund other charities. More than 50% of directors deal at arm's length with each other, and more than 50% of funding comes from arm's length sources.

**Expected financial patterns:**
- Low self-reported "revenue" (endowment returns and donations may not appear as revenue in Section D)
- High "gifts to qualified donees" relative to own program spending
- Expenditures may vastly exceed revenue (drawing from endowment corpus)
- Overhead ratios appear extreme (e.g., 100%+) because the denominator (reported expenditures) excludes grant distributions
- Circular flows with funded charities are common: the foundation gives grants, recipients may donate back to the foundation's endowment

**What to look for:** The question for foundations is not whether money flows in circles (it will), but whether the foundation's own operating costs are reasonable relative to its grant-making. A foundation that spends $2M on administration to distribute $8M in grants (20% overhead on total output) is different from one that spends $2M to distribute $500K (80%).

**Key metric:** Admin + fundraising costs as a percentage of TOTAL grants distributed (not reported revenue).

#### Designation B: Private Foundation

**What it is:** Like a public foundation but more than 50% of directors do NOT deal at arm's length, or more than 50% of funding comes from non-arm's length sources. Often family foundations or corporate foundations.

**Expected financial patterns:**
- Similar to public foundations but with fewer donors (often one family or corporation)
- CRA associated donee flag is almost always set (related parties by definition)
- Shared directors between the foundation and funded charities is expected
- Revenue may be near zero in years when no new endowment contributions are made

**What to look for:** Private foundations have the strongest structural expectation for circular flows. The risk signal is when a private foundation distributes grants to entities that provide private benefit back to the foundation's controllers, not when it distributes to legitimate charities that also happen to donate back.

#### Designation C: Charitable Organization

**What it is:** A charity that spends more than 50% of its income on charitable activities carried on by itself. This is the most common type (~80% of all registered charities).

**Expected financial patterns:**
- Revenue should be meaningful (from donations, government funding, fees for service)
- Program spending should be the largest expenditure category
- Gifts to other charities are optional, not the primary activity
- Circular flows are NOT structurally expected

**What to look for:** This is where circular gifting patterns are most concerning. A charitable organization scoring high on circular flow metrics while reporting low program spending relative to its revenue has no structural explanation for why money is moving in circles. Key questions:
- Does compensation exceed program spending?
- Are circular flows larger than program spending?
- Do the same-year symmetric flows suggest quota gaming rather than genuine collaboration?

### Community Foundations vs Other Foundations

Community foundations (category 0210) are a special case. They hold permanent endowments from many donors and distribute grants to local charities. They legitimately:
- Receive contributions from local charities (endowment deposits)
- Send grants back to those same charities (from endowment earnings)
- Show circular flows with dozens or hundreds of local organizations

**The right question:** Are the foundation's operating costs reasonable relative to the endowment it manages and the grants it distributes?

### Denominational Hierarchies

Religious organizations (categories 0030-0090) often operate as networks of affiliated registrations. A national convention may have dozens of BNs sharing the same 9-digit prefix. Money flows up (tithes) and down (allocations) through the hierarchy every year.

**The right question:** Are the administrative costs at each level of the hierarchy proportionate to the services provided? Is there a level that absorbs funds without passing them through or delivering programs?

### Federated Charities

United Way and similar federated models exist specifically to collect from donors and redistribute to member charities. High circular flow scores are their business model.

**The right question:** Are the redistribution costs reasonable? What percentage of collected funds reaches end-recipients vs being consumed by the federation's overhead?

## What Drives the Most Insightful Analysis

The analysis sessions that produced the most actionable insights followed this pattern:

### 1. Start with the numbers, not the narrative

Run the deterministic pipeline first (`npm run analyze:all`). Let the scoring surface the entities. Don't start with a hypothesis about who might be problematic.

### 2. Context before conclusion

For every high-scoring entity, determine its designation (A/B/C) and category BEFORE interpreting the score. An 18/30 for a Designation A public foundation means something entirely different from an 18/30 for a Designation C charitable organization.

### 3. Temporal analysis is the sharpest tool

The most forensically significant distinction is between:
- **Same-year symmetric flows (>75%)**: Two charities sending each other similar amounts in the same fiscal year. Both count it as a qualifying disbursement. If there's no joint program justifying the exchange, this is the strongest signal of potential quota gaming.
- **Adjacent-year flows (±1 year)**: The cross-year variant. Harder to detect, equally significant. One charity sends in year N, the partner sends back in N±1 with no same-year return.
- **Aggregate symmetry that dissolves at yearly level**: If two charities show 90% symmetry over 5 years but the direction alternates (A→B in odd years, B→A in even years), that's likely project-based collaboration, not circular gaming.

### 4. Follow the operating costs

The most informative financial metric is not revenue or assets but the relationship between:
- **Compensation** (what people get paid)
- **Program spending** (what reaches charitable purposes)
- **Circular flow volume** (what moves between charities)

When compensation exceeds program spending, and circular flow volume exceeds both, the organization is paying people to move money around rather than delivering charitable outcomes.

### 5. Shared governance is the multiplier

When circular flows exist between entities that share board directors, the question of whether the flows serve genuine charitable purposes or serve the interests of the shared controllers becomes critical. The `risk-report` tool surfaces shared directors automatically.

### 6. Size doesn't equal risk

Small charities with modest circular flows ($30-50K) showing high same-year symmetry are just as analytically interesting as large charities with millions in circular flows. The pattern matters more than the magnitude. A $10K round-trip at 100% symmetry in the same fiscal year is a clearer signal than a $5M asymmetric flow.

## Analysis Methodology

### Phase 1: Identify the Universe

Before examining individual charities, establish the full set of entities participating in circular patterns:

1. Run `npm run analyze:loops` to detect all 2-6 hop cycles
2. The output `loop-universe.json` contains every charity BN in any cycle
3. Run `npm run analyze:score` to apply the 0-30 scoring across the full universe
4. Review `universe-top50.txt` for the highest-scoring entities

### Phase 2: Triage by Charity Type

Categorize the top results by their CRA designation and expected financial structure:

| Category | Designation | Expected Circular Flows? | Key Question |
|----------|-------------|------------------------|-------------|
| **Denominational** | Usually C | Yes - tithe/allocation cycles | Are admin costs proportionate at each hierarchy level? |
| **Federated** | Usually C | Yes - collect and redistribute | What % of collected funds reaches end-recipients? |
| **Platforms** | Various | Yes - intermediary hub | Are platform fees reasonable? |
| **Public Foundations** | A | Yes - endowment grant cycles | Are operating costs reasonable vs grants distributed? |
| **Private Foundations** | B | Yes - related party flows | Do grants serve public benefit or private interests? |
| **Community Foundations** | A | Partially - endowment flows | Admin costs vs endowment managed? |
| **Charitable Organizations** | C | **Not expected** | Why is money moving in circles instead of reaching programs? |

The strongest signals come from **Designation C charitable organizations** that score high on circular flows, because their structure provides no inherent explanation for circular patterns.

### Phase 3: Deep Dive on Flagged Entities

For each entity worth examining, follow the profile workflow:

1. **`npm run risk -- --bn <BN>`** - Get the scored risk report with financial history
2. **`npm run lookup -- --bn <BN> --hops 5`** - Map the full gift network
3. **Check the year-by-year flows** - Are symmetric flows same-year or cross-year?
4. **Check the financial profile** - Does overhead exceed programs? Does compensation dwarf charitable output?
5. **Check shared directors** - Do cycle participants share board members?
6. **Read the program descriptions** - What does the charity say it does?

### Phase 4: Temporal Analysis

Apply the timing lens to the most significant reciprocal partnerships:

```sql
-- Year-by-year flow analysis between two charities
WITH out_by_yr AS (
  SELECT EXTRACT(YEAR FROM fpe)::int AS yr, SUM(total_gifts) AS amt
  FROM cra_qualified_donees WHERE bn = '<BN_A>' AND donee_bn = '<BN_B>' AND total_gifts > 0
  GROUP BY EXTRACT(YEAR FROM fpe)
),
in_by_yr AS (
  SELECT EXTRACT(YEAR FROM fpe)::int AS yr, SUM(total_gifts) AS amt
  FROM cra_qualified_donees WHERE bn = '<BN_B>' AND donee_bn = '<BN_A>' AND total_gifts > 0
  GROUP BY EXTRACT(YEAR FROM fpe)
)
SELECT COALESCE(o.yr, i.yr) AS year,
       COALESCE(o.amt, 0) AS a_sends,
       COALESCE(i.amt, 0) AS b_returns,
       CASE WHEN o.amt > 0 AND i.amt > 0
            THEN ROUND(LEAST(o.amt, i.amt) / GREATEST(o.amt, i.amt) * 100)
            ELSE NULL END AS symmetry_pct
FROM out_by_yr o FULL JOIN in_by_yr i ON o.yr = i.yr
ORDER BY year;
```

### Phase 5: Contextual Validation

Before drawing conclusions, check structural context:

```sql
-- Are they affiliated? (same BN prefix = same parent org)
SELECT bn, legal_name, fiscal_year FROM cra_identification
WHERE LEFT(bn, 9) = LEFT('<BN>', 9) ORDER BY bn;

-- What's their designation? (A=public foundation, B=private, C=charitable org)
SELECT bn, designation, legal_name FROM cra_identification
WHERE bn = '<BN>' AND fiscal_year = 2024;

-- What do they actually do?
SELECT description FROM cra_charitable_programs
WHERE bn = '<BN>' ORDER BY fpe DESC LIMIT 5;
```

## Important Caveats

- **2024 data is partial** - charities have 6 months after fiscal year-end to file
- **T3010 form was revised in 2024** - some fields are NULL for 2024 (removed from form) and some are NULL for 2020-2023 (added in 2024)
- **Revenue reporting varies by type** - foundations report low "revenue" because inter-entity transfers may not count, creating misleading ratios. Always check designation before interpreting revenue-based metrics.
- **"Program spending" classification varies** - some charities classify program-delivery staff under "compensation" not "programs", making their program spending appear low
- **CRA "associated" flag is self-reported** - absence does not mean entities are truly independent
- **Overhead benchmarks differ by type** - CRA considers >35-40% overhead worth scrutiny for charitable organizations, but foundations may legitimately have higher ratios due to investment management costs
- **Reports are deterministic but the data is a snapshot** - rerunning after a data refresh may produce different results
- **This analysis identifies patterns, not wrongdoing** - high scores surface statistical anomalies that may have legitimate explanations. Professional review is required before conclusions.

## File Structure

```
hackathon/
├── CLAUDE.md                          # This file
├── .env.public                        # Read-only DB credentials (safe to share)
├── .claude/skills/                    # Skill definitions for AI agents
├── config/dataset-inventory.json      # UUID registry (source of truth)
├── lib/db.js                          # DB pool (.env → .env.public fallback, search_path=cra)
├── scripts/
│   ├── 01-migrate.js through 07-*     # Data pipeline
│   ├── download-data.js               # Export tables as CSV/JSON
│   ├── create-readonly-user.js        # Create read-only DB account
│   └── advanced/
│       ├── 01-detect-all-loops.js     # Brute-force 2-6 hop cycle detection
│       ├── 02-score-universe.js       # Deterministic 0-30 risk scoring
│       ├── 03-scc-decomposition.js    # Tarjan SCC decomposition
│       ├── 04-matrix-power-census.js  # Walk census (cross-validation)
│       ├── 05-partitioned-cycles.js   # SCC-partitioned Johnson's
│       ├── 06-johnson-cycles.js       # Johnson's algorithm (cross-validation)
│       ├── lookup-charity.js          # Interactive: network lookup
│       └── risk-report.js            # Interactive: risk assessment
├── data/
│   ├── downloads/                     # Exported CSV/JSON (gitignored)
│   └── reports/                       # Analysis reports (gitignored)
├── docs/
│   ├── ARCHITECTURE.md
│   ├── DATA_DICTIONARY.md
│   ├── SAMPLE_QUERIES.sql
│   └── guides-forms/                 # Authoritative CRA source documents (ground truth)
│       ├── T3010.md                  # Official T3010 form
│       ├── CODES.md                  # Official code lists
│       └── OPEN-DATA-DICTIONARY-V2.0 ENG.md  # Official data dictionary
└── tests/
```
