#!/usr/bin/env node
// One-off: find the 8 splink-only sample entities in our golden records
// using alias-aware + trigram fuzzy match, and report the full Splink-side
// source_links to understand where our cascade could have picked them up.
const path = require('path');
const Database = require('better-sqlite3');
const { pool } = require('../../lib/db');

const names = [
  'ROBERT HALF TRADE NAME OF ROBERT HALF CANADA INC.',
  'NEW SAREPTA & DISTRICT AGRICULTURAL SOCIETY',
  "Westlock Golden Age Club Senior Citizen's Drop-In-Center",
  'GOLDEN ENVIRONMENTAL MAT SERVICES',
  'HAVER ANALYTICS',
  '712556 Alberta Inc.O/A  P.R.O.S. Providing Residential Options & Service',
  "KIDS HELP PHONE/JEUNESSE J'ECOUTE",
  'Willowglen Systems Ltd|Willowglen Systems Ltd.',
];

const SPLINK_DB = 'C:/Users/janak.alford/Downloads/splink-master-table/entity-master.sqlite';

async function main() {
  const splink = new Database(SPLINK_DB, { readonly: true });
  for (const name of names) {
    console.log('\n═══════════════════════════════════════════════════════');
    console.log('SPLINK name: "' + name + '"');
    // Splink-side detail
    const splinkEnt = splink.prepare(
      `SELECT * FROM canonical_entities WHERE canonical_name = ?`
    ).get(name);
    if (splinkEnt) {
      const links = splink.prepare(
        `SELECT source_dataset, source_id, source_name, match_method
         FROM source_links WHERE canonical_id = ? ORDER BY source_dataset`
      ).all(splinkEnt.canonical_id);
      console.log('  Splink canonical_id=' + splinkEnt.canonical_id + ' primary_bn=' + splinkEnt.primary_bn);
      console.log('  Splink source_links:');
      links.forEach(l => console.log('    [' + l.source_dataset + '] src_id=' + l.source_id + ' name="' + l.source_name + '" method=' + l.match_method));
    }

    // Our-side: step 1 — exact norm on canonical_name
    let r = await pool.query(
      `SELECT id, canonical_name, bn_root, dataset_sources,
              (SELECT COUNT(*) FROM general.entity_source_links WHERE entity_id = g.id)::int AS links
       FROM general.entity_golden_records g
       WHERE general.norm_name(g.canonical_name) = general.norm_name($1)
       ORDER BY links DESC LIMIT 3`, [name]);
    let how = 'exact norm';

    // Step 2 — norm match against aliases jsonb
    if (!r.rows[0]) {
      r = await pool.query(
        `SELECT id, canonical_name, bn_root, dataset_sources,
                (SELECT COUNT(*) FROM general.entity_source_links WHERE entity_id = g.id)::int AS links
         FROM general.entity_golden_records g
         WHERE EXISTS (
           SELECT 1 FROM jsonb_array_elements_text(
             CASE WHEN jsonb_typeof(g.aliases) = 'array' THEN g.aliases ELSE '[]'::jsonb END
           ) AS a WHERE general.norm_name(a) = general.norm_name($1)
         )
         ORDER BY links DESC LIMIT 3`, [name]);
      how = 'alias norm';
    }

    // Step 3 — trigram similarity on canonical or aliases
    if (!r.rows[0]) {
      r = await pool.query(
        `SELECT id, canonical_name, bn_root, dataset_sources,
                similarity(canonical_name, $1) AS sim,
                (SELECT COUNT(*) FROM general.entity_source_links WHERE entity_id = g.id)::int AS links
         FROM general.entity_golden_records g
         WHERE similarity(canonical_name, $1) > 0.45
         ORDER BY sim DESC LIMIT 3`, [name]);
      how = 'trigram';
    }

    if (r.rows[0]) {
      console.log('  OUR match (' + how + '):');
      r.rows.forEach(e =>
        console.log('    id=' + e.id + ' bn=' + (e.bn_root || '—') +
          ' datasets=' + JSON.stringify(e.dataset_sources) +
          ' links=' + e.links +
          (e.sim ? ' sim=' + Number(e.sim).toFixed(3) : '') +
          '\n        "' + e.canonical_name + '"')
      );
    } else {
      console.log('  OUR match: NONE FOUND even at trigram > 0.45');
    }
  }
  splink.close();
  await pool.end();
}
main().catch(e => { console.error(e); process.exit(1); });
