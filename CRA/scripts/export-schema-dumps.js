/**
 * export-schema-dumps.js — one-off dumper that regenerates
 *   - general/db/cra_schema.sql   (quoted-identifier format)
 *   - .local-db/schemas/cra.sql   (IF NOT EXISTS format)
 * directly from the live PostgreSQL cra schema.
 *
 * Run with admin credentials (.env) since it reads information_schema.
 */
const fs = require('fs');
const path = require('path');
const db = require('../lib/db');

const REPO_ROOT = path.join(__dirname, '..', '..');
const GENERAL_OUT = path.join(REPO_ROOT, 'general', 'db', 'cra_schema.sql');
const LOCAL_OUT   = path.join(REPO_ROOT, '.local-db', 'schemas', 'cra.sql');

function pgType(col) {
  const t = col.data_type;
  switch (t) {
    case 'character varying':
      return col.character_maximum_length
        ? `VARCHAR(${col.character_maximum_length})`
        : 'VARCHAR';
    case 'character':
      return col.character_maximum_length
        ? `CHAR(${col.character_maximum_length})`
        : 'CHAR';
    case 'numeric':
      return col.numeric_precision
        ? `NUMERIC(${col.numeric_precision}${col.numeric_scale != null ? ',' + col.numeric_scale : ''})`
        : 'NUMERIC';
    case 'timestamp without time zone': return 'TIMESTAMP';
    case 'timestamp with time zone': return 'TIMESTAMPTZ';
    default: return t.toUpperCase();
  }
}

async function main() {
  const tables = await db.query(`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema = 'cra' AND table_type = 'BASE TABLE'
    ORDER BY table_name
  `);
  const tableNames = tables.rows.map(r => r.table_name);

  const colsByTable = {};
  const pksByTable = {};
  for (const t of tableNames) {
    const cols = await db.query(`
      SELECT column_name, data_type, character_maximum_length,
             numeric_precision, numeric_scale, is_nullable
      FROM information_schema.columns
      WHERE table_schema='cra' AND table_name=$1
      ORDER BY ordinal_position
    `, [t]);
    colsByTable[t] = cols.rows;

    const pk = await db.query(`
      SELECT kcu.column_name
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu
        ON kcu.constraint_name = tc.constraint_name
        AND kcu.table_schema = tc.table_schema
      WHERE tc.constraint_type = 'PRIMARY KEY'
        AND tc.table_schema = 'cra' AND tc.table_name = $1
      ORDER BY kcu.ordinal_position
    `, [t]);
    pksByTable[t] = pk.rows.map(r => r.column_name);
  }

  const indexes = await db.query(`
    SELECT schemaname, tablename, indexname, indexdef
    FROM pg_indexes
    WHERE schemaname = 'cra'
    ORDER BY tablename, indexname
  `);

  const now = new Date().toISOString();

  // ── Format A: .local-db/schemas/cra.sql (IF NOT EXISTS) ──────────────
  const localLines = [];
  localLines.push('-- Schema: cra');
  localLines.push(`-- Exported: ${now}`);
  localLines.push('CREATE SCHEMA IF NOT EXISTS cra;');
  localLines.push('');
  for (const t of tableNames) {
    localLines.push(`CREATE TABLE IF NOT EXISTS cra.${t} (`);
    const cols = colsByTable[t];
    const colLines = cols.map(c => {
      let line = `  ${c.column_name} ${pgType(c)}`;
      if (c.is_nullable === 'NO') line += ' NOT NULL';
      return line;
    });
    const pk = pksByTable[t];
    if (pk.length) {
      colLines.push(`  PRIMARY KEY (${pk.join(', ')})`);
    }
    localLines.push(colLines.join(',\n'));
    localLines.push(');');
    localLines.push('');
  }
  // Indexes (skip PRIMARY KEY indexes PostgreSQL creates automatically)
  for (const row of indexes.rows) {
    if (row.indexname.endsWith('_pkey')) continue;
    localLines.push(`${row.indexdef};`);
  }
  fs.writeFileSync(LOCAL_OUT, localLines.join('\n') + '\n', 'utf8');
  console.log(`Wrote ${LOCAL_OUT} (${localLines.length} lines)`);

  // ── Format B: general/db/cra_schema.sql (quoted identifiers) ─────────
  const genLines = [];
  genLines.push('-- Schema: cra');
  genLines.push(`-- Generated: ${now}`);
  genLines.push(`-- Tables: ${tableNames.length}`);
  genLines.push('');
  for (const t of tableNames) {
    genLines.push(`-- Table: cra.${t}`);
    genLines.push(`CREATE TABLE "cra"."${t}" (`);
    const cols = colsByTable[t];
    const pk = pksByTable[t];
    const colLines = cols.map(c => {
      let line = `  "${c.column_name}" ${pgType(c).toLowerCase()}`;
      if (c.is_nullable === 'NO') line += ' NOT NULL';
      if (pk.includes(c.column_name)) line += ' PRIMARY KEY';
      return line;
    });
    genLines.push(colLines.join(',\n'));
    genLines.push(');');
    genLines.push('');
  }
  for (const row of indexes.rows) {
    if (row.indexname.endsWith('_pkey')) continue;
    // rewrite quoted identifiers minimally — indexdef already uses the cra schema explicitly
    genLines.push(`${row.indexdef};`);
  }
  fs.writeFileSync(GENERAL_OUT, genLines.join('\n') + '\n', 'utf8');
  console.log(`Wrote ${GENERAL_OUT} (${genLines.length} lines)`);

  await db.end();
}

main().catch(err => { console.error(err); process.exit(1); });
