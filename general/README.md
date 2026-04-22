# General — Cross-Dataset Entity Resolution

Part of the **AI For Accountability Hackathon** suite, alongside [CRA](../CRA/), [FED](../FED/), and [AB](../AB/).

The `general` module answers a seemingly simple question that is in fact extremely hard: **"Is this organization in the CRA charity database the same organization as this recipient of a federal grant, or this vendor on an Alberta contract?"**

The same legal entity can appear under dozens of different names across the three datasets — sometimes with different registration numbers, sometimes with typos, sometimes only as a truncated trade name on an invoice. A representative mid-sized registered charity operating in all three datasets typically has 10+ distinct name variants, multiple Business Number suffix variants (the `RR` charity account, `RC` corporate tax account, `RP` payroll account), and hundreds of source records across 6 tables. Without reconciling all of these to one canonical entity, cross-dataset accountability analysis is impossible.

This module builds one canonical **golden record** per real-world organization, linked to every source row that contributed to it.

---

## What this produces

A single authoritative table — `entity_golden_records` — containing one row per real-world organization, with:

- The canonical legal name (chosen by an LLM from all observed name variants)
- Every name variant the organization appears under across all six source tables
- The business number root (first 9 digits) as the primary identifier, plus every full-length BN variant (including the `RR`, `RC`, `RP` suffix variants for charity / corporate-tax / payroll accounts)
- A per-dataset profile: CRA registration + financials, federal grants summary, Alberta grants/contracts/sole-source totals
- A merge history showing every entity that was absorbed into this one
- An aliases array with full source provenance (which dataset, which table, which record each variant came from)
- Cross-references to *related* entities (parent/subsidiary, regional chapter/national body) separate from *same* (duplicate registrations to collapse)

From that single table any downstream analysis can answer questions like *"show me every dollar of public money that flowed to this organization across CRA, federal, and provincial sources"* in constant-time lookups by BN or name.

---

## The core problem

The three source systems were built independently by different levels of government, at different times, for different purposes. Each records an organization's name in its own way:

- **CRA T3010** records the legal name as filed on the annual registered-charity return — plus a 15-character Business Number ending in `RR0001`
- **Federal grants & contributions** records the recipient's legal name as the department's grant-management system knows it — plus the business number from that department's vendor file
- **Alberta grants, contracts, sole-source, and non-profit registry** each capture the recipient's name as entered by the provincial program or registry — often without any business number, often with typos, often with the word order rearranged
- **CRA qualified donees** is a hidden gold mine: every registered charity declares its gifts to other charities on its T3010, and *writes out the recipient's name as it knows it.* The same organization can appear under seven different name variants written by seven different donors. We pull these in explicitly to harvest name variants that don't appear in any other source.

Any approach that relies on just one source of truth is inherently partial. The pipeline treats all six source tables as equally authoritative and reconciles them through a cascade of matching techniques — strictest first, most forgiving last.

---

## The pipeline

The pipeline is six discrete stages. Each writes to its own Postgres table(s) and is independently idempotent — any stage can be re-run without corrupting earlier work. Together they transform ~1.1 million source records into ~851,000 canonical entities.

### Stage 1 — Schema migration (`03-migrate-entities.js`)

Creates the entity-resolution tables, indexes, and helper SQL functions in the `general` schema. Key helpers:

- `general.norm_name()` — the canonical-name normalizer used everywhere downstream. Strips operational prefixes like *"TRADE NAME OF"*, *"O/A"*, *"DBA"*, *"DOING BUSINESS AS"*, *"AKA"*, *"FORMERLY"*, and *"F/K/A"* from names; strips trailing *"(THE)"* and leading *"THE"*; handles bilingual English-French names separated by pipe or slash; collapses punctuation and whitespace; uppercases everything. So variants like *"ACME FOUNDATION"*, *"ACME FOUNDATION (THE)"*, and *"Acme Foundation, ."* all normalize to the same string.
- `general.is_valid_bn_root()` — recognizes whether a 9-digit BN string is a real Canadian Business Number or a sentinel placeholder (all zeros, `100000000`, `200000000`, etc.). Placeholder BNs used to cause thousands of unrelated entities to collide.
- `general.extract_bn_root()` — strips non-digit characters from a raw BN string (spaces, letters, dashes — the wild data has all of these) and returns a 9-digit root only if it's a real BN.

### Stage 2 — Deterministic resolution (`04-resolve-entities.js`)

Walks the six source tables in a carefully-chosen order, and for each record either (a) links it to an existing entity or (b) creates a new one. Ordered so the highest-trust data seeds entities first.

**Phase 1 — CRA identification seed.** Reads ~91,000 registered Canadian charities from `cra.cra_identification`. Each unique BN becomes an entity, with the CRA legal name as the canonical name. This forms the authoritative backbone: BN is the primary identifier throughout the pipeline.

**Phase 1b — CRA qualified donees.** Reads ~1.66 million rows from `cra.cra_qualified_donees` (gifts declared by one charity to another on its T3010). Matches by the recipient's BN where present — this attaches *thousands of additional name variants* to existing Phase 1 entities, because each donor wrote the recipient's name in its own way. For recipients whose BN is unknown or whose registration has been revoked, a new entity is created.

**Phase 2 — Federal grants.** Reads ~422,000 distinct recipient names from `fed.grants_contributions`. BN-anchors to Phase 1 entities where possible. Creates new BN-only entities for federal recipients not registered with CRA (government departments, universities, foreign organizations). For records with no usable BN, falls back to a name-matching cascade: exact match, then normalized match, then the TRADE-NAME and bilingual-pipe extractors.

**Phase 3 — Alberta data.** Reads from the four Alberta tables: `ab_non_profit` (69K records), `ab_grants` (~453K distinct recipient names), `ab_contracts` (~11K), `ab_sole_source` (~5K). AB data rarely contains BNs, so this stage is almost entirely name-based — exact-name match, then normalized-name match, then new-entity creation. A well-matched CRA/FED entity typically picks up 20–200+ Alberta source rows here.

**Phase 4 — Deterministic deduplication.** Two passes:
- *Same-BN-root dedup:* any two entities sharing the same non-placeholder 9-digit BN root are collapsed into one. This correctly merges cases where CRA and FED each created a separate entity for the same BN before Phase 2 could link them.
- *Same-normalized-name dedup:* entities with identical normalized names are collapsed into one — but only if the group has *at most one distinct BN*. This prevents the bug that merged 115 distinct "ST. ANDREW'S PRESBYTERIAN CHURCH" charities (across different Canadian cities with different CRA BNs) into a single entity.

**Phase 5 — Enrichment.** Refreshes derived fields: source-link counts on each entity, normalized-name cache, dataset-coverage array.

The output of Stage 2 is the `entities` table — roughly 925,000 rows before the LLM stage collapses duplicates — each linked via `entity_source_links` to every source record it absorbed.

### Stage 3 — Probabilistic matching with Splink (`05-run-splink.js` + `splink/`)

Deterministic matching catches the easy cases: same BN, same name, *"TRADE NAME OF"*. It misses the harder ones: subtle spelling drift, hierarchical organization variants ("Roman Catholic Episcopal Corporation of the Diocese of Hamilton" vs. "Diocese of Hamilton Catholic"), recipients listed without BNs but clearly matching an entity by address or entity-type.

To close that gap we integrate **[Splink](https://moj-analytical-services.github.io/splink/)**, the UK Ministry of Justice's open-source probabilistic record linkage library. Splink implements the Fellegi-Sunter model — an academic standard for entity matching that weights multiple comparison features (name similarity, city, postal code, entity type, BN) and learns the weights from the data itself via expectation-maximization.

How it runs in our pipeline:

1. A Python export process reads the six source tables from Postgres and writes six Parquet files with a standardized schema: record ID, dataset, legal name, cleaned name (with trade-name/DBA/AKA stripped), 9-digit BN root, postal code, city, province, entity type. The same cleanup rules used by `general.norm_name()` are applied here so both sides of the pipeline normalize names identically.
2. Splink runs in-memory on a DuckDB backend (the fastest option for single-machine jobs on ~1 million records). It applies four blocking rules to cut the universe of candidate pairs down to a tractable size (e.g., "same BN root", "same city + first five characters of name"). On those blocks it computes Jaro-Winkler name similarity at thresholds 0.92 and 0.82, combines it with exact-match weights on BN/city/postal/type, and produces a probability score for every candidate pair.
3. It trains the weighting model via EM on two blocks (BN and cleaned name) — this typically converges in 20-25 iterations.
4. It writes two tables back to Postgres:
   - `splink_predictions` — every candidate pair scoring above 0.40, with match probability, feature breakdown, and connected-component cluster ID.
   - `splink_aliases` — every (cluster, record) association, used downstream to enrich golden-record alias lists with name variants Splink pulled in that the deterministic cascade missed.

On a current run this produces roughly 530,000 pairwise predictions spanning ~884,000 total clusters (including singletons — records that didn't match anything). The predictions distribute roughly as: 325K high-confidence (≥0.95), 125K medium (0.70–0.95), 80K review-band (0.40–0.70).

Splink is deterministic given the same input and seed — two runs produce bit-identical predictions. This is important for reproducibility.

### Stage 4 — Candidate detection (`06-detect-candidates.js`)

Collects duplicate pairs from five tiers into a staging table (`entity_merge_candidates`) that the LLM stage reviews. Each tier casts a different kind of net:

- **Tier 1 — Same normalized name.** Finds entities whose `norm_name()` values match exactly. Two safety guards prevent over-merging: if both sides are CRA-sourced with different real BNs, they are automatically marked DIFFERENT (distinct charities cannot share a BN); otherwise the pair is queued for LLM review.
- **Tier 2 — Shared BN root.** Finds entities sharing the same 9-digit BN — a direct signal of same-entity status. Placeholder BNs are excluded.
- **Tier 3 — Trade-name extraction.** Extracts the "Y" half of patterns like "X TRADE NAME OF Y", "X O/A Y", "X DBA Y", and looks up Y as a candidate match for X.
- **Tier 4 — Trigram similarity.** Uses Postgres's `pg_trgm` extension (a GIN-indexed trigram model) to find name pairs with at least 65% character-trigram overlap. Catches typos and word-order variations.
- **Tier 5 — Splink probabilistic matches.** Reads from `splink_predictions` (the output of Stage 3) and maps each Splink-paired source record back to our entity IDs. Pairs where Splink's confidence is in the 0.40–0.95 range are queued for LLM review. High-confidence pairs (≥0.95) would have already been caught by Tiers 1-4 or become candidates here for a safety check.

On a typical run this produces ~1.6 million candidate pairs to review.

### Stage 5 — IDF keyword overlap (`07-smart-match.js`)

An additional candidate-generation pass that uses a different signal: **rare-keyword overlap**. Constructs an inverted index from every entity name, tokenized and weighted by inverse document frequency (rare words score higher). Two entities that share ≥30% of their rare keywords become candidates for review, even if their trigram similarity was too low to trigger Tier 4.

This tier specifically catches hierarchical organizations that Splink and trigram both miss — e.g., "ROMAN CATHOLIC EPISCOPAL CORPORATION OF THE DIOCESE OF HAMILTON IN ONTARIO" and "DIOCESE OF HAMILTON ROMAN CATHOLIC CORPORATION" have almost no trigram overlap (different word order and punctuation) but share rare keywords ("Hamilton", "diocese", "episcopal") that matter more than common stopwords. In the 500-entity validation sample, this tier added ~120 cross-dataset links that no other tier found.

### Stage 6 — LLM verdict + authoring (`08-llm-golden-records.js`)

The heart of the pipeline. 100 concurrent workers (or 100+100 when running two providers in parallel) review every candidate pair and do two things in one call:

1. **Verdict.** Decide whether the two entities are the SAME legal organization, RELATED (parent/subsidiary/regional chapter/affiliate), or DIFFERENT.
2. **Author the golden record.** When the verdict is SAME, the same LLM call also produces the canonical legal name (the cleanest, most official-looking form), the entity type (charity / non-profit / company / government / grant-recipient / individual / unknown), and an exhaustive deduplicated list of every meaningful name variant across both entities.

The LLM prompt is built from a 30-sample view of each entity's source-name variants, its BN root and all BN variants, its dataset coverage, and its current alternate-names list. We use Claude Sonnet 4.6 with a generous 8,000-token output limit so that large entities (universities, dioceses, federations with 50+ name variants) can return their full alias lists without truncation.

The LLM verdict and authored fields are written to `entity_merge_candidates` and, for SAME verdicts, immediately applied: the absorbed entity is marked merged, its source links are redirected to the survivor, and a golden record is upserted for the survivor with the LLM-authored canonical name, entity type, and merged alias list. RELATED verdicts create a cross-link in both entities' `related_entities` arrays (but do *not* merge them). DIFFERENT verdicts are recorded and the pair never surfaces again.

This stage is resumable across crashes and dashboard restarts. Workers claim candidates via `FOR UPDATE SKIP LOCKED`, so two workers can never pick the same pair. Any candidate stuck in `llm_reviewing` status for more than 10 minutes is reset to `pending` on the next run. Network and rate-limit errors trigger exponential backoff; 429s wait 30-120 seconds.

**Dual-provider support.** The LLM layer supports two providers concurrently: Anthropic's direct API and Google Vertex AI (both serving Claude Sonnet 4.6, but with independent rate-limit pools and billing). Running one process per provider in parallel doubles throughput and provides failover if one provider's quota is exhausted mid-run.

On typical runs, Stage 6 processes ~1.6 million pairs over 6-8 hours at 25-33 pairs/second combined.

### Stage 7 — Golden record compile (`09-build-golden-records.js`)

The LLM stage only creates golden records for entities it directly touched via a SAME merge. The final stage does the full compile: one golden record per active entity in the `entities` table.

For each active entity, this stage builds:

- A ranked `aliases` array with full source provenance (every name the entity ever appeared under, which dataset and table each came from, which matching method linked it)
- A `source_summary` counting links per source table
- A deduplicated `addresses` array pulled from all sources
- A `cra_profile` with designation, category, registration date, most-recent address, and 5-year financial rollup (revenue, expenditures, gifts to qualified donees, program spending) derived from joining against `cra_financial_details`
- A `fed_profile` with total grants received, grant count, earliest/latest agreement dates, and top funding departments
- An `ab_profile` with Alberta grant totals, contract totals, sole-source totals, top ministries

The compile step is fast (2-5 minutes for ~850K records). It updates rather than replaces, so re-running safely refreshes stale derived fields.

### Stage 8 — Donee-name trigram fallback (`10-donee-trigram-fallback.js`) — *Tier 6 enrichment*

`cra.cra_qualified_donees` is the table where each T3010 filer reports gifts to other charities. About **6.4%** of those rows can't be BN-anchored (malformed BN, null BN, or BN that isn't in `cra_identification`), and their `donee_name` text doesn't exact-norm match an existing golden record's canonical name — so they slip through Stages 1–7 unlinked.

Stage 8 recovers them using a trigram-fuzzy lookup against the **authoritative catalog** — only golden records that have a primary-source link (`cra_identification`, `ab_non_profit`, or `fed.grants_contributions` with BN). That restriction is the chicken-and-egg guard: lookup targets are guaranteed to have existed *before* any donee row was processed, so no feedback loop forms.

Three phases, idempotent and resumable:

- **A — Detect**: `INSERT INTO general.donee_trigram_candidates` one row per distinct unlinked donee_name with its best trigram neighbour above threshold (default 0.85) and at least N citations (default 3).
- **B — Review**: Claude Sonnet 4.6 decides SAME / RELATED / DIFFERENT per pair, atomic claim via `FOR UPDATE SKIP LOCKED`, same retry + concurrency framework as Stage 6.
- **C — Apply**: for SAME verdicts, append `donee_name` to the entity's `alternate_names` and `entity_golden_records.aliases`, then insert `entity_source_links` rows for every raw `qualified_donees` row using that name — tagged `match_method = 'donee_trigram_fallback'` so the whole operation is reversible with one `DELETE`.

Stage 8 **never creates new entities**. It only links existing primary-source ones. `npm run entities:donee-fallback` runs all three phases; `entities:donee-fallback:detect`, `:llm`, `:apply` run them individually.

---

## Libraries and tools

| Tool | Role | Why |
|------|------|-----|
| **PostgreSQL** (hosted on Render) | Primary data store | Single source of truth; supports every stage through SQL functions, GIN indexes, JSONB, and full-text operators |
| **`pg_trgm`** | Character-trigram similarity (Tier 4) | Built into Postgres; GIN-indexable for millisecond fuzzy-name joins at the 800K-entity scale |
| **[Splink](https://moj-analytical-services.github.io/splink/)** (UK Ministry of Justice, MIT license) | Probabilistic record linkage (Stage 3) | Academic-standard Fellegi-Sunter implementation; learns feature weights from data via EM; battle-tested at government scale |
| **DuckDB** | In-memory analytics engine for Splink | Fastest backend for single-machine Splink runs; handles the 1M-record join universe in ~3 minutes on modest hardware |
| **Claude Sonnet 4.6** (Anthropic + Google Vertex AI) | LLM verdict + canonical-name authoring (Stage 6) | Handles the long tail — cross-system registration numbers, hierarchical organization semantics, bilingual variants, truncation artifacts that rules can't reliably handle |
| **Node.js** (Express, pg, better-sqlite3) | Pipeline orchestration, dashboard, CLI tools | Low-overhead runtime for long-running database-bound jobs; clean async-await ergonomics for 100-way concurrent LLM calls |
| **cleanco** (Python) | Legal-suffix stripping before Splink | Strips "Inc", "Ltd", "LLC", "Société", "GmbH", etc. so the probabilistic model sees stems rather than boilerplate |
| **pyarrow / Parquet** | Intermediate format between Postgres and Splink | Columnar, schema-preserving, fast enough that the DB→Splink handoff takes under a minute |

---

## Tools

Two browser interfaces — one for running the pipeline, one for exploring its output.

### Pipeline Dashboard (port 3800)

`http://localhost:3800` (`npm run entities:dashboard`) — end-to-end observability and control.

- **Stage strip** showing the current state of the pipeline (inferred from the database — no manual coordination needed)
- **Control panel** with one button per pipeline stage; clicking spawns the corresponding script server-side and streams its stdout into an inline log pane. Each log auto-scrolls to the latest line (but preserves scroll position if you scroll up to read history).
- **Real-time metrics**: entity counts, source-link counts by table, Splink prediction stats with band breakdown, LLM progress with rate and ETA, dual-provider throughput split, candidates-by-method table
- **Test-entity sanity cards** — a small set of known organizations (configurable in the dashboard source). Each card looks up the entity by Business Number and displays its current link count, alias count, and dataset coverage, so regressions in matching are visible the instant a pipeline stage completes. The default set includes University of Alberta (large, multi-dataset) plus a handful of mid-sized registered charities that exercise different matching paths (bilingual names, shared canonical names across different BNs, no-BN cross-dataset entities, etc.).
- **Recent merges feed** showing the last ten entity merges with survivor/absorbed names
- **Orphan recovery**: every phase spawn writes its PID to disk; on dashboard restart any still-running orphan phases are re-attached and can be stopped from the UI. A "Kill all pipeline processes" button provides a nuclear option that taskkills every Node/Python process matching our pipeline script names.

The dashboard is the primary operator interface. Run it, click Reset → Migrate → Resolve → Splink → Detect → Smart-match → LLM → Build-golden in sequence, observe each stage to completion, and the pipeline is done.

### Dossier explorer (port 3801)

`http://localhost:3801` (`npm run entities:dossier`) — per-entity forensic analysis. Once the pipeline has built its golden records, the dossier tool is what an analyst uses to actually investigate a specific organization.

Features:

- **Search** — by name (fuzzy trigram match against canonical names + aliases) or Business Number. Search runs only on Enter or the Search button (no auto-search) so the database isn't hammered on every keystroke. GIN trigram indexes keep typical searches under ~200 ms even against 800K entities.
- **Multi-select merge** — tick checkboxes on any number of result rows, click *"Merge N entities → temporary combined dossier"*, and the tool pulls all of them into one in-browser virtual dossier. Aliases, funding totals, charts, and the JSON download combine all selected entities. Nothing is written to the database — close the tab and the merge is gone. This is the tool analysts use when they suspect the pipeline should have merged two entities but didn't, and want to see what the combined view would look like before proposing a change.
- **Per-entity dossier** — seven tabs:
  - **Overview** — identity card, all name variants, addresses, LLM-authored reasoning, and two separate funding charts:
    - *External funding* (stacked: FED grants + AB grants + AB contracts + AB sole-source)
    - *CRA T3010 self-reported* (grouped: revenue vs expenditures vs gifts-in vs gifts-out)
    These are kept separate because CRA Section D revenue already *includes* federal/provincial funding internally; combining them on one chart would double-count.
  - **CRA T3010 (by year)** — per-fiscal-year cards showing total revenue, expenditures, program spending, gifts to donees, assets, liabilities, detailed revenue breakdown (receipted/non-receipted/charities/government/investment/other), registration details, compensation, board roster with arm's-length flags, program descriptions.
  - **Qualified donees** — both sides of the T3010 gift ledger:
    - Gifts *received* — every registered charity that gifted to this entity, with the name the donor wrote
    - Gifts *given* — every registered charity this entity gifted to, aggregated by recipient + year
  - **Source links** — every source table contributing to this entity, link counts, and distinct-name counts
  - **Related / maybe-merge** — pipeline-surfaced candidates the LLM reviewed but didn't merge (RELATED verdicts, uncertain verdicts, pending pairs) + Splink probabilistic matches ≥0.50. Each has a button to merge into the current dossier in-browser.
  - **Accountability** — hub-entity classification (if present), circular-gifting loop participation counts, overhead ratio by year (strict + broad, color-coded red over 35%), government funding breakdown (federal/provincial/municipal), name history with year ranges, T3010 data-quality violation flags (sanity/arithmetic/impossibility) with severity.
  - **International** — countries of operation, resources sent outside Canada, exported goods, non-qualified donee recipients.
  - **Merge history** — every entity absorbed into this one during the pipeline, with timestamps and methods.
  - **Raw JSON** — full-dossier download button that packages *everything* (entity row + golden record + source links + merge history + funding-by-year + CRA-T3010-by-year + qualified donees + accountability + international + related entities + any browser-merged entities' complete payloads) into a single timestamped JSON file. Also a copy-to-clipboard button.
- **Light / dark mode** toggle (top right). Persists in `localStorage`. Chart.js picks up theme colors automatically.

### Year alignment across datasets

A question that comes up: CRA uses a `fpe` date, FED uses `agreement_start_date`, AB uses fiscal-year strings like `"2023 - 2024"`. They're not naturally comparable.

Convention used throughout the dossier: **fiscal year ending in calendar year X** (the Canadian government standard, April 1 – March 31).

- **AB** already reports in this format. `"2023 - 2024"` becomes year label **2024**. Used directly.
- **FED** records `agreement_start_date` (calendar). A grant starting 2023-10-01 is in federal fiscal year 2023-24, so it's mapped to year label **2024**. The aggregation rule: if the start-date month is April or later, label = calendar year + 1; otherwise label = calendar year.
- **CRA** uses `fpe` (fiscal period end) — already the end-year of the fiscal period. A charity with `fpe = 2024-03-31` has its year labeled **2024** (consistent with FY ending in 2024).

One remaining wrinkle: CRA charities can choose *any* fiscal-year-end date, not just March 31. A charity with `fpe = 2024-12-31` (calendar year filer) reports for Jan–Dec 2024 — still labeled 2024 in the dossier, but it covers a different 12 months than a Mar-31 filer's 2024 label. The dossier currently treats fpe year as the authoritative label regardless of the specific month. For most accountability analysis this is accurate enough; only a very small number of charities file twice in one year (which would collide under this scheme), and the dossier surfaces this in the per-year cards if it happens.

---

## Outcomes

On a representative run with the current source data:

- **~851,000 active entities** compiled from ~1.1 million source records across six tables
- **~5.2 million source links** (one record linked per source row; an entity like the University of Alberta accumulates 2,400+ links across federal grants, Alberta grants, Alberta sole-source, and CRA filings)
- **~55,000 multi-dataset entities** — organizations present in at least two of CRA/FED/AB. These are the high-value entities for accountability analysis: where does public money flow across jurisdictions.
- **~67,000 LLM-confirmed SAME merges** — duplicate entities collapsed across sources
- **~65,000 LLM-identified RELATED pairs** — cross-linked for contextual lookups (e.g., the University of Alberta's faculty of medicine is flagged as RELATED to the main University of Alberta entity, not merged)
- **~1.5 million LLM DIFFERENT verdicts** — pairs the candidate-detection stages surfaced that turned out not to be the same organization, usefully recorded so they never get re-reviewed

Five test categories validate pipeline correctness after every run. The dashboard implements them as sanity cards that look up specific BNs on each poll:

| Test category | Expected behavior |
|---------------|-------------------|
| Multi-dataset mid-sized charity (a single registered charity with a unique BN appearing in CRA + federal grants + AB data) | Resolves to a single entity with 200+ source links and 10+ name variants; `dataset_sources` contains all three |
| Corporate family with multiple legal entities (a parent + holding corp + separate charitable foundation, all sharing a name stem) | Kept as three distinct entities (one per BN); LLM tags them RELATED but does not merge |
| Same canonical name, different BNs (two different registered charities that share an identical legal name in different cities) | Kept as two separate entities; the BN-conflict guard prevents over-merging |
| Cross-dataset entity with contracts + sole-source (a charity with line items in multiple Alberta tables) | Correct BN anchor; links include all 4 AB tables (grants, contracts, sole-source, non-profit registry) plus CRA + FED |
| Large multi-dataset institution (e.g. a university registered as a CRA charity and receiving federal + Alberta funding) | Single entity with 2,000+ source links and 50+ aliases across all three datasets |

Against Splink's independently-published 500-entity reference sample, our pipeline finds **98% of the same entities**, captures **4.6× more source links on average** (largely because we include Alberta grants data their reference omits), and matches their singleton count within 0.2%. The remaining gap is concentrated in probabilistic matches for hierarchical religious organizations — the specific case that motivates running Splink as a complementary tier.

---

## Design principles

- **BN is the primary identifier.** Every stage treats the 9-digit Canadian Business Number root as authoritative. Where it's available, it overrides any name-based evidence. Where it's missing, we use cascading weaker signals.
- **No destructive operations without explicit consent.** The `reset:entities` script and dashboard reset button both require a `--yes` flag / confirmation dialog.
- **Every stage is idempotent.** Re-running any phase produces the same result without corrupting earlier work. `UNIQUE` constraints on candidate pairs, `ON CONFLICT DO NOTHING` on source-link inserts, `FOR UPDATE SKIP LOCKED` on LLM worker claims.
- **Every stage is resumable.** If the LLM phase is interrupted at 60% completion, the next run starts exactly where it stopped. PID files persist across dashboard restarts so orphaned phases can still be observed and killed.
- **No placeholder BN contamination.** BN validation and extraction is centralized in a single SQL function; all stages use it. An earlier bug where placeholder BNs (`000000000`, `100000000`, etc.) were accidentally used as real identifiers caused ~1,100 unrelated Alberta entities to cluster — the fix prevents recurrence.
- **Observable by default.** The dashboard polls the database directly; there is no separate event stream or state that can drift out of sync with what actually happened.

---

## Running the pipeline

The dashboard is the primary interface — open it and click through the phases in order. For headless / scripted execution:

```
npm install                               # install dependencies
npm run entities:splink:install           # one-time: install Splink Python deps
npm run setup                             # create base schema + ministries
npm run pipeline:rebuild                  # destructive: reset + run full pipeline end to end

npm run entities:dashboard                # http://localhost:3800 — pipeline control
npm run entities:dossier                  # http://localhost:3801 — per-entity explorer
```

Both browser tools can run simultaneously (different ports). Individual pipeline stages can be invoked via `entities:migrate`, `entities:resolve`, `entities:splink`, `entities:detect`, `entities:smart-match`, `entities:llm`, `entities:build-golden`. Full reset via `entities:reset:force`.

### Verifying the pipeline ran correctly

After a full rebuild, the dashboard's sanity cards should all resolve without a `NOT FOUND` marker, with link counts and dataset-coverage matching expectations for each test category. See the "Outcomes" section above for the five categories the cards exercise.

For a structured quality check beyond the sanity cards, run:

```bash
npm run entities:compare:splink
```

This runs the 500-entity reference sample from Splink's published master-table against our pipeline's current state and reports:

- Coverage rate (how many of the reference entities we found)
- Per-stratum comparison (BN-anchored vs no-BN, bilingual names, large orgs)
- Link-count and alias-count deltas

If coverage drops or specific strata regress, a recent pipeline stage is the likely culprit. The comparison's output is written to `data/reports/compare-500-vs-splink.csv` for offline analysis.

---

## License

MIT — see [../LICENSE](../LICENSE)
