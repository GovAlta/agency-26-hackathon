-- ============================================================================
-- AI For Accountability - Sample Analytical Queries
-- Federal Grants and Contributions (1.275M records, all fiscal years)
--
-- These queries are ready to run against the loaded database.
-- Copy/paste into any PostgreSQL client (psql, DBeaver, pgAdmin, etc.)
--
-- Schema: fed.*  |  Main table: fed.grants_contributions
--
-- IMPORTANT: agreement_value is a cumulative snapshot per amendment, NOT a
-- delta (TBS spec: "total grant or contribution value, not the change in
-- agreement value"). A naive SUM over all rows double- or triple-counts
-- amended agreements. Use one of these three approaches, picking the one
-- that matches your question:
--
--   * Current total commitment per agreement → fed.vw_agreement_current
--   * Initial commitment only                → fed.vw_agreement_originals
--                                              or WHERE is_amendment = false
--   * Every snapshot (rare)                  → base table, no filter
--
-- See docs/DATA_DICTIONARY.md section "How to sum agreement_value correctly"
-- for the full sum comparison (~$533B / $816B / $921B) and rationale.
-- ============================================================================

-- ── 0. CHOOSING THE RIGHT VIEW ─────────────────────────────────────────────

-- 0a. Three ways of summing agreement_value, side-by-side. Useful for
--     convincing yourself the amendment semantics matter.
SELECT
  (SELECT ROUND(SUM(agreement_value)::numeric, 0)
     FROM fed.grants_contributions)                     AS sum_all_rows_wrong,
  (SELECT ROUND(SUM(agreement_value)::numeric, 0)
     FROM fed.vw_agreement_originals)                   AS sum_originals_only,
  (SELECT ROUND(SUM(agreement_value)::numeric, 0)
     FROM fed.vw_agreement_current)                     AS sum_current_commitment;

-- 0b. For any specific agreement, show every snapshot the publisher has
--     recorded against it. Useful for verifying amendment patterns.
SELECT _id, amendment_number, amendment_date,
       agreement_value, recipient_legal_name, is_amendment
FROM fed.grants_contributions
WHERE ref_number = '001-2020-2021-Q1-00006'
ORDER BY NULLIF(regexp_replace(amendment_number, '\D', '', 'g'), '')::int NULLS FIRST;



-- ── 1. SEARCH & DISCOVERY ──────────────────────────────────────────────────

-- 1a. Search grants by recipient name (fuzzy)
SELECT _id, recipient_legal_name, owner_org_title,
       agreement_type, agreement_value,
       agreement_start_date, recipient_province
FROM fed.grants_contributions
WHERE recipient_legal_name ILIKE '%university of alberta%'
  AND is_amendment = false
ORDER BY agreement_value DESC
LIMIT 25;

-- 1b. Search grants by program name
SELECT prog_name_en, COUNT(*) AS grants,
       SUM(agreement_value) AS total_value,
       COUNT(DISTINCT owner_org) AS departments
FROM fed.grants_contributions
WHERE prog_name_en ILIKE '%innovation%'
  AND is_amendment = false
GROUP BY prog_name_en
ORDER BY total_value DESC
LIMIT 25;

-- 1c. Full-text search on recipient names (faster than ILIKE for large scans)
SELECT recipient_legal_name, owner_org_title, agreement_value,
       agreement_start_date, recipient_province
FROM fed.grants_contributions
WHERE to_tsvector('english', COALESCE(recipient_legal_name, ''))
      @@ to_tsquery('english', 'first & nation')
  AND is_amendment = false
ORDER BY agreement_value DESC
LIMIT 25;

-- 1d. Look up a specific grant by reference number
SELECT * FROM fed.vw_grants_decoded
WHERE ref_number = '127-2023-2024-Q1-00001';


-- ── 2. SUMMARY BY AGREEMENT TYPE ───────────────────────────────────────────

-- 2a. Overall breakdown by agreement type
SELECT atl.name_en AS agreement_type,
       COUNT(*) AS grant_count,
       SUM(gc.agreement_value) AS total_value,
       ROUND(AVG(gc.agreement_value), 2) AS avg_value,
       MIN(gc.agreement_value) AS min_value,
       MAX(gc.agreement_value) AS max_value
FROM fed.grants_contributions gc
JOIN fed.agreement_type_lookup atl ON gc.agreement_type = atl.code
WHERE gc.is_amendment = false
GROUP BY atl.name_en
ORDER BY total_value DESC;

-- 2b. Grants vs Contributions: count and value by fiscal year
SELECT EXTRACT(YEAR FROM agreement_start_date) AS fiscal_year,
       agreement_type,
       COUNT(*) AS grant_count,
       ROUND(SUM(agreement_value) / 1e9, 2) AS total_billions
FROM fed.grants_contributions
WHERE agreement_start_date IS NOT NULL AND is_amendment = false
GROUP BY 1, 2
ORDER BY 1, 2;


-- ── 3. DEPARTMENT / ORGANIZATION ANALYSIS ──────────────────────────────────

-- 3a. Top 25 departments by total grant value (originals only)
SELECT owner_org_title,
       COUNT(*) AS grant_count,
       ROUND(SUM(agreement_value) / 1e9, 2) AS total_billions,
       ROUND(AVG(agreement_value), 0) AS avg_value,
       COUNT(DISTINCT recipient_legal_name) AS unique_recipients
FROM fed.grants_contributions
WHERE is_amendment = false AND agreement_value > 0
GROUP BY owner_org_title
ORDER BY SUM(agreement_value) DESC
LIMIT 25;

-- 3b. Department spending by agreement type
SELECT owner_org_title,
       SUM(CASE WHEN agreement_type = 'G' THEN agreement_value ELSE 0 END) AS grants_total,
       SUM(CASE WHEN agreement_type = 'C' THEN agreement_value ELSE 0 END) AS contributions_total,
       SUM(CASE WHEN agreement_type = 'O' THEN agreement_value ELSE 0 END) AS other_total,
       SUM(agreement_value) AS grand_total
FROM fed.grants_contributions
WHERE is_amendment = false AND agreement_value > 0
GROUP BY owner_org_title
ORDER BY grand_total DESC
LIMIT 25;

-- 3c. Department spending trend over time
SELECT owner_org_title,
       EXTRACT(YEAR FROM agreement_start_date) AS year,
       COUNT(*) AS grants,
       ROUND(SUM(agreement_value) / 1e6, 1) AS total_millions
FROM fed.grants_contributions
WHERE agreement_start_date IS NOT NULL
  AND is_amendment = false
  AND owner_org_title IS NOT NULL
GROUP BY owner_org_title, EXTRACT(YEAR FROM agreement_start_date)
ORDER BY owner_org_title, year;

-- 3d. Departments with the highest average grant value
SELECT owner_org_title,
       COUNT(*) AS grant_count,
       ROUND(AVG(agreement_value), 0) AS avg_value,
       ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY agreement_value), 0) AS median_value
FROM fed.grants_contributions
WHERE is_amendment = false AND agreement_value > 0
GROUP BY owner_org_title
HAVING COUNT(*) >= 100
ORDER BY avg_value DESC
LIMIT 25;


-- ── 4. RECIPIENT ANALYSIS ──────────────────────────────────────────────────

-- 4a. Top 25 recipients by total value received
SELECT recipient_legal_name,
       recipient_province,
       COUNT(*) AS grant_count,
       COUNT(DISTINCT owner_org) AS departments_funded_by,
       ROUND(SUM(agreement_value) / 1e9, 2) AS total_billions,
       MIN(agreement_start_date) AS earliest,
       MAX(agreement_start_date) AS latest
FROM fed.grants_contributions
WHERE is_amendment = false AND agreement_value > 0
  AND recipient_legal_name IS NOT NULL
GROUP BY recipient_legal_name, recipient_province
ORDER BY SUM(agreement_value) DESC
LIMIT 25;

-- 4b. Recipient type distribution
SELECT rtl.name_en AS recipient_type,
       COUNT(*) AS grant_count,
       ROUND(SUM(gc.agreement_value) / 1e9, 2) AS total_billions,
       ROUND(AVG(gc.agreement_value), 0) AS avg_value
FROM fed.grants_contributions gc
JOIN fed.recipient_type_lookup rtl ON gc.recipient_type = rtl.code
WHERE gc.is_amendment = false
GROUP BY rtl.name_en
ORDER BY SUM(gc.agreement_value) DESC;

-- 4c. Recipients receiving from the most departments (wide reach)
SELECT recipient_legal_name,
       COUNT(DISTINCT owner_org) AS department_count,
       COUNT(*) AS total_grants,
       ROUND(SUM(agreement_value) / 1e6, 1) AS total_millions
FROM fed.grants_contributions
WHERE is_amendment = false AND recipient_legal_name IS NOT NULL
GROUP BY recipient_legal_name
HAVING COUNT(DISTINCT owner_org) >= 5
ORDER BY department_count DESC
LIMIT 25;

-- 4d. Recipients by business number (aggregate across name variations)
SELECT recipient_business_number,
       COUNT(DISTINCT recipient_legal_name) AS name_variations,
       ARRAY_AGG(DISTINCT recipient_legal_name) AS names,
       COUNT(*) AS grant_count,
       ROUND(SUM(agreement_value) / 1e6, 1) AS total_millions
FROM fed.grants_contributions
WHERE is_amendment = false
  AND recipient_business_number IS NOT NULL
  AND recipient_business_number != ''
GROUP BY recipient_business_number
HAVING COUNT(DISTINCT recipient_legal_name) > 1
ORDER BY total_millions DESC
LIMIT 25;


-- ── 5. GEOGRAPHIC ANALYSIS ─────────────────────────────────────────────────

-- 5a. Grants by province (using decoded view)
SELECT * FROM fed.vw_grants_by_province;

-- 5b. Top 25 cities by total grant value
SELECT recipient_city, recipient_province,
       COUNT(*) AS grant_count,
       ROUND(SUM(agreement_value) / 1e9, 2) AS total_billions
FROM fed.grants_contributions
WHERE is_amendment = false AND recipient_city IS NOT NULL
GROUP BY recipient_city, recipient_province
ORDER BY SUM(agreement_value) DESC
LIMIT 25;

-- 5c. Federal riding analysis (top ridings by grant value)
SELECT federal_riding_name_en, federal_riding_number,
       recipient_province,
       COUNT(*) AS grant_count,
       ROUND(SUM(agreement_value) / 1e6, 1) AS total_millions,
       COUNT(DISTINCT owner_org) AS departments
FROM fed.grants_contributions
WHERE is_amendment = false
  AND federal_riding_name_en IS NOT NULL
GROUP BY federal_riding_name_en, federal_riding_number, recipient_province
ORDER BY SUM(agreement_value) DESC
LIMIT 25;

-- 5d. International grants (non-Canada recipients)
SELECT cl.name_en AS country,
       COUNT(*) AS grant_count,
       ROUND(SUM(gc.agreement_value) / 1e6, 1) AS total_millions,
       COUNT(DISTINCT gc.owner_org) AS departments
FROM fed.grants_contributions gc
JOIN fed.country_lookup cl ON gc.recipient_country = cl.code
WHERE gc.is_amendment = false
  AND gc.recipient_country != 'CA'
  AND gc.recipient_country IS NOT NULL
GROUP BY cl.name_en
ORDER BY SUM(gc.agreement_value) DESC
LIMIT 25;

-- 5e. Province-level per-capita style comparison (grants per province)
SELECT pl.name_en AS province,
       COUNT(*) AS grant_count,
       ROUND(SUM(gc.agreement_value) / 1e9, 2) AS total_billions,
       ROUND(AVG(gc.agreement_value), 0) AS avg_value,
       COUNT(DISTINCT gc.owner_org) AS departments,
       COUNT(DISTINCT gc.recipient_legal_name) AS unique_recipients
FROM fed.grants_contributions gc
JOIN fed.province_lookup pl ON gc.recipient_province = pl.code
WHERE gc.is_amendment = false
GROUP BY pl.name_en
ORDER BY total_billions DESC;


-- ── 6. PROGRAM ANALYSIS ───────────────────────────────────────────────────

-- 6a. Top 25 programs by total value
SELECT prog_name_en,
       COUNT(*) AS grant_count,
       ROUND(SUM(agreement_value) / 1e9, 2) AS total_billions,
       COUNT(DISTINCT recipient_legal_name) AS unique_recipients,
       COUNT(DISTINCT owner_org) AS departments
FROM fed.grants_contributions
WHERE is_amendment = false AND prog_name_en IS NOT NULL
GROUP BY prog_name_en
ORDER BY SUM(agreement_value) DESC
LIMIT 25;

-- 6b. Program purpose full-text search
SELECT prog_name_en, prog_purpose_en,
       COUNT(*) AS grants,
       ROUND(SUM(agreement_value) / 1e6, 1) AS total_millions
FROM fed.grants_contributions
WHERE to_tsvector('english', COALESCE(prog_purpose_en, ''))
      @@ to_tsquery('english', 'climate & change')
  AND is_amendment = false
GROUP BY prog_name_en, prog_purpose_en
ORDER BY total_millions DESC
LIMIT 25;

-- 6c. Programs with the most recipients
SELECT prog_name_en,
       owner_org_title,
       COUNT(DISTINCT recipient_legal_name) AS recipient_count,
       COUNT(*) AS grants,
       ROUND(SUM(agreement_value) / 1e6, 1) AS total_millions
FROM fed.grants_contributions
WHERE is_amendment = false AND prog_name_en IS NOT NULL
GROUP BY prog_name_en, owner_org_title
ORDER BY recipient_count DESC
LIMIT 25;

-- 6d. NAICS industry breakdown
SELECT naics_identifier,
       COUNT(*) AS grant_count,
       ROUND(SUM(agreement_value) / 1e6, 1) AS total_millions
FROM fed.grants_contributions
WHERE is_amendment = false
  AND naics_identifier IS NOT NULL
  AND naics_identifier != ''
GROUP BY naics_identifier
ORDER BY total_millions DESC
LIMIT 25;


-- ── 7. TREND & CROSS-YEAR ANALYSIS ────────────────────────────────────────

-- 7a. Total federal spending by year
SELECT EXTRACT(YEAR FROM agreement_start_date) AS year,
       COUNT(*) AS grants,
       ROUND(SUM(agreement_value) / 1e9, 2) AS total_billions,
       ROUND(AVG(agreement_value), 0) AS avg_value
FROM fed.grants_contributions
WHERE agreement_start_date IS NOT NULL AND is_amendment = false
GROUP BY EXTRACT(YEAR FROM agreement_start_date)
ORDER BY year;

-- 7b. Year-over-year growth by department
WITH yearly AS (
  SELECT owner_org_title,
         EXTRACT(YEAR FROM agreement_start_date) AS year,
         SUM(agreement_value) AS total
  FROM fed.grants_contributions
  WHERE agreement_start_date IS NOT NULL AND is_amendment = false
  GROUP BY owner_org_title, EXTRACT(YEAR FROM agreement_start_date)
)
SELECT y2.owner_org_title,
       y1.year AS year_prior,
       y2.year AS year_current,
       ROUND(y1.total / 1e6, 1) AS prior_millions,
       ROUND(y2.total / 1e6, 1) AS current_millions,
       ROUND((y2.total - y1.total) / NULLIF(y1.total, 0) * 100, 1) AS growth_pct
FROM yearly y2
JOIN yearly y1 ON y2.owner_org_title = y1.owner_org_title
  AND y2.year = y1.year + 1
WHERE y1.total > 1000000 AND y2.total > 1000000
ORDER BY growth_pct DESC
LIMIT 25;

-- 7c. New recipients appearing each year
WITH first_appearance AS (
  SELECT recipient_legal_name,
         MIN(EXTRACT(YEAR FROM agreement_start_date)) AS first_year
  FROM fed.grants_contributions
  WHERE agreement_start_date IS NOT NULL AND is_amendment = false
  GROUP BY recipient_legal_name
)
SELECT first_year, COUNT(*) AS new_recipients
FROM first_appearance
WHERE first_year IS NOT NULL
GROUP BY first_year
ORDER BY first_year;

-- 7d. Recipient loyalty: recipients appearing across many years
SELECT recipient_legal_name,
       COUNT(DISTINCT EXTRACT(YEAR FROM agreement_start_date)) AS years_active,
       COUNT(*) AS total_grants,
       ROUND(SUM(agreement_value) / 1e6, 1) AS total_millions,
       MIN(agreement_start_date) AS first_grant,
       MAX(agreement_start_date) AS last_grant
FROM fed.grants_contributions
WHERE is_amendment = false AND agreement_start_date IS NOT NULL
GROUP BY recipient_legal_name
HAVING COUNT(DISTINCT EXTRACT(YEAR FROM agreement_start_date)) >= 10
ORDER BY total_millions DESC
LIMIT 25;


-- ── 8. AMENDMENT ANALYSIS ─────────────────────────────────────────────────

-- 8a. Amendment overview
SELECT is_amendment,
       COUNT(*) AS record_count,
       SUM(CASE WHEN agreement_value >= 0 THEN agreement_value ELSE 0 END) AS positive_value,
       SUM(CASE WHEN agreement_value < 0 THEN agreement_value ELSE 0 END) AS negative_value,
       SUM(agreement_value) AS net_value
FROM fed.grants_contributions
GROUP BY is_amendment;

-- 8b. Most amended grants (by ref_number)
SELECT ref_number,
       recipient_legal_name,
       owner_org_title,
       COUNT(*) AS amendment_count,
       SUM(agreement_value) AS net_value
FROM fed.grants_contributions
WHERE ref_number IS NOT NULL
GROUP BY ref_number, recipient_legal_name, owner_org_title
HAVING COUNT(*) > 5
ORDER BY amendment_count DESC
LIMIT 25;

-- 8c. Largest negative amendments (biggest reductions)
SELECT ref_number, amendment_number,
       recipient_legal_name, owner_org_title,
       agreement_value, amendment_date,
       agreement_title_en
FROM fed.grants_contributions
WHERE agreement_value < 0
ORDER BY agreement_value ASC
LIMIT 25;


-- ── 9. DATA QUALITY & EXPLORATION ─────────────────────────────────────────

-- 9a. Overall dataset stats
SELECT COUNT(*) AS total_records,
       COUNT(*) FILTER (WHERE is_amendment = false) AS originals,
       COUNT(*) FILTER (WHERE is_amendment = true) AS amendments,
       COUNT(DISTINCT owner_org) AS departments,
       COUNT(DISTINCT recipient_legal_name) AS unique_recipients,
       COUNT(DISTINCT recipient_province) AS provinces,
       COUNT(DISTINCT prog_name_en) AS programs,
       MIN(agreement_start_date) AS earliest_date,
       MAX(agreement_start_date) AS latest_date
FROM fed.grants_contributions;

-- 9b. Null rate for key fields (data completeness)
SELECT COUNT(*) AS total,
       ROUND(COUNT(agreement_type)::numeric / COUNT(*) * 100, 1) AS pct_agreement_type,
       ROUND(COUNT(recipient_type)::numeric / COUNT(*) * 100, 1) AS pct_recipient_type,
       ROUND(COUNT(recipient_province)::numeric / COUNT(*) * 100, 1) AS pct_province,
       ROUND(COUNT(agreement_value)::numeric / COUNT(*) * 100, 1) AS pct_value,
       ROUND(COUNT(agreement_start_date)::numeric / COUNT(*) * 100, 1) AS pct_start_date,
       ROUND(COUNT(prog_name_en)::numeric / COUNT(*) * 100, 1) AS pct_program,
       ROUND(COUNT(federal_riding_number)::numeric / COUNT(*) * 100, 1) AS pct_riding,
       ROUND(COUNT(naics_identifier)::numeric / COUNT(*) * 100, 1) AS pct_naics,
       ROUND(COUNT(recipient_business_number)::numeric / COUNT(*) * 100, 1) AS pct_bn
FROM fed.grants_contributions;

-- 9c. Row counts by year
SELECT EXTRACT(YEAR FROM agreement_start_date) AS year,
       COUNT(*) AS total,
       COUNT(*) FILTER (WHERE is_amendment = false) AS originals,
       COUNT(*) FILTER (WHERE is_amendment = true) AS amendments
FROM fed.grants_contributions
WHERE agreement_start_date IS NOT NULL
GROUP BY EXTRACT(YEAR FROM agreement_start_date)
ORDER BY year;

-- 9d. Agreement value distribution (histogram buckets)
SELECT
  CASE
    WHEN agreement_value < 0 THEN 'Negative'
    WHEN agreement_value = 0 THEN 'Zero'
    WHEN agreement_value < 10000 THEN '$0-$10K'
    WHEN agreement_value < 100000 THEN '$10K-$100K'
    WHEN agreement_value < 1000000 THEN '$100K-$1M'
    WHEN agreement_value < 10000000 THEN '$1M-$10M'
    WHEN agreement_value < 100000000 THEN '$10M-$100M'
    ELSE '$100M+'
  END AS value_bucket,
  COUNT(*) AS grant_count,
  ROUND(SUM(agreement_value) / 1e9, 2) AS total_billions
FROM fed.grants_contributions
WHERE is_amendment = false
GROUP BY 1
ORDER BY MIN(agreement_value);
