#!/usr/bin/env node
/**
 * audit-nobn-bridging.js — Audit whether our pipeline left no-BN cross-dataset
 * bridging gaps behind.
 *
 * We DON'T rescan 500K+ entities with trigram similarity (that's 2+ hours of
 * server work). Instead we use what the pipeline already produced:
 *   - general.entity_merge_candidates — every pair our detection tiers surfaced
 *   - general.cra_qualified_donees + general.entity_source_links — whether
 *     each qualified-donee row got linked to a golden record
 *
 * Checks:
 *   A) Of the candidate pairs where both sides are unmerged, no-BN, and in
 *      DIFFERENT datasets, how many got verdicts that rejected the merge?
 *      (And what's the trigram distribution of the "different" verdicts?)
 *   B) Distribution of candidate statuses for cross-dataset no-BN pairs.
 *   C) Qualified-donees BN + name data-quality breakdown.
 *   D) Linkage yield: of the qualified-donees rows, how many resolved to a
 *      golden record, and of the ones that didn't, how many had a usable name.
 */
const { pool } = require('../../../lib/db');

function pct(n, d) { return d ? (100 * n / d).toFixed(2) + '%' : 'n/a'; }

async function sectionA() {
  console.log('\n══════════════════════════════════════════════════════════════');
  console.log(' A) Cross-dataset no-BN pairs — verdict distribution');
  console.log('══════════════════════════════════════════════════════════════\n');

  const q = await pool.query(`
    SELECT c.status,
           COUNT(*)::int AS n,
           ROUND(AVG(c.similarity_score)::numeric, 3) AS avg_sim,
           ROUND(MIN(c.similarity_score)::numeric, 3) AS min_sim,
           ROUND(MAX(c.similarity_score)::numeric, 3) AS max_sim
    FROM general.entity_merge_candidates c
    JOIN general.entities a ON a.id = c.entity_id_a
    JOIN general.entities b ON b.id = c.entity_id_b
    WHERE a.merged_into IS NULL AND b.merged_into IS NULL
      AND a.bn_root IS NULL AND b.bn_root IS NULL
      AND a.dataset_sources != b.dataset_sources
      AND NOT (a.dataset_sources @> b.dataset_sources OR b.dataset_sources @> a.dataset_sources)
    GROUP BY c.status ORDER BY n DESC
  `);
  console.log('Status breakdown for cross-dataset no-BN candidate pairs (dataset_sources disjoint):');
  console.log('  status         count      avg_sim   min_sim   max_sim');
  q.rows.forEach(r =>
    console.log(`  ${(r.status || 'NULL').padEnd(14)} ${String(r.n).padStart(7)}   ${r.avg_sim || 'n/a'}     ${r.min_sim || 'n/a'}     ${r.max_sim || 'n/a'}`)
  );
}

async function sectionB() {
  console.log('\n══════════════════════════════════════════════════════════════');
  console.log(' B) Cross-dataset "different" verdicts — high-similarity flagged');
  console.log('══════════════════════════════════════════════════════════════\n');

  // Show candidate pairs the LLM rejected (status='different' with verdict='DIFFERENT')
  // where similarity was HIGH (>=0.85) — these deserve a second look.
  const q = await pool.query(`
    SELECT
      c.candidate_method,
      COUNT(*)::int AS n,
      COUNT(*) FILTER (WHERE c.similarity_score >= 0.95)::int AS sim_95_up,
      COUNT(*) FILTER (WHERE c.similarity_score >= 0.90 AND c.similarity_score < 0.95)::int AS sim_90_95,
      COUNT(*) FILTER (WHERE c.similarity_score >= 0.85 AND c.similarity_score < 0.90)::int AS sim_85_90
    FROM general.entity_merge_candidates c
    JOIN general.entities a ON a.id = c.entity_id_a
    JOIN general.entities b ON b.id = c.entity_id_b
    WHERE c.status = 'different'
      AND a.merged_into IS NULL AND b.merged_into IS NULL
      AND a.bn_root IS NULL AND b.bn_root IS NULL
      AND a.dataset_sources != b.dataset_sources
      AND NOT (a.dataset_sources @> b.dataset_sources OR b.dataset_sources @> a.dataset_sources)
    GROUP BY c.candidate_method ORDER BY n DESC
  `);
  console.log('"different" verdicts on cross-dataset no-BN pairs, by detection method:');
  console.log('  method           count   sim>=0.95  sim 0.90-0.95  sim 0.85-0.90');
  q.rows.forEach(r =>
    console.log(`  ${r.candidate_method.padEnd(16)} ${String(r.n).padStart(5)}   ${String(r.sim_95_up).padStart(8)}    ${String(r.sim_90_95).padStart(10)}     ${String(r.sim_85_90).padStart(10)}`)
  );

  // Top 20 examples where sim >= 0.90 but verdict was DIFFERENT
  const examples = await pool.query(`
    SELECT c.similarity_score, c.candidate_method,
           a.id AS a_id, a.canonical_name AS a_name, a.dataset_sources AS a_ds,
           b.id AS b_id, b.canonical_name AS b_name, b.dataset_sources AS b_ds,
           LEFT(COALESCE(c.llm_reasoning, ''), 120) AS reasoning
    FROM general.entity_merge_candidates c
    JOIN general.entities a ON a.id = c.entity_id_a
    JOIN general.entities b ON b.id = c.entity_id_b
    WHERE c.status = 'different'
      AND a.merged_into IS NULL AND b.merged_into IS NULL
      AND a.bn_root IS NULL AND b.bn_root IS NULL
      AND a.dataset_sources != b.dataset_sources
      AND NOT (a.dataset_sources @> b.dataset_sources OR b.dataset_sources @> a.dataset_sources)
      AND c.similarity_score >= 0.90
    ORDER BY c.similarity_score DESC LIMIT 20
  `);
  console.log(`\nTop 20 high-similarity "different" pairs (LLM said DIFFERENT but sim >= 0.90):`);
  examples.rows.forEach(r => {
    console.log(`  sim=${r.similarity_score} method=${r.candidate_method}`);
    console.log(`    [${r.a_ds}] id=${r.a_id} "${r.a_name}"`);
    console.log(`    [${r.b_ds}] id=${r.b_id} "${r.b_name}"`);
    if (r.reasoning) console.log(`    reasoning: ${r.reasoning}`);
  });
}

async function sectionC() {
  console.log('\n══════════════════════════════════════════════════════════════');
  console.log(' C) cra_qualified_donees BN + name data-quality breakdown');
  console.log('══════════════════════════════════════════════════════════════\n');

  const q = await pool.query(`
    SELECT
      COUNT(*)::bigint                                                                    AS total_rows,
      COUNT(*) FILTER (WHERE donee_bn IS NULL)::bigint                                     AS bn_null,
      COUNT(*) FILTER (WHERE donee_bn IS NOT NULL AND length(donee_bn) <> 15)::bigint      AS bn_wrong_len,
      COUNT(*) FILTER (WHERE donee_bn ~ '^0{9}')::bigint                                   AS bn_all_zero_root,
      COUNT(*) FILTER (WHERE donee_bn !~ '^[0-9]')::bigint                                 AS bn_nonnumeric_start,
      COUNT(*) FILTER (WHERE donee_name IS NULL OR length(trim(donee_name)) = 0)::bigint   AS name_empty,
      COUNT(*) FILTER (WHERE length(donee_name) < 5)::bigint                               AS name_too_short,
      COUNT(*) FILTER (WHERE lower(trim(donee_name)) IN (
        'toronto','canada','ontario','alberta','various','other','see schedule',
        'anonymous','individual','see attached','see below','n/a','na','unknown',
        'see note','misc','various individuals'))::bigint                                  AS name_garbage
    FROM cra.cra_qualified_donees qd
  `);
  const r = q.rows[0];
  const total = Number(r.total_rows);
  console.log(`Total qualified_donees rows: ${total.toLocaleString()}\n`);
  console.log('BN quality:');
  console.log(`  BN null:                     ${Number(r.bn_null).toLocaleString().padStart(12)}  (${pct(Number(r.bn_null), total)})`);
  console.log(`  BN wrong length (!=15):      ${Number(r.bn_wrong_len).toLocaleString().padStart(12)}  (${pct(Number(r.bn_wrong_len), total)})`);
  console.log(`  BN all-zero root:            ${Number(r.bn_all_zero_root).toLocaleString().padStart(12)}  (${pct(Number(r.bn_all_zero_root), total)})`);
  console.log(`  BN non-numeric start:        ${Number(r.bn_nonnumeric_start).toLocaleString().padStart(12)}  (${pct(Number(r.bn_nonnumeric_start), total)})`);
  console.log('\nName quality:');
  console.log(`  Name empty:                  ${Number(r.name_empty).toLocaleString().padStart(12)}  (${pct(Number(r.name_empty), total)})`);
  console.log(`  Name <5 chars:               ${Number(r.name_too_short).toLocaleString().padStart(12)}  (${pct(Number(r.name_too_short), total)})`);
  console.log(`  Name in garbage list:        ${Number(r.name_garbage).toLocaleString().padStart(12)}  (${pct(Number(r.name_garbage), total)})`);

  const garbage = await pool.query(`
    SELECT donee_name, COUNT(*)::int AS n, COUNT(DISTINCT donee_bn)::int AS distinct_bns,
           SUM(total_gifts)::numeric(18,0) AS total_gifts
    FROM cra.cra_qualified_donees
    WHERE (donee_name IS NULL OR length(trim(donee_name)) <= 5 OR lower(trim(donee_name)) IN (
      'toronto','canada','ontario','alberta','various','other','see schedule',
      'anonymous','individual','see attached','see below','n/a','na','unknown',
      'see note','misc','various individuals'))
    GROUP BY donee_name ORDER BY n DESC LIMIT 15
  `);
  console.log('\nTop "junk" donee_name values:');
  garbage.rows.forEach(x =>
    console.log(`  ${String(x.n).padStart(6)}× "${x.donee_name}" distinct_bns=${x.distinct_bns} total_gifts=$${Number(x.total_gifts).toLocaleString()}`)
  );
}

async function sectionD() {
  console.log('\n══════════════════════════════════════════════════════════════');
  console.log(' D) Donee-name-quality mismatch rollup (pre-computed table)');
  console.log('══════════════════════════════════════════════════════════════\n');

  const q = await pool.query(`
    SELECT mismatch_category, COUNT(*)::int AS n,
           SUM(citations)::int AS total_citations,
           SUM(total_gifts)::numeric(18,0) AS total_gifts
    FROM cra.donee_name_quality
    GROUP BY mismatch_category ORDER BY n DESC
  `);
  console.log('Pre-computed mismatch categories (cra.donee_name_quality):');
  console.log('  category                                 rows       citations  total_gifts');
  q.rows.forEach(x =>
    console.log(`  ${x.mismatch_category.padEnd(40)} ${String(x.n).padStart(8)}   ${String(x.total_citations).padStart(10)}   $${Number(x.total_gifts).toLocaleString().padStart(18)}`)
  );
}

async function sectionE() {
  console.log('\n══════════════════════════════════════════════════════════════');
  console.log(' E) Linkage yield: how many qualified-donees rows are reachable');
  console.log('══════════════════════════════════════════════════════════════\n');

  // Golden-record coverage of the DONEE side (not the filer side).
  // We resolve each qualified-donees row by (1) 9-digit BN root → golden record,
  // and (2) for rows that fail BN resolution, by exact norm_name → golden record.
  const q = await pool.query(`
    WITH qd AS (
      SELECT
        CASE WHEN donee_bn ~ '^[0-9]{9}' THEN LEFT(donee_bn, 9) ELSE NULL END AS root,
        donee_name
      FROM cra.cra_qualified_donees
    ),
    classified AS (
      SELECT
        CASE
          WHEN root IS NOT NULL AND EXISTS (
              SELECT 1 FROM general.entity_golden_records g WHERE g.bn_root = qd.root)
            THEN 'A_linkable_by_bn'
          WHEN donee_name IS NOT NULL AND length(trim(donee_name)) >= 5
               AND EXISTS (SELECT 1 FROM general.entity_golden_records g
                           WHERE g.norm_name = general.norm_name(qd.donee_name))
            THEN 'B_fallback_by_exact_norm'
          WHEN donee_name IS NOT NULL AND length(trim(donee_name)) >= 5
            THEN 'C_has_usable_name_no_match'
          ELSE 'D_unusable'
        END AS bucket
      FROM qd
    )
    SELECT bucket, COUNT(*)::int AS n FROM classified GROUP BY bucket ORDER BY bucket
  `);
  console.log('Donee-row linkage classification:');
  const total = q.rows.reduce((s, r) => s + r.n, 0);
  q.rows.forEach(r =>
    console.log(`  ${r.bucket.padEnd(30)} ${r.n.toLocaleString().padStart(12)}  (${pct(r.n, total)})`)
  );
  console.log(`  total                          ${total.toLocaleString().padStart(12)}`);

  // Of the C bucket — donee names without a BN match but with a usable name —
  // what do they look like? These are candidates for a name-only Phase 1c.
  const samples = await pool.query(`
    SELECT donee_name, COUNT(*)::int AS citations, SUM(total_gifts)::numeric(18,0) AS total_gifts
    FROM cra.cra_qualified_donees qd
    WHERE (qd.donee_bn IS NULL OR qd.donee_bn !~ '^[0-9]{9}'
           OR NOT EXISTS (SELECT 1 FROM general.entity_golden_records g
                          WHERE g.bn_root = LEFT(qd.donee_bn, 9)))
      AND donee_name IS NOT NULL AND length(trim(donee_name)) >= 5
      AND NOT EXISTS (SELECT 1 FROM general.entity_golden_records g
                      WHERE g.norm_name = general.norm_name(qd.donee_name))
    GROUP BY donee_name ORDER BY SUM(total_gifts) DESC NULLS LAST LIMIT 20
  `);
  console.log('\nTop unlinked donee names by total gift amount (these are the gap):');
  samples.rows.forEach(x =>
    console.log(`  $${Number(x.total_gifts || 0).toLocaleString().padStart(14)} ×${String(x.citations).padStart(5)} "${x.donee_name}"`)
  );
}

async function main() {
  try {
    await sectionA();
    await sectionB();
    await sectionC();
    await sectionD();
    await sectionE();
  } finally {
    await pool.end();
  }
}

main().catch(e => { console.error('FATAL:', e.message); console.error(e.stack); process.exit(1); });
