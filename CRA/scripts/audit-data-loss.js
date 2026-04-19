/**
 * audit-data-loss.js — Exhaustive source-vs-DB non-null comparison.
 *
 * For every dataset × year × field:
 *   1. Iterate the cached source file, count non-null source values per key
 *   2. Query the DB, count non-null values for the mapped column, filtered
 *      to the same fiscal year (via fpe or fiscal_year)
 *   3. If source non-null > DB non-null, or the source key has no mapping
 *      but contains non-null values, flag as potential loss
 *
 * Additive to the field-level crosswalk in config/cra-crosswalk.json.
 *
 * Output: CRA/data/reports/data-loss-audit.json
 *         CRA/data/reports/data-loss-audit.md
 */
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');
require('dotenv').config({ path: path.join(__dirname, '..', '..', 'FED', '.env.public') });

const crosswalk = require(path.join(__dirname, '..', 'config', 'cra-crosswalk.json'));

const YEARS = [2020, 2021, 2022, 2023, 2024];

// Tables keyed by fpe (date) — filter by EXTRACT(YEAR FROM fpe)
// Tables keyed by fiscal_year (int) — filter by fiscal_year = ?
const YEAR_COLUMN = {
  cra_identification: { column: 'fiscal_year', type: 'int' },
  cra_web_urls:       { column: 'fiscal_year', type: 'int' },
};

function dbYearFilter(table) {
  const def = YEAR_COLUMN[table];
  if (def) return (year) => `${def.column} = ${year}`;
  return (year) => `EXTRACT(YEAR FROM fpe) = ${year}`;
}

async function main() {
  const client = new Client({ connectionString: process.env.DB_CONNECTION_STRING });
  await client.connect();

  const results = {
    _metadata: {
      description: 'Source vs. DB non-null audit per dataset × year × field.',
      generated: new Date().toISOString(),
      method: 'Iterate every cached source JSON file, count non-null values per key per year. Query DB, count non-null values per mapped column per year. Compare.',
      flagRule: 'Flag when source_non_null > db_non_null (loss) OR when source key has non-null values but no DB mapping (unmapped).',
    },
    datasets: {},
  };

  const summary = { totalFlaggedLoss: 0, totalFlaggedUnmapped: 0, datasetsWithLoss: [], datasetsWithUnmapped: [] };

  for (const [dsKey, dsDef] of Object.entries(crosswalk.datasets)) {
    const table = dsDef.databaseTable;
    const perYearResults = {};
    const dsLossFlags = [];
    const dsUnmappedFlags = [];

    // Build alias→target-column lookup
    const aliasToDst = {};
    for (const col of dsDef.columnCrosswalk) {
      for (const alias of col.sourceKeyAliases) aliasToDst[alias] = col.targetColumn;
    }

    for (const year of YEARS) {
      const cachePath = path.join(__dirname, '..', 'data', 'cache', String(year), dsKey + '.json');
      const sourceKeyNonNulls = {};
      let sourceRowCount = 0;

      if (fs.existsSync(cachePath)) {
        const cached = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
        const recs = cached.records || cached;
        sourceRowCount = recs.length;
        for (const rec of recs) {
          for (const [k, v] of Object.entries(rec)) {
            if (v !== null && v !== '' && v !== undefined) {
              sourceKeyNonNulls[k] = (sourceKeyNonNulls[k] || 0) + 1;
            }
          }
        }
      }

      // Count DB non-nulls for this year
      const whereClause = dbYearFilter(table)(year);
      const rowCountRes = await client.query(`SELECT COUNT(*) AS c FROM cra.${table} WHERE ${whereClause}`);
      const dbRowCount = Number(rowCountRes.rows[0].c);

      let dbNonNulls = {};
      if (dbRowCount > 0) {
        // Query all mapped DB columns at once
        const dstCols = Array.from(new Set(dsDef.columnCrosswalk.map(c => c.targetColumn))).filter(c => c !== 'fiscal_year');
        const countClauses = dstCols.map(c => `COUNT(${c}) AS "${c}"`).join(', ');
        const q = await client.query(`SELECT ${countClauses} FROM cra.${table} WHERE ${whereClause}`);
        dbNonNulls = q.rows[0] || {};
      }

      const yearRes = {
        sourceRowCount,
        dbRowCount,
        rowDelta: sourceRowCount - dbRowCount,
        fieldDeltas: [],
      };

      // For each observed source key, compare to DB mapping
      for (const [srcKey, srcNN] of Object.entries(sourceKeyNonNulls)) {
        if (srcKey === '_id' || srcKey === '_rank') continue; // CKAN internal
        const dstCol = aliasToDst[srcKey];
        if (!dstCol) {
          // Unmapped source key with non-null values
          if (srcNN > 0) {
            const flag = { year, datasetKey: dsKey, table, sourceKey: srcKey, sourceNonNull: srcNN, targetColumn: null, dbNonNull: null, type: 'UNMAPPED', severity: srcNN > 100 ? 'HIGH' : srcNN > 10 ? 'MEDIUM' : 'LOW' };
            dsUnmappedFlags.push(flag);
            summary.totalFlaggedUnmapped++;
          }
          yearRes.fieldDeltas.push({ sourceKey: srcKey, sourceNonNull: srcNN, targetColumn: null, dbNonNull: null, delta: srcNN, type: 'UNMAPPED' });
          continue;
        }
        const dbNN = dbNonNulls[dstCol] !== undefined ? Number(dbNonNulls[dstCol]) : 0;
        const delta = srcNN - dbNN;
        yearRes.fieldDeltas.push({ sourceKey: srcKey, sourceNonNull: srcNN, targetColumn: dstCol, dbNonNull: dbNN, delta, type: delta > 0 ? 'LOSS' : 'OK' });
        if (srcNN > 10 && dbNN < srcNN * 0.5) {
          dsLossFlags.push({ year, datasetKey: dsKey, table, sourceKey: srcKey, sourceNonNull: srcNN, targetColumn: dstCol, dbNonNull: dbNN, severity: srcNN > 1000 ? 'HIGH' : srcNN > 100 ? 'MEDIUM' : 'LOW' });
          summary.totalFlaggedLoss++;
        }
      }

      // Sort fieldDeltas by largest loss first
      yearRes.fieldDeltas.sort((a, b) => (b.delta || 0) - (a.delta || 0));
      perYearResults[year] = yearRes;
    }

    if (dsLossFlags.length > 0) summary.datasetsWithLoss.push(dsKey);
    if (dsUnmappedFlags.length > 0) summary.datasetsWithUnmapped.push(dsKey);

    results.datasets[dsKey] = {
      table,
      perYear: perYearResults,
      lossFlags: dsLossFlags,
      unmappedFlags: dsUnmappedFlags,
      totalLossFlags: dsLossFlags.length,
      totalUnmappedFlags: dsUnmappedFlags.length,
    };
  }

  results.summary = summary;

  // Write JSON
  const jsonPath = path.join(__dirname, '..', 'data', 'reports', 'data-loss-audit.json');
  fs.mkdirSync(path.dirname(jsonPath), { recursive: true });
  fs.writeFileSync(jsonPath, JSON.stringify(results, null, 2));
  console.log(`Wrote ${jsonPath}`);

  // Write Markdown summary
  const md = renderMarkdown(results);
  const mdPath = path.join(__dirname, '..', 'data', 'reports', 'data-loss-audit.md');
  fs.writeFileSync(mdPath, md);
  console.log(`Wrote ${mdPath}`);

  await client.end();

  // Print summary to stdout
  console.log('\n=== SUMMARY ===');
  console.log(`Total LOSS flags (source has >2x more non-nulls than DB): ${summary.totalFlaggedLoss}`);
  console.log(`Total UNMAPPED flags (source key with non-null values, no DB mapping): ${summary.totalFlaggedUnmapped}`);
  console.log(`Datasets with loss: ${summary.datasetsWithLoss.join(', ') || '(none)'}`);
  console.log(`Datasets with unmapped: ${summary.datasetsWithUnmapped.join(', ') || '(none)'}`);
}

function renderMarkdown(results) {
  const lines = [];
  lines.push('# CRA Data Loss Audit — Source vs. Database Non-Null Comparison');
  lines.push('');
  lines.push(`**Generated:** ${results._metadata.generated}`);
  lines.push('');
  lines.push('**Method.** For every CRA dataset, for every fiscal year (2020–2024), every cached source JSON file was iterated record-by-record. Non-null values per source key were counted. The corresponding database column was queried for the same fiscal year, and non-null counts compared. A loss flag is raised when source has at least 10 non-null values and the DB column has less than half of those.');
  lines.push('');
  lines.push(`**Headline:** ${results.summary.totalFlaggedLoss} LOSS flags across ${results.summary.datasetsWithLoss.length} datasets; ${results.summary.totalFlaggedUnmapped} UNMAPPED source keys across ${results.summary.datasetsWithUnmapped.length} datasets.`);
  lines.push('');
  lines.push('---');
  lines.push('');

  lines.push('## 1. Per-dataset row-count match (source vs DB)');
  lines.push('');
  lines.push('| Dataset | Year | Source rows | DB rows | Delta |');
  lines.push('|---------|------|------------:|--------:|------:|');
  for (const [ds, data] of Object.entries(results.datasets)) {
    for (const [year, yr] of Object.entries(data.perYear)) {
      if (yr.sourceRowCount === 0 && yr.dbRowCount === 0) continue;
      lines.push(`| ${ds} | ${year} | ${yr.sourceRowCount.toLocaleString()} | ${yr.dbRowCount.toLocaleString()} | ${yr.rowDelta >= 0 ? '+' : ''}${yr.rowDelta.toLocaleString()} |`);
    }
  }
  lines.push('');

  lines.push('## 2. LOSS flags — DB has fewer non-null values than source for a mapped column');
  lines.push('');
  if (results.summary.totalFlaggedLoss === 0) {
    lines.push('_None. Every mapped source key has at least half of its non-null values present in the DB for the same fiscal year._');
  } else {
    lines.push('| Severity | Dataset | Year | Source key | Target column | Source non-null | DB non-null | Loss |');
    lines.push('|----------|---------|------|------------|---------------|----------------:|------------:|-----:|');
    const allFlags = [];
    for (const [ds, data] of Object.entries(results.datasets)) allFlags.push(...data.lossFlags);
    allFlags.sort((a, b) => (b.sourceNonNull - b.dbNonNull) - (a.sourceNonNull - a.dbNonNull));
    for (const f of allFlags) {
      lines.push(`| ${f.severity} | ${f.datasetKey} | ${f.year} | ${f.sourceKey} | ${f.targetColumn} | ${f.sourceNonNull} | ${f.dbNonNull} | ${f.sourceNonNull - f.dbNonNull} |`);
    }
  }
  lines.push('');

  lines.push('## 3. UNMAPPED source keys — source has values, no DB column mapping');
  lines.push('');
  if (results.summary.totalFlaggedUnmapped === 0) {
    lines.push('_None. Every source key with non-null values is mapped to a target column._');
  } else {
    lines.push('| Severity | Dataset | Year | Source key | Source non-null | Explanation hint |');
    lines.push('|----------|---------|------|------------|----------------:|------------------|');
    const allFlags = [];
    for (const [ds, data] of Object.entries(results.datasets)) allFlags.push(...data.unmappedFlags);
    allFlags.sort((a, b) => b.sourceNonNull - a.sourceNonNull);
    for (const f of allFlags) {
      const hint = hintForKey(f.datasetKey, f.sourceKey);
      lines.push(`| ${f.severity} | ${f.datasetKey} | ${f.year} | \`${f.sourceKey}\` | ${f.sourceNonNull} | ${hint} |`);
    }
  }
  lines.push('');

  lines.push('## 4. Per-dataset breakdown');
  lines.push('');
  for (const [ds, data] of Object.entries(results.datasets)) {
    const totalLoss = data.totalLossFlags;
    const totalUnmapped = data.totalUnmappedFlags;
    const emoji = (totalLoss === 0 && totalUnmapped === 0) ? '✅' : totalLoss > 0 ? '❌' : '⚠️';
    lines.push(`### ${emoji} ${ds} → \`${data.table}\``);
    lines.push('');
    if (totalLoss === 0 && totalUnmapped === 0) {
      lines.push('All mapped source keys fully represented in DB for every year. No unmapped source keys.');
    } else {
      lines.push(`- LOSS flags: ${totalLoss}`);
      lines.push(`- UNMAPPED flags: ${totalUnmapped}`);
      if (totalLoss > 0) {
        lines.push('');
        lines.push('Loss details:');
        for (const f of data.lossFlags) {
          lines.push(`  - **${f.year}** \`${f.sourceKey}\` → \`${f.targetColumn}\`: source ${f.sourceNonNull} non-null, DB ${f.dbNonNull}`);
        }
      }
      if (totalUnmapped > 0) {
        lines.push('');
        lines.push('Unmapped details:');
        for (const f of data.unmappedFlags) {
          lines.push(`  - **${f.year}** \`${f.sourceKey}\`: ${f.sourceNonNull} non-null source values, no DB mapping — ${hintForKey(f.datasetKey, f.sourceKey)}`);
        }
      }
    }
    lines.push('');
  }

  return lines.join('\n');
}

function hintForKey(dsKey, srcKey) {
  // Hand-curated hints for known unmapped source keys
  const hints = {
    qualified_donees: {
      'Address Line 1': 'Address data — intentionally not imported (qualified donee = other registered charity, address is on their own record in cra_identification)',
      'Address Line 2': 'Address data — intentionally not imported (see Address Line 1)',
      'Postal Code': 'Address data — intentionally not imported',
      'Country': 'Address data — intentionally not imported',
      'FPPA': 'Unknown field, appears in some years only',
      'FPPAName': 'Unknown field, appears in some years only',
      'FundType': 'Fund type classification — may need mapping',
    },
    financial_data: {
      '4011': 'Possibly v27 schema addition — verify in CRA Open Data Dictionary',
      '4012': 'Possibly v27 schema addition — verify in CRA Open Data Dictionary',
    },
    charitable_programs: {
      'Sequence #': 'Row-within-filing index, not needed (PK is bn+fpe+program_type)',
    },
    gifts_in_kind: {
      '590': 'Possibly v27 schema addition — verify',
    },
  };
  return (hints[dsKey] && hints[dsKey][srcKey]) || 'UNKNOWN — investigate whether this field should be imported';
}

main().catch(err => { console.error(err); process.exit(1); });
