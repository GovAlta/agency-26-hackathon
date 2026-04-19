# Known Data Issues

Living catalogue of every data-quality defect we can prove with evidence
against the **AB**, **CRA**, and **FED** source datasets as they sit in
this repository's database.

## How this document works

Every entry has the same structure:

- **Issue ID** — stable identifier (`F-…`, `C-…`, `A-…`) so external
  references don't rot.
- **What's wrong** — one sentence, plain language.
- **Evidence** — the exact SQL (or script output) a reader can run today to
  reproduce the count.
- **Count as of 2026-04-19** — the current snapshot's number. Re-run the
  query to refresh.
- **Source of authority** — TBS spec / T3010 form line / Open Data
  Dictionary / script that computed it.
- **Mitigation status** — one of:
  - ✅ **Mitigated** — a view, doc, or filter eliminates the footgun for
    users who follow the recommended path.
  - 📝 **Documented as-is** — we carry the defect through unchanged and
    warn consumers.
  - ⚠️ **Active** — no mitigation yet.

Rules of inclusion:
- Every issue must be **provable** — a SQL query, script output, or form-line
  citation must reproduce it. Editorial opinions, plausibility heuristics,
  and future concerns belong elsewhere.
- No row is ever modified or deleted from the source data to resolve an
  issue. Mitigations are always additive (views, docs, reports).
- If an issue changes — counts drift, a new mitigation lands, the defect
  evaporates on the next snapshot — update the entry in place and move the
  old number to the Changelog at the bottom.

---

## FED — Federal Grants and Contributions (`fed.grants_contributions`)

Authoritative TBS schema: [`FED/docs/grants.json`](FED/docs/grants.json),
[`FED/docs/grants.xlsx`](FED/docs/grants.xlsx).

### F-1. `ref_number` collisions across distinct recipients

**What's wrong.** TBS spec says `ref_number` is "a unique reference number
given to each entry." Publishers have broken that rule: the same
`ref_number` appears under multiple, unrelated recipients.

**Evidence.**
```sql
SELECT COUNT(*) FROM (
  SELECT ref_number FROM fed.grants_contributions
  WHERE ref_number IS NOT NULL
  GROUP BY ref_number
  HAVING COUNT(DISTINCT COALESCE(recipient_business_number,'') || '|' ||
                        COALESCE(recipient_legal_name,'')) > 1
) t;
-- 41,046
```

Concrete example: `ref_number = '001-2020-2021-Q1-00006'` covers **both** a
$23,755 Canadian Heritage Photography Foundation grant *and* a
$20.5M→$36.24M Women's Shelters Canada contribution — both tagged
`amendment_number = 0`.

**Count (2026-04-19):** 41,046 distinct `ref_number`s collide across ≥2
recipients. Concentrated in pre-2018 legacy `GC-…` records.

**Source.** TBS spec `FED/docs/grants.json` field `ref_number`,
description: "unique reference number given to each entry."

**Mitigation.** 📝 Documented in
[`FED/docs/DATA_DICTIONARY.md`](FED/docs/DATA_DICTIONARY.md) → "Known
source defects". `fed.vw_agreement_current` uses
`(ref_number, COALESCE(bn, legal_name, _id))` as the partition key so
colliding agreements stay separated instead of silently collapsing.
`FED/scripts/05-verify.js` prints the count on every run.

### F-2. Duplicate `(ref_number, amendment_number)` rows

**What's wrong.** Within any single `ref_number`, each `amendment_number`
should appear at most once. 25,853 pairs violate this, even after
normalising for the F-1 collision effect.

**Evidence.**
```sql
SELECT COUNT(*) FROM (
  SELECT ref_number, amendment_number
  FROM fed.grants_contributions
  WHERE ref_number IS NOT NULL
  GROUP BY ref_number, amendment_number
  HAVING COUNT(*) > 1
) t;
-- 25,853
```

**Count:** 25,853 colliding pairs.

**Source.** Direct consequence of the TBS uniqueness rule; duplicates here
are unambiguous publisher defects.

**Mitigation.** 📝 Documented. Reported by `05-verify.js`. `_id` remains
the only truly unique row PK.

### F-3. `agreement_value` is cumulative, not a delta — naive SUM double-counts

**What's wrong.** TBS spec: `agreement_value` "should report on the total
grant or contribution value, and **not the change in agreement value**."
Every amendment row restates the running total for the whole agreement.
Summing raw rows triple-counts an agreement amended twice.

**Evidence.**
```sql
SELECT
  (SELECT ROUND(SUM(agreement_value)::numeric,0) FROM fed.grants_contributions) AS all_rows,
  (SELECT ROUND(SUM(agreement_value)::numeric,0) FROM fed.vw_agreement_originals) AS originals,
  (SELECT ROUND(SUM(agreement_value)::numeric,0) FROM fed.vw_agreement_current) AS current_commitment;
-- all_rows = $921B, originals = $533B, current_commitment = $816B
```

**Count:** naive SUM inflates by ~$388B (~73%) versus the correct "current
commitment" figure.

**Source.** TBS spec `FED/docs/grants.json` field `agreement_value`.

**Mitigation.** ✅
- `fed.vw_agreement_current` — latest amendment per agreement.
- `fed.vw_agreement_originals` — `is_amendment = false` only.
- `FED/docs/DATA_DICTIONARY.md` → "How to sum `agreement_value` correctly".
- `FED/docs/SAMPLE_QUERIES.sql` leads with the sum-comparison query.
- `FED/CLAUDE.md` "Important Notes" rewritten to lead with this caveat.

### F-4. Negative `agreement_value` violates TBS validation

**What's wrong.** TBS spec: value "must be greater than 0." Source data
includes 4,633 negative rows. 99.7% of them are on amendment rows — the
publisher de facto uses negatives as termination/reversal markers,
although this is not authorised by the spec.

**Evidence.**
```sql
SELECT
  COUNT(*) FILTER (WHERE agreement_value < 0) AS negative_total,
  COUNT(*) FILTER (WHERE agreement_value < 0 AND is_amendment) AS negative_on_amendments,
  COUNT(*) FILTER (WHERE agreement_value < 0 AND NOT is_amendment) AS negative_on_originals
FROM fed.grants_contributions;
-- negative_total 4,633 | on_amendments 4,617 | on_originals 16
```

**Count:** 4,633 negative rows (4,617 on amendments, 16 on originals).

**Source.** TBS spec validation: "This field must not be empty. The number
must be greater than 0."

**Mitigation.** 📝 Documented in `FED/docs/DATA_DICTIONARY.md` and
`FED/CLAUDE.md`. `05-verify.js` reports the breakdown. No data is
rewritten.

### F-5. Zero `agreement_value` violates TBS validation

**What's wrong.** Same rule as F-4: value "must be greater than 0." 11,510
rows carry exactly 0.

**Evidence.**
```sql
SELECT COUNT(*) FROM fed.grants_contributions WHERE agreement_value = 0;
-- 11,510
```

**Count:** 11,510 rows.

**Source.** TBS spec validation clause.

**Mitigation.** 📝 Documented. Reported by `05-verify.js`.

### F-6. `recipient_business_number` format polyglot

**What's wrong.** TBS spec: 9-digit CRA Business Number. The column in
practice carries at least six distinct formats including garbage strings
like `-`.

**Evidence.**
```sql
SELECT LENGTH(recipient_business_number) AS len, COUNT(*)
FROM fed.grants_contributions
WHERE recipient_business_number IS NOT NULL
GROUP BY len ORDER BY count DESC;
```

| len | count | sample |
|-----|-------|--------|
| 15  | 336,851 | `017463077RT0001` (15-char CRA BN) |
| 9   | 207,389 | `000000000` (9-digit BN root) |
| 1   | 19,416 | `-` (garbage placeholder) |
| 10  | 3,585 | `0000000000` |
| 17  | 1,343 | `05231185913RT0001` (extra digits) |
| 16  | 677 | `000015123 RT0001` (embedded space) |
| other | ~2,000 | 1–8 chars, 11–14 chars, 18+ |

**Count:** ~28,600 rows outside the expected 9-char or 15-char BN formats.

**Source.** TBS spec `FED/docs/grants.json` field
`recipient_business_number`: 9-digit BN.

**Mitigation.** 📝 Documented in `FED/docs/DATA_DICTIONARY.md`,
`FED/CLAUDE.md`. No on-import normalization.

### F-7. Missing BN when a BN is expected (for-profit / not-for-profit)

**What's wrong.** TBS marks `recipient_business_number` "Optional" in
general, but organisations with `recipient_type` `F` (for-profit) or `N`
(not-for-profit / charity) should have one. Many rows don't.

**Evidence.**
```sql
SELECT recipient_type,
       COUNT(*) AS total,
       COUNT(*) FILTER (
         WHERE recipient_business_number IS NULL
            OR TRIM(recipient_business_number)=''
            OR LENGTH(recipient_business_number) < 9
       ) AS missing_or_stub
FROM fed.grants_contributions
WHERE recipient_type IN ('N','F')
GROUP BY recipient_type;
```

| recipient_type | total | missing_or_stub | % missing |
|---|---:|---:|---:|
| N (not-for-profit / charity) | 229,053 | 37,350 | **16.3%** |
| F (for-profit) | 234,766 | 9,752 | **4.2%** |

**Count:** 47,102 rows where a BN should have been recorded but isn't.

**Source.** Inference from TBS recipient-type semantics and the CRA BN
standard for all business-to-government transactions.

**Mitigation.** ⚠️ Active — not yet mitigated.

### F-8. Missing `agreement_end_date`

**What's wrong.** TBS marks `agreement_end_date` "Mandatory." 187,866
rows (14.7%) have it NULL.

**Evidence.**
```sql
SELECT COUNT(*) FROM fed.grants_contributions
WHERE agreement_end_date IS NULL;
-- 187,866
```

**Count:** 187,866 (14.7% of 1,275,521 rows).

**Source.** TBS spec `FED/docs/grants.json` field `agreement_end_date`:
"Mandatory."

**Mitigation.** ⚠️ Active. (`agreement_start_date` is populated on every
row — this is strictly an `end_date` problem.)

### F-9. `agreement_end_date < agreement_start_date`

**What's wrong.** 947 rows have an end date that precedes the start date.

**Evidence.**
```sql
SELECT COUNT(*) FROM fed.grants_contributions
WHERE agreement_end_date < agreement_start_date;
-- 947
```

**Count:** 947 rows.

**Mitigation.** ⚠️ Active.

### F-10. `agreement_number` is free text and reused as a program code

**What's wrong.** TBS spec marks it "Optional" and "Free text." In
practice, departments use it for program/award identifiers reused across
thousands of unrelated grants, so it **cannot be a join key** and
**cannot identify an agreement**.

**Evidence.**
```sql
SELECT agreement_number, COUNT(*), COUNT(DISTINCT recipient_legal_name) AS recipients
FROM fed.grants_contributions WHERE agreement_number IS NOT NULL
GROUP BY 1 ORDER BY 2 DESC LIMIT 5;
```

| agreement_number | rows | distinct recipients |
|---|---:|---:|
| URU | 3,439 | 3,439 |
| RGPIN | 2,157 | 2,157 |
| USRAI | 1,878 | 1,780 |
| EGP | 1,137 | 1,131 |
| CGSM | 790 | 790 |

**Count:** out of 747,531 distinct `agreement_number` values, hundreds
are program codes; the top 5 alone cover 9,401 unrelated grants.

**Source.** TBS spec + observation.

**Mitigation.** 📝 Documented in `FED/docs/DATA_DICTIONARY.md` and
`FED/CLAUDE.md` ("Never a join key").

### F-11. Amendments can reduce agreement value

**What's wrong.** Not strictly an error — but worth knowing. Of amendment
rows that have a prior value to compare against: 23,108 increased,
**2,900 decreased**, 9,379 unchanged. Analysts assuming amendments only
grow agreements will mis-read 8% of them.

**Evidence.** See the window-function query in the audit script (see
Changelog).

**Source.** Observation.

**Mitigation.** 📝 Captured in the "How to sum" box in
`FED/docs/DATA_DICTIONARY.md`; `vw_agreement_current` uses the latest
amendment regardless of direction.

---

## CRA — T3010 Charity Data (`cra.*`)

The CRA module ships a structured data-quality suite under
`CRA/scripts/data-quality/` that persists findings to the database. Every
rule is textually grounded in the T3010 form or the CRA Open Data
Dictionary v2.0 — see
[`CRA/scripts/data-quality/README.md`](CRA/scripts/data-quality/README.md)
for the full methodology.

### C-1. T3010 arithmetic impossibilities — 54,010 filings across 10 rules

**What's wrong.** Filings that fail one of ten identities printed on the
T3010 form or in the Dictionary — e.g. `field_5100 = 4950 + 5045 + 5050`
(printed literally on the form as "Total expenditures (add lines 4950,
5045, 5050)").

**Evidence.**
```sql
SELECT rule_code, COUNT(*) AS rows, COUNT(DISTINCT bn) AS distinct_bns
FROM cra.t3010_impossibilities
GROUP BY rule_code ORDER BY rows DESC;
```

| Rule | Rows | Distinct BNs | Meaning |
|------|---:|---:|---|
| `PARTITION_4950` | 24,960 | 18,017 | Sub-lines of line 4950 exceed the line itself |
| `COMP_4880_EQ_390` | 13,504 | 8,562 | Schedule 6 comp ≠ Schedule 3 comp (form line 631 says they must match) |
| `IDENTITY_5100` | 6,697 | 5,355 | Total expenditures don't reconcile to their three addends |
| `IDENTITY_4200` | 4,763 | 4,155 | Total assets ≠ sum of asset lines 4100–4170 |
| `SCH3_DEP_FORWARD` | 2,222 | 1,559 | `field_3400` = TRUE but no Schedule 3 row |
| `IDENTITY_4350` | 1,437 | 1,367 | Total liabilities ≠ sum of liability lines 4300–4330 |
| `DQ_845_EQ_5000` | 243 | 240 | Schedule 8 line 845 ≠ `field_5000` (Dictionary says "must be pre-populated") |
| `DQ_855_EQ_5050` | 161 | 157 | Schedule 8 line 855 ≠ `field_5050` |
| `DQ_850_EQ_5045` | 19 | 18 | Schedule 8 line 850 ≠ `field_5045` |
| `SCH3_DEP_REVERSE` | 4 | 4 | Schedule 3 row exists but `field_3400` ≠ TRUE |

**Count:** 54,010 violations across 30,856 distinct BNs (12.8% of the
240,714 BN-years with financial filings in the five-year window).

**Source.** T3010 form and Open Data Dictionary v2.0 — see
[`CRA/scripts/data-quality/02-t3010-arithmetic-impossibilities.js`](CRA/scripts/data-quality/02-t3010-arithmetic-impossibilities.js)
for the per-rule form-line citations.

**Mitigation.** ✅ Surfaced in `cra.t3010_impossibilities` with severity
($ impact) per row, plus a Markdown report at
`CRA/data/reports/data-quality/t3010-arithmetic-impossibilities.md`.
Three exemplars pre-validated against `charitydata.ca` match to the
dollar.

### C-2. T3010 plausibility flags — 1,075 unit-error candidates

**What's wrong.** Not impossibilities — the form puts no upper bound on
money fields — but values that are very likely unit errors (reported in
dollars when millions was meant, or vice-versa).

**Evidence.**
```sql
SELECT rule_code, COUNT(*) FROM cra.t3010_plausibility_flags GROUP BY rule_code;
```

| Rule | Count | Meaning |
|------|---:|---|
| `PLAUS_EXP_FAR_EXCEEDS_REV` | 792 | `field_5100 / field_4700 > 100` (excludes foundations A/B) |
| `PLAUS_COMP_EXCEEDS_TOTAL_EXP` | 234 | Comp > total expenditures (no sensible designation) |
| `PLAUS_MAGNITUDE_OUTLIER` | 49 | Money field > $10B (excludes foundations A/B) |

**Count:** 1,075 filings flagged.

**Source.** See the foundation-exclusion commentary in
[`CRA/scripts/data-quality/02-t3010-arithmetic-impossibilities.js:651–708`](CRA/scripts/data-quality/02-t3010-arithmetic-impossibilities.js).

**Mitigation.** ✅ Surfaced in `cra.t3010_plausibility_flags`; clearly
separated from impossibilities so downstream users can opt in.

### C-3. Qualified-donee BN→name mismatches — $8.97B unjoinable

**What's wrong.** Every `cra_qualified_donees` row lists the donee's BN
*and* the donee's name as the donor wrote it. They should agree with
`cra_identification` but frequently don't.

**Evidence.**
```sql
SELECT mismatch_category,
       COUNT(*) AS rows,
       ROUND(SUM(total_gifts)::numeric,0) AS dollars
FROM cra.donee_name_quality
GROUP BY mismatch_category
ORDER BY dollars DESC;
```

| Category | Rows | $ gifts | Meaning |
|----------|---:|---:|---|
| `MINOR_VARIANT` | 312,142 | $50.1B | Trivial variation (case, "The X" vs "X"); not an issue |
| `NAME_MISMATCH` | 67,631 | $4.99B | BN registered but name doesn't match (rebrands, acronyms, DAF platforms, or wrong-BN typos) |
| `UNREGISTERED_BN` | 24,151 | $2.03B | BN well-formed but not in `cra_identification` |
| `MALFORMED_BN` | 35,913 | $1.95B | BN violates CRA's own 15-char `^\d{9}RR\d{4}$` format |
| `PLACEHOLDER_BN` | 30 | $138K | All-zeros BN (`000000000RR0001`) — "unknown" |

**Count:** 127,725 problematic rows totalling **$8.97B** in gifts that
cannot be programmatically joined back to a charity record.

`MALFORMED_BN` breakdown (defect sub-codes):

| Defect | Rows | $ gifts |
|--------|---:|---:|
| 9 digits, no suffix | 14,102 | $897M |
| `RR` suffix truncated | 4,109 | $251M |
| Root = 8 digits | 3,559 | $130M |
| Single `R` (e.g. `R0001`) | 3,414 | $208M |
| Embedded space | 2,088 | $96M |
| Non-numeric BN | 1,511 | $74M |
| Root too long | 686 | $14M |
| `RP` (payroll) program code | 454 | $26M |
| `RC` (corporate-tax) program code | 445 | $82M |
| `RT` (GST/HST) program code | 372 | $24M |
| Fewer than 9 digits | 330 | $6M |
| `EE` invalid program code | 43 | $18M |

**Source.** CRA's own BN format (T3010 form) and Open Data Dictionary
v2.0. See
[`CRA/scripts/data-quality/01-donee-bn-name-mismatches.js`](CRA/scripts/data-quality/01-donee-bn-name-mismatches.js).

**Mitigation.** ✅ Full per-row breakdown in `cra.donee_name_quality`.
Markdown report at
`CRA/data/reports/data-quality/donee-bn-name-mismatches.md` with "Toronto"
case study (Jewish Foundation of Greater Toronto FY 2023: `donee_bn =
'Toronto'` on all 434 Schedule 5 rows, $42.95M).

### C-4. Qualified-donee BN or amount missing / invalid

**What's wrong.** Even before cross-referencing against the registry,
many rows are broken on their face.

**Evidence.**
```sql
SELECT
  COUNT(*) AS total,
  COUNT(*) FILTER (WHERE donee_bn IS NULL) AS null_bn,
  COUNT(*) FILTER (WHERE donee_bn IS NOT NULL AND donee_bn !~ '^[0-9]{9}RR[0-9]{4}$') AS malformed_bn,
  COUNT(*) FILTER (WHERE total_gifts IS NULL) AS null_amount,
  COUNT(*) FILTER (WHERE total_gifts = 0) AS zero_amount,
  COUNT(*) FILTER (WHERE total_gifts < 0) AS negative_amount,
  COUNT(*) FILTER (WHERE donee_name IS NULL OR TRIM(donee_name)='') AS null_donee_name
FROM cra.cra_qualified_donees;
```

| Defect | Count |
|---|---:|
| Total rows | 1,664,343 |
| NULL `donee_bn` | 109,996 (6.6%) |
| Malformed BN (not `^\d{9}RR\d{4}$`) | 47,338 (2.8%) |
| NULL `total_gifts` | 41,989 (2.5%) |
| Zero `total_gifts` | 1,464 |
| Negative `total_gifts` | 3,332 |
| NULL / empty `donee_name` | 835 |

**Mitigation.** 📝 Surfaced inside `cra.donee_name_quality` (C-3) but not
called out as a headline number in any existing script. ⚠️ Active for the
NULL-amount and NULL-BN cases specifically.

### C-6. `cra_directors` NULL rates

**What's wrong.** Several director fields are optional in the form but
heavily missing in the data. The impact is biggest for shared-director
detection (`last_name` + `first_name`) where even 0.1% missingness
silently drops cycles.

**Evidence.**
```sql
SELECT
  COUNT(*) AS total,
  COUNT(*) FILTER (WHERE last_name IS NULL OR TRIM(last_name)='') AS null_lastname,
  COUNT(*) FILTER (WHERE first_name IS NULL OR TRIM(first_name)='') AS null_firstname,
  COUNT(*) FILTER (WHERE at_arms_length IS NULL) AS null_arms_length,
  COUNT(*) FILTER (WHERE start_date IS NULL) AS null_start,
  COUNT(*) FILTER (WHERE end_date IS NULL) AS null_end
FROM cra.cra_directors;
```

| Field | NULL count | % of 2,873,624 |
|---|---:|---:|
| `last_name` | 670 | 0.02% |
| `first_name` | 3,193 | 0.11% |
| `at_arms_length` | 142,682 | 4.96% |
| `start_date` | 288,822 | 10.05% |
| `end_date` | 2,178,291 | 75.80% *(expected — currently serving)* |

**Mitigation.** 📝 `end_date` NULLs are expected (active directors). The
`at_arms_length` and `start_date` gaps are not. Documented here; no
mitigation yet. ⚠️ Active.

### C-7. Historical legal names are NOT preserved — only 1.4% of BNs show any name change

**What's wrong.** CRA appears to backfill the current legal name onto
every historical year of each BN. Only 1,308 of 91,129 BNs (1.4%) show
*any* `legal_name` variation across 2020–2024, so well-known rebrands
(Ryerson → Toronto Metropolitan, Grey Bruce Health Services → BrightShores,
Calgary Zoo Foundation → Wilder Institute, Toronto General & Western
Hospital Foundation → UHN Foundation, etc.) are mostly erased.

**Evidence.**
```sql
SELECT COUNT(DISTINCT bn) AS bns_with_history,
       COUNT(*) AS total_rows
FROM cra.identification_name_history;
-- bns_with_history 91,129, total_rows 92,437
-- => only 1,308 BNs show any variation
```

**Count:** 1,308 of 91,129 BNs (≈1.4%) show any `legal_name` variation;
the other 98.6% carry the same name across all five years even when the
organisation demonstrably rebranded.

**Source.** See
[`CRA/scripts/data-quality/03-identification-backfill-check.js`](CRA/scripts/data-quality/03-identification-backfill-check.js).

**Mitigation.** ✅ Surfaced in `cra.identification_name_history`; report
at
`CRA/data/reports/data-quality/identification-backfill-check.md`
quantifies the $-rescue for NAME_MISMATCH gifts if the history were
preserved (the answer — small — is itself the finding).

### C-8. 2024 T3010 form revision — the v24→v27 migration

**What's wrong.** The T3010 form was revised in 2024. Some fields only
exist in pre-2024 filings (`field_4180`, `field_5030`), and others
(`field_4101`, `field_4102`, `field_5045`, etc.) are only populated from
2023 onwards as early filers adopted v27. Users filtering by column
alone will see confusing zero/NULL patterns.

**Evidence.**
```sql
SELECT EXTRACT(YEAR FROM fpe)::int AS yr,
       COUNT(field_4180) AS has_4180_pre2024,
       COUNT(field_4101) AS has_4101_v27,
       COUNT(field_5045) AS has_5045_v27
FROM cra.cra_financial_details
GROUP BY yr ORDER BY yr;
```

| yr | 4180 (pre-2024) | 4101 (v27+) | 5045 (v27+) |
|---|---:|---:|---:|
| 2020 | 1,174 | 0 | 4 |
| 2021 | 1,313 | 0 | 19 |
| 2022 | 1,387 | 6 | 2,627 |
| 2023 | 645 | 20,819 | 7,725 |
| 2024 | **0** | 41,020 | 8,665 |

**Source.** CRA Open Data Dictionary v2.0 `formIds` metadata; see
[`CRA/scripts/data-quality/05-field-mapping-audit.js`](CRA/scripts/data-quality/05-field-mapping-audit.js).

**Mitigation.** ✅ `CRA/docs/DATA_DICTIONARY.md` already notes the 2024
schema refresh. `05-field-mapping-audit.js` diffs published JSON keys
vs the dictionary's `formIds` metadata.

### C-11. `cra_qualified_donees` — 20,192 well-formed donee BNs unregistered

**What's wrong.** Of rows whose `donee_bn` is a well-formed 15-char CRA
BN, 20,192 distinct values do not appear in `cra_identification`.

**Evidence.**
```sql
SELECT COUNT(DISTINCT donee_bn)
FROM cra.cra_qualified_donees qd
WHERE LENGTH(qd.donee_bn) = 15
  AND NOT EXISTS (SELECT 1 FROM cra.cra_identification i WHERE i.bn = qd.donee_bn);
-- 20,192
```

**Count:** 20,192 distinct "orphan" donee BNs (this is the UNREGISTERED_BN
bucket in C-3 on a per-distinct-BN basis).

**Source.** Most are legitimate — non-charity qualified donees (municipalities,
public universities, First Nations councils, UN agencies) and charities
whose registration was revoked or predates the 2020 coverage window. Only
a minority are typos.

**Mitigation.** ✅ Already covered in `cra.donee_name_quality` per C-3;
analysts joining `cra_qualified_donees → cra_identification` silently
drop ~1.2% of rows. Call this out in any query that performs that join.

---

## AB — Alberta Open Data (`ab.*`)

Every Alberta dataset is shipped as-is; no mitigation modifies source
rows.

### A-1. `ab_grants.fiscal_year` contaminated with calendar dates

**What's wrong.** 118 rows in the `"2023 - 2024"` fiscal year have
calendar-date strings in the `fiscal_year` column instead of the expected
`"YYYY - YYYY"` pattern (e.g. `"2023-04-06"`, `"2023-05-02"`). The
upstream MongoDB export shipped them this way.

**Evidence.**
```sql
SELECT COUNT(*) FROM ab.ab_grants WHERE fiscal_year ~ '^\d{4}-\d{2}-\d{2}$';
-- 118
```

**Count:** 118 rows.

**Source.** DB observation; upstream MongoDB export.

**Mitigation.** 📝 `AB/docs/DATA_DICTIONARY.md` tells analysts to use
`display_fiscal_year` (correct for these rows) instead of `fiscal_year`.

### A-2. `ab_grants.lottery` is boolean-as-text with no CHECK constraint

**What's wrong.** The column stores string literals `"True"` / `"False"`
rather than PostgreSQL booleans, and the schema doesn't constrain the
value set. If the upstream source ever shifts to `Y`/`N`, lowercase, or a
new value, queries using `WHERE lottery = 'True'` will silently miss
rows.

**Evidence.** Schema check:
```sql
\d ab.ab_grants  -- lottery is TEXT, no CHECK constraint
```

**Count:** today, only `"True"` / `"False"` observed — but this is not
enforced.

**Mitigation.** 📝 Documented in `AB/docs/DATA_DICTIONARY.md`. ⚠️ A
CHECK constraint could be added on the next schema rev.

### A-3. `ab_sole_source.special` — semantics undocumented by publisher

**What's wrong.** Boolean-as-text column with two observed values. The
Alberta government does not publicly document what the flag means.

**Evidence.**
```sql
SELECT special, COUNT(*) FROM ab.ab_sole_source GROUP BY special;
-- true 9,911 | false 5,622
```

**Mitigation.** 📝 Documented as opaque in `AB/docs/DATA_DICTIONARY.md`.
⚠️ Authoritative mapping still needed from Alberta Service Alberta.

### A-4. `ab_sole_source.permitted_situations` letter codes are not publicly keyed

**What's wrong.** The Alberta government publishes the twelve
"permitted situations" as a numbered list on
[alberta.ca/sole-source-contracts](https://www.alberta.ca/sole-source-contracts)
but does **not** publish a letter-to-number codebook for the `a`–`l`, `z`
codes that appear in the data.

**Evidence.**
```sql
SELECT permitted_situations, COUNT(*)
FROM ab.ab_sole_source
GROUP BY permitted_situations ORDER BY count DESC;
-- d 7,825 | b 3,570 | g 2,280 | j 967 | h 334 | z 307 | i 94 | k 74 | c 38 | l 38 | f 4 | a 2
```

**Mitigation.** 📝 `AB/docs/DATA_DICTIONARY.md` contains a
positional-inference table mapping `a`–`l` to the numbered list (1–12),
with a clear caveat that Alberta has not confirmed the mapping. `z` is
documented as "outside the twelve permitted situations" per the Alberta
page.

### A-5. `ab_grants` aggregation tables double-count if `aggregation_type` isn't filtered

**What's wrong.** `ab_grants_ministries` and `ab_grants_programs` contain
two kinds of rows: `by_fiscal_year` (annual subtotals) *and* `all_years`
(all-time rollups). Joining naively against `ab_grants_fiscal_years` or
treating the table as annual counts double-counts the all-time rollup
line.

**Evidence.**
```sql
SELECT aggregation_type, COUNT(*) FROM ab.ab_grants_ministries GROUP BY aggregation_type;
-- all_years 61 | by_fiscal_year 260
```

**Mitigation.** 📝 `AB/docs/DATA_DICTIONARY.md` explicitly warns to
filter `aggregation_type = 'by_fiscal_year'` for period analyses.

### A-6. `ab_grants.amount` — 43,604 negative rows totalling -$12B

**What's wrong.** Alberta's publishing convention: negative amounts are
reversals/corrections, not errors. That convention is documented by the
publisher. Analysts unaware of it will double-count reversals.

**Evidence.**
```sql
SELECT CASE WHEN amount<0 THEN 'neg' WHEN amount=0 THEN 'zero' ELSE 'pos' END,
       COUNT(*), ROUND(SUM(amount)::numeric,2)
FROM ab.ab_grants GROUP BY 1;
-- neg 43,604 (-$12,038,606,848.62) | zero 2,355 | pos 1,726,915 ($429,298,883,009.02)
```

**Count:** 43,604 negative rows summing to -$12.04B.

**Mitigation.** 📝 Documented in `AB/README.md`, `AB/CLAUDE.md`, and
`AB/docs/DATA_DICTIONARY.md`.

---

## Active / unmitigated

- **F-7** NFP/for-profit recipients missing BN (47,102 rows). No format validator at ingest.
- **F-8** Missing `agreement_end_date` (187,866 rows).
- **F-9** `agreement_end_date < agreement_start_date` (947 rows).
- **C-4** Raw NULL/malformed/zero/negative counts in `cra_qualified_donees` are not a headline in any script.
- **C-5** Four `cra_identification` columns are 100% NULL — schema should drop them or doc them.
- **C-6** `cra_directors` NULL rates for `at_arms_length` (5%), `start_date` (10%), `first_name` (0.1%) not surfaced.
- ~~**C-9** Loop-detection output tables empty with orphan rollup IDs~~ — ✅ resolved 2026-04-19 (see Changelog).
- **C-10** `cra_political_activity_funding` is empty — investigation needed.
- **A-2** `lottery` CHECK constraint not yet added.
- **A-3** `special` semantics still unsourced from Alberta.
- **A-4** `permitted_situations` letter→number mapping is positional inference; needs Alberta confirmation.

## How to update this document

When a new defect is proven:

1. Append an entry under the relevant dataset using the same five-field
   structure (**What's wrong / Evidence / Count / Source / Mitigation**).
2. Assign the next unused ID (`F-12`, `C-12`, `A-7`).
3. If you add a mitigation (view, constraint, doc, filter), flip the
   status to ✅ and link the artefact.
4. On each data snapshot refresh, re-run the Evidence queries and update
   the count in place. Move the prior number to the Changelog below.

Re-run paths:

- CRA: `cd CRA && npm run data-quality` → repopulates
  `cra.donee_name_quality`, `cra.t3010_impossibilities`,
  `cra.t3010_plausibility_flags`, `cra.identification_name_history` and
  their Markdown reports.
- FED: `cd FED && npm run verify` → prints F-1, F-2, F-4, F-5 counts.
- AB: `cd AB && npm run verify` → prints A-1 warnings.

## Changelog

### 2026-04-19

- Document created. Snapshot counts reflect the data as loaded on Render
  on this date. All FED counts calculated from 1,275,521 rows; CRA from
  421,866 `cra_identification` rows / 1,664,343 `cra_qualified_donees`
  rows / 420,849 financial filings; AB from 1,772,874 grant rows.
- Mitigations landed in this session: `fed.vw_agreement_current`,
  `fed.vw_agreement_originals`, `FED/docs/DATA_DICTIONARY.md` "How to
  sum" section, `FED/CLAUDE.md` Important Notes rewrite,
  `FED/scripts/05-verify.js` DQ reporters, `AB/docs/DATA_DICTIONARY.md`
  (new file).
- **C-9 resolved.** Ran `npm run analyze:full` against the Render DB
  after dropping all 13 loop/SCC/matrix/financial tables. Total wall
  clock ~4h 20min (6-hop cycle detection 2h 34min, Johnson on full graph
  1h 21min, matrix census 4m 52s, scorer 4m). New row counts —
  `loops` 5,808 (2-hop 508, 3-hop 236, 4-hop 472, 5-hop 1,161, 6-hop
  3,431), `loop_universe` 1,501 (all scored 0–23, top CANADA GIVES at
  23/30), `loop_participants` 30,003, `loop_edges` 53,771,
  `partitioned_cycles` 108, `identified_hubs` 20, `johnson_cycles`
  4,759, `matrix_census` 10,177, `scc_components` 10,177, `scc_summary`
  347. `loop_financials` now references `loops` 1:1 (no orphans).
- **Three permanent fixes landed so C-9 cannot recur silently.**
  (1) `migrate()` is now unconditional in `CRA/scripts/advanced/01`,
  `03`, `04`, `05`, `06` — removed the `--migrate` gate so future runs
  against a freshly dropped DB self-bootstrap.
  (2) `CRA/scripts/advanced/01-detect-all-loops.js` now declares the
  `score int` / `scored_at timestamptz` columns on `cra.loop_universe`
  and idempotently `ALTER TABLE ADD COLUMN IF NOT EXISTS`es them onto
  pre-existing DBs — previous schema drift caused `02-score-universe.js`
  to crash on the final write-back.
  (3) New `CRA/scripts/drop-loop-tables.js` + `npm run drop:loops` +
  `npm run analyze:full` supports a documented clean-slate re-run in
  dependency order (01 → 03 → 05 → 06 → 04 → 07 → 02). `CRA/README.md`
  and `CRA/CLAUDE.md` updated with the new commands.
