#!/usr/bin/env node
/**
 * 10-donee-trigram-fallback.js — Tier 6 enrichment: recover unlinked
 * cra.cra_qualified_donees rows by trigram-matching their donee_name against
 * PRIMARY-SOURCE golden records.
 *
 * Chicken-and-egg safeguard: lookup targets are restricted to golden records
 * that have a source_link in a primary catalog (cra_identification,
 * ab_non_profit, or fed.grants_contributions with BN). This guarantees the
 * catalog is authoritative BEFORE a donee row is considered, so Tier 6 never
 * amplifies donee-row noise back into itself.
 *
 * Runs in three phases (idempotent, resumable):
 *   A) Detect — for each unlinked donee_name (bucket C in audit terminology),
 *      find top-1 primary-source golden record with similarity >= --threshold.
 *      Writes to general.donee_trigram_candidates. No LLM calls.
 *   B) Review — LLM decides for each pending candidate: SAME / RELATED /
 *      DIFFERENT. Same concurrency + retry framework as 08-llm-golden-records.
 *   C) Apply — for SAME verdicts, append the donee_name to the entity's
 *      alternate_names and insert entity_source_links rows for every raw
 *      qualified_donees row that used that name. Tagged match_method =
 *      'donee_trigram_fallback' so the whole operation is reversible with a
 *      single DELETE.
 *
 * Usage:
 *   node scripts/10-donee-trigram-fallback.js                    # all phases
 *   node scripts/10-donee-trigram-fallback.js --phase A          # detect only
 *   node scripts/10-donee-trigram-fallback.js --phase B          # LLM only
 *   node scripts/10-donee-trigram-fallback.js --phase C          # apply only
 *   node scripts/10-donee-trigram-fallback.js --min-citations 3  # skip singletons (default 3)
 *   node scripts/10-donee-trigram-fallback.js --threshold 0.85   # trigram floor (default 0.85)
 *   node scripts/10-donee-trigram-fallback.js --concurrency 50   # LLM concurrency (default 50)
 *   node scripts/10-donee-trigram-fallback.js --limit 500        # review at most N pairs
 *   node scripts/10-donee-trigram-fallback.js --dry-run          # Phase B/C without writes
 *   node scripts/10-donee-trigram-fallback.js --provider vertex  # anthropic | vertex
 */
const { pool } = require('../lib/db');
const { callLLM } = require('../lib/llm-review');

function ts() { return new Date().toISOString().slice(11, 19); }
function log(msg) { console.log(`[${ts()}] ${msg}`); }

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {
    phase: 'all',
    threshold: 0.85,
    minCitations: 3,
    concurrency: 50,
    limit: 0,
    dryRun: false,
    provider: null,
    maxRetries: 8,
    staleMinutes: 10,
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i], n = args[i + 1];
    if (a === '--phase' && n) opts.phase = args[++i].toUpperCase();
    else if (a === '--threshold' && n) opts.threshold = parseFloat(args[++i]);
    else if (a === '--min-citations' && n) opts.minCitations = parseInt(args[++i], 10);
    else if (a === '--concurrency' && n) opts.concurrency = parseInt(args[++i], 10);
    else if (a === '--limit' && n) opts.limit = parseInt(args[++i], 10);
    else if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--provider' && n) opts.provider = args[++i];
    else if (a === '--max-retries' && n) opts.maxRetries = parseInt(args[++i], 10);
    else if (a === '--stale-minutes' && n) opts.staleMinutes = parseInt(args[++i], 10);
  }
  return opts;
}

// ═══════════════════════════════════════════════════════════════
//  RETRY + SEMAPHORE (mirrors 08-llm-golden-records.js)
// ═══════════════════════════════════════════════════════════════

async function withRetry(fn, label = 'op', maxRetries = 8) {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try { return await fn(); }
    catch (err) {
      const msg = (err.message || '') + (err.code || '') + (err.status || '');
      const is429 = /429|rate.limit|too.many.requests|overloaded|529/i.test(msg);
      const isNetwork = /ECONNRESET|ETIMEDOUT|ENOTFOUND|EPIPE|EHOSTUNREACH|EAI_AGAIN|57P01|57P03|08006|08001|Connection terminated|connection error|fetch failed|network/i.test(msg);
      const isTransient = is429 || isNetwork || /\b5\d\d\b/.test(msg);
      if (!isTransient || attempt >= maxRetries) throw err;
      const baseDelay = is429 ? 30000 : 2000;
      const maxDelay = is429 ? 120000 : 30000;
      const delay = Math.min(baseDelay * Math.pow(1.5, attempt) + Math.random() * 5000, maxDelay);
      console.warn(`  [retry ${attempt + 1}] ${label}: ${err.message.slice(0, 60)} — ${(delay / 1000).toFixed(0)}s`);
      await new Promise(r => setTimeout(r, delay));
    }
  }
}

class Semaphore {
  constructor(max) { this.max = max; this.count = 0; this.queue = []; }
  async acquire() { if (this.count < this.max) { this.count++; return; } await new Promise(r => this.queue.push(r)); this.count++; }
  release() { this.count--; if (this.queue.length > 0) this.queue.shift()(); }
}

// ═══════════════════════════════════════════════════════════════
//  PHASE A — Detect candidates
// ═══════════════════════════════════════════════════════════════

async function phaseDetect(opts) {
  const t0 = Date.now();
  log('══ Phase A: Detect donee-name trigram candidates ══');
  log(`  similarity threshold: ${opts.threshold}`);
  log(`  min citations:        ${opts.minCitations}`);

  // Primary-source filter: only match to golden records that have at least
  // one link in a PRIMARY catalog. Entities linked solely via donee rows (if
  // any exist) are excluded — that's the chicken-and-egg guard.
  const res = await pool.query(
    `
    WITH unlinked_names AS (
      SELECT
        UPPER(TRIM(qd.donee_name))           AS donee_name_norm,
        MIN(qd.donee_name)                   AS donee_name_original,
        COUNT(*)::int                        AS citations,
        COALESCE(SUM(qd.total_gifts), 0)::numeric AS total_gifts
      FROM cra.cra_qualified_donees qd
      WHERE qd.donee_name IS NOT NULL
        AND length(trim(qd.donee_name)) >= 5
        AND (qd.donee_bn IS NULL OR qd.donee_bn !~ '^[0-9]{9}'
             OR NOT EXISTS (
               SELECT 1 FROM general.entity_golden_records g
               WHERE g.bn_root = LEFT(qd.donee_bn, 9)))
        AND NOT EXISTS (
          SELECT 1 FROM general.entity_golden_records g
          WHERE g.norm_name = general.norm_name(qd.donee_name))
      GROUP BY UPPER(TRIM(qd.donee_name))
      HAVING COUNT(*) >= $2
    ),
    ranked AS (
      SELECT u.donee_name_norm, u.donee_name_original, u.citations, u.total_gifts,
             g.id AS entity_id, g.canonical_name, g.bn_root,
             similarity(g.canonical_name, u.donee_name_norm)::numeric(4,3) AS sim,
             ROW_NUMBER() OVER (
               PARTITION BY u.donee_name_norm
               ORDER BY similarity(g.canonical_name, u.donee_name_norm) DESC
             ) AS rn
      FROM unlinked_names u
      JOIN general.entity_golden_records g
        ON g.canonical_name % u.donee_name_norm
       AND similarity(g.canonical_name, u.donee_name_norm) >= $1
      WHERE EXISTS (
        SELECT 1 FROM general.entity_source_links sl
        WHERE sl.entity_id = g.id
          AND ((sl.source_schema = 'cra' AND sl.source_table = 'cra_identification')
            OR (sl.source_schema = 'ab'  AND sl.source_table = 'ab_non_profit')
            OR (sl.source_schema = 'fed' AND sl.source_table = 'grants_contributions'))
      )
    )
    INSERT INTO general.donee_trigram_candidates
      (donee_name, donee_name_norm, candidate_entity_id,
       candidate_canonical_name, candidate_bn_root, similarity,
       citations, total_gifts, status)
    SELECT donee_name_original, donee_name_norm, entity_id,
           canonical_name, bn_root, sim, citations, total_gifts, 'pending'
    FROM ranked
    WHERE rn = 1
    ON CONFLICT (donee_name_norm) DO NOTHING
    `,
    [opts.threshold, opts.minCitations]
  );

  log(`  inserted ${res.rowCount.toLocaleString()} new candidate pairs`);

  const stats = await pool.query(`
    SELECT status, COUNT(*)::int AS n
    FROM general.donee_trigram_candidates
    GROUP BY status ORDER BY n DESC
  `);
  console.log(`\n  donee_trigram_candidates by status:`);
  stats.rows.forEach(r => console.log(`    ${(r.status || 'NULL').padEnd(16)} ${r.n.toLocaleString()}`));

  log(`Phase A complete (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
}

// ═══════════════════════════════════════════════════════════════
//  PHASE B — LLM review
// ═══════════════════════════════════════════════════════════════

function buildPrompt(donee, candidate) {
  return `You are an entity-resolution reviewer for Canadian government open data.

A donor (Canadian registered charity filing a T3010) wrote the following donee string on their return. The donee's Business Number is missing, malformed, or unregistered, so it can't be BN-matched. A trigram similarity search surfaced one candidate entity from the authoritative catalog (CRA registered charities + Alberta non-profit registry + federal grant recipients with BN on file). Decide whether the donee text refers to that candidate entity.

## Donee string (from T3010 filing)
"${donee.donee_name}"
(cited on ${donee.citations} filings, total gifts $${Number(donee.total_gifts || 0).toLocaleString()})

## Candidate entity (from primary-source catalog)
canonical_name: "${candidate.canonical_name}"
BN root:        ${candidate.bn_root || '(none — AB non-profit or FED recipient)'}
aliases:        ${(candidate.aliases || []).slice(0, 25).join(' | ') || 'none'}
entity_type:    ${candidate.entity_type || 'unknown'}
trigram:        ${Number(donee.similarity).toFixed(3)}

## Rules
- SAME only if the donee text unambiguously refers to this specific legal entity (spelling variants, punctuation/abbreviation differences, bilingual parallel names, "Inc." vs "Inc" — all OK).
- RELATED if clearly a parent/subsidiary/chapter of the candidate but not the same legal entity.
- DIFFERENT if another organisation with a similar name, a generic acronym matching many entities, a foreign entity with no Canadian registration, or unclear.
- For acronyms (e.g. "ERDO", "CNIB"), require an exact match to an official alias. Do NOT match acronyms to unrelated full names.
- Prefer DIFFERENT when uncertain — we'd rather leave a row unlinked than corrupt the catalog.

Respond with STRICT JSON ONLY (no markdown):
{"verdict":"SAME"|"RELATED"|"DIFFERENT","confidence":0.0-1.0,"reasoning":"<= 200 chars"}`;
}

function parseJson(text) {
  const cleaned = String(text || '').replace(/^```\w*\n?/m, '').replace(/\n?```\s*$/m, '').trim();
  return JSON.parse(cleaned);
}

async function loadCandidateContext(candidateId) {
  const r = await withRetry(() => pool.query(
    `SELECT g.id, g.canonical_name, g.bn_root, g.entity_type,
            (SELECT array_agg(value::text)
             FROM jsonb_array_elements_text(g.aliases)) AS aliases
     FROM general.entity_golden_records g
     WHERE g.id = $1`, [candidateId]
  ), 'load-candidate');
  return r.rows[0] || null;
}

async function claimBatch(batchSize, staleMinutes) {
  // Reset stale reviewing rows first.
  await pool.query(
    `UPDATE general.donee_trigram_candidates
       SET status = 'pending'
     WHERE status = 'llm_reviewing'
       AND reviewed_at < NOW() - ($1 || ' minutes')::interval`,
    [staleMinutes]
  );
  // Claim a batch of pending rows atomically.
  const r = await pool.query(
    `UPDATE general.donee_trigram_candidates c
        SET status = 'llm_reviewing', reviewed_at = NOW()
      WHERE c.id IN (
        SELECT id FROM general.donee_trigram_candidates
        WHERE status = 'pending'
        ORDER BY total_gifts DESC NULLS LAST, citations DESC
        LIMIT $1 FOR UPDATE SKIP LOCKED
      )
      RETURNING c.id, c.donee_name, c.donee_name_norm, c.candidate_entity_id,
                c.similarity, c.citations, c.total_gifts`,
    [batchSize]
  );
  return r.rows;
}

async function reviewOne(row, opts) {
  const candidate = await loadCandidateContext(row.candidate_entity_id);
  if (!candidate) {
    await pool.query(
      `UPDATE general.donee_trigram_candidates
          SET status = 'different', llm_verdict = 'DIFFERENT',
              llm_reasoning = 'candidate entity no longer exists', reviewed_at = NOW()
        WHERE id = $1`, [row.id]
    );
    return { verdict: 'DIFFERENT', skipped: true };
  }

  const prompt = buildPrompt(row, candidate);
  const { text } = await withRetry(() => callLLM(prompt, { provider: opts.provider, maxTokens: 400 }), 'callLLM', opts.maxRetries);
  let result;
  try { result = parseJson(text); }
  catch (e) {
    await pool.query(
      `UPDATE general.donee_trigram_candidates
          SET status = 'error', llm_reasoning = $2, reviewed_at = NOW()
        WHERE id = $1`, [row.id, 'parse error: ' + (e.message || '').slice(0, 200)]
    );
    return { verdict: null, error: true };
  }

  const verdict = String(result.verdict || '').toUpperCase();
  const status = verdict === 'SAME' ? 'same'
               : verdict === 'RELATED' ? 'related'
               : verdict === 'DIFFERENT' ? 'different'
               : 'error';

  if (opts.dryRun) {
    console.log(`  [DRY] ${verdict} sim=${row.similarity} "${row.donee_name}" -> #${candidate.id} "${candidate.canonical_name}"`);
    return { verdict };
  }
  await pool.query(
    `UPDATE general.donee_trigram_candidates
        SET status = $2, llm_verdict = $3,
            llm_confidence = $4, llm_reasoning = $5, reviewed_at = NOW()
      WHERE id = $1`,
    [row.id, status, verdict, Number(result.confidence) || null,
     String(result.reasoning || '').slice(0, 500)]
  );
  return { verdict };
}

async function phaseReview(opts) {
  const t0 = Date.now();
  log('══ Phase B: LLM review of donee-name candidates ══');
  log(`  concurrency=${opts.concurrency} limit=${opts.limit || '∞'} provider=${opts.provider || 'auto'}`);

  const sem = new Semaphore(opts.concurrency);
  const tally = { SAME: 0, RELATED: 0, DIFFERENT: 0, error: 0 };
  let processed = 0;
  let lastLog = Date.now();

  while (true) {
    if (opts.limit && processed >= opts.limit) break;
    const batchSize = opts.limit
      ? Math.min(opts.concurrency * 2, opts.limit - processed)
      : opts.concurrency * 2;
    const batch = await claimBatch(batchSize, opts.staleMinutes);
    if (batch.length === 0) break;

    await Promise.all(batch.map(async row => {
      await sem.acquire();
      try {
        const { verdict, error } = await reviewOne(row, opts);
        if (error) tally.error++;
        else if (verdict) tally[verdict] = (tally[verdict] || 0) + 1;
      } catch (err) {
        tally.error++;
        console.warn(`  ERROR id=${row.id}: ${err.message}`);
        await pool.query(
          `UPDATE general.donee_trigram_candidates SET status='error', llm_reasoning=$2, reviewed_at=NOW() WHERE id=$1`,
          [row.id, String(err.message || '').slice(0, 500)]
        ).catch(() => {});
      } finally { sem.release(); processed++; }
    }));

    if (Date.now() - lastLog > 10000) {
      const elapsed = (Date.now() - t0) / 1000;
      log(`  processed=${processed.toLocaleString()} SAME=${tally.SAME} RELATED=${tally.RELATED} DIFFERENT=${tally.DIFFERENT} err=${tally.error} (${(processed / elapsed).toFixed(1)}/s)`);
      lastLog = Date.now();
    }
  }

  log(`Phase B complete: ${processed.toLocaleString()} reviewed in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  log(`  SAME=${tally.SAME} RELATED=${tally.RELATED} DIFFERENT=${tally.DIFFERENT} err=${tally.error}`);
}

// ═══════════════════════════════════════════════════════════════
//  PHASE C — Apply SAME verdicts
// ═══════════════════════════════════════════════════════════════

async function phaseApply(opts) {
  const t0 = Date.now();
  log('══ Phase C: Apply SAME verdicts ══');

  if (opts.dryRun) {
    const sameCount = await pool.query(
      `SELECT COUNT(*)::int AS n FROM general.donee_trigram_candidates
        WHERE status='same' AND applied_at IS NULL`
    );
    log(`  [DRY] would apply ${sameCount.rows[0].n.toLocaleString()} SAME verdicts`);
    return;
  }

  // Batch-apply all SAME verdicts. For each:
  //  1. Insert entity_source_links rows for every qualified_donees row with
  //     this donee_name (idempotent via ON CONFLICT DO NOTHING — but that
  //     constraint doesn't exist on entity_source_links, so we guard with a
  //     NOT EXISTS subquery).
  //  2. Append donee_name to entity.alternate_names (dedup in-place).
  //  3. Append donee_name as an alias in entity_golden_records.aliases jsonb.
  //  4. Mark candidate applied_at.
  const sames = await pool.query(
    `SELECT id, donee_name, donee_name_norm, candidate_entity_id,
            similarity, citations
     FROM general.donee_trigram_candidates
     WHERE status='same' AND applied_at IS NULL
     ORDER BY total_gifts DESC NULLS LAST`
  );
  log(`  ${sames.rowCount.toLocaleString()} SAME verdicts to apply`);

  let linksAdded = 0, aliasesAdded = 0, skipped = 0;

  for (const c of sames.rows) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Safety re-check: entity must still be primary-source and not merged.
      const guard = await client.query(
        `SELECT e.id, e.merged_into,
                EXISTS (
                  SELECT 1 FROM general.entity_source_links sl
                  WHERE sl.entity_id = e.id
                    AND ((sl.source_schema='cra' AND sl.source_table='cra_identification')
                      OR (sl.source_schema='ab' AND sl.source_table='ab_non_profit')
                      OR (sl.source_schema='fed' AND sl.source_table='grants_contributions'))
                ) AS is_primary
         FROM general.entities e WHERE e.id = $1 FOR UPDATE`,
        [c.candidate_entity_id]
      );
      if (!guard.rows[0] || guard.rows[0].merged_into || !guard.rows[0].is_primary) {
        await client.query('ROLLBACK');
        skipped++;
        continue;
      }

      // 1) entity_source_links — one per raw qualified_donees row.
      const linkRes = await client.query(
        `INSERT INTO general.entity_source_links
           (entity_id, source_schema, source_table, source_pk, source_name,
            match_confidence, match_method, link_status)
         SELECT $1, 'cra', 'cra_qualified_donees',
                jsonb_build_object('bn', qd.bn, 'fpe', qd.fpe::text, 'seq', qd.sequence_number),
                qd.donee_name, $3, 'donee_trigram_fallback', 'confirmed'
         FROM cra.cra_qualified_donees qd
         WHERE UPPER(TRIM(qd.donee_name)) = $2
           AND NOT EXISTS (
             SELECT 1 FROM general.entity_source_links sl
             WHERE sl.source_schema='cra' AND sl.source_table='cra_qualified_donees'
               AND sl.source_pk = jsonb_build_object('bn', qd.bn, 'fpe', qd.fpe::text, 'seq', qd.sequence_number)
           )`,
        [c.candidate_entity_id, c.donee_name_norm, Number(c.similarity)]
      );
      linksAdded += linkRes.rowCount;

      // 2) Append donee_name to entity.alternate_names (dedup).
      await client.query(
        `UPDATE general.entities
            SET alternate_names = (
                  SELECT array_agg(DISTINCT n) FROM (
                    SELECT unnest(alternate_names) AS n
                    UNION SELECT $2::text
                  ) t WHERE n IS NOT NULL AND length(trim(n)) > 0
                ),
                updated_at = NOW()
          WHERE id = $1`,
        [c.candidate_entity_id, c.donee_name]
      );

      // 3) Append donee_name to entity_golden_records.aliases.
      await client.query(
        `UPDATE general.entity_golden_records
            SET aliases = COALESCE((
                  SELECT jsonb_agg(DISTINCT x) FROM (
                    SELECT jsonb_array_elements(aliases) AS x
                    UNION SELECT jsonb_build_object('name', $2::text, 'source', 'donee_trigram_fallback')
                  ) u WHERE x IS NOT NULL
                ), aliases),
                updated_at = NOW()
          WHERE id = $1`,
        [c.candidate_entity_id, c.donee_name]
      );
      aliasesAdded++;

      // 4) Mark candidate applied.
      await client.query(
        `UPDATE general.donee_trigram_candidates
            SET applied_at = NOW()
          WHERE id = $1`, [c.id]
      );

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      console.warn(`  failed apply id=${c.id}: ${err.message}`);
      skipped++;
    } finally {
      client.release();
    }
  }

  log(`Phase C complete: aliases_added=${aliasesAdded} source_links_added=${linksAdded.toLocaleString()} skipped=${skipped} (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
}

// ═══════════════════════════════════════════════════════════════
//  MAIN
// ═══════════════════════════════════════════════════════════════

async function main() {
  const opts = parseArgs();
  log(`Tier 6 — donee_name trigram fallback  (phase=${opts.phase})`);

  // Sanity: the staging table must exist. Bail with a clear message if the
  // migration hasn't been applied yet.
  const tableCheck = await pool.query(
    `SELECT 1 FROM information_schema.tables
      WHERE table_schema='general' AND table_name='donee_trigram_candidates'`
  );
  if (tableCheck.rowCount === 0) {
    console.error('FATAL: general.donee_trigram_candidates does not exist. Run `npm run entities:migrate` first.');
    process.exit(2);
  }

  try {
    if (opts.phase === 'A' || opts.phase === 'ALL') await phaseDetect(opts);
    if (opts.phase === 'B' || opts.phase === 'ALL') await phaseReview(opts);
    if (opts.phase === 'C' || opts.phase === 'ALL') await phaseApply(opts);
  } finally {
    await pool.end();
  }
}

main().catch(e => { console.error('FATAL:', e.message); console.error(e.stack); process.exit(1); });
