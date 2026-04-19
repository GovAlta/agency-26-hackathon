/**
 * 03-import-grants.js - Import all Alberta Grants JSON data files.
 *
 * Handles 7 data files:
 *   - test.opendata.json (1.1GB, streamed)
 *   - test.opendata-fiscalyears.json
 *   - test.opendata-ministries.json
 *   - test.opendata-programs.json
 *   - test.opendata-recipients.json
 *
 * Uses streaming JSON parser for the large main file.
 * MongoDB extended JSON types ($oid, $date, $numberLong, etc.) are handled.
 * Idempotent: ON CONFLICT (mongo_id) DO NOTHING.
 */
const fs = require('fs');
const path = require('path');
const { chain } = require('stream-chain');
const { parser } = require('stream-json');
// stream-json v2 uses src/ path structure
const { streamArray } = require(path.join(
  require.resolve('stream-json').replace(/src[/\\]index\.js$/, ''),
  'src', 'streamers', 'stream-array.js'
));
const { pool } = require('../lib/db');
const log = require('../lib/logger');
const { extractMongoValue } = require('../lib/transformers');

const DATA_DIR = path.join(__dirname, '..', 'data', 'grants');
const BATCH_SIZE = 1000;

const DATA_FILES = [
  {
    file: 'test.opendata.json',
    table: 'ab.ab_grants',
    streaming: true,
    transform: (record) => ({
      mongo_id: record._id?.$oid || null,
      ministry: record.ministry || null,
      business_unit_name: record.businessUnitName || null,
      recipient: record.recipient || null,
      program: record.program || null,
      amount: extractMongoValue(record.amount),
      lottery: record.lottery || null,
      payment_date: extractMongoValue(record.paymentDate?.$date) || record.paymentDate?.$date || null,
      fiscal_year: record.fiscalYear || null,
      display_fiscal_year: record.displayFiscalYear || null,
      lottery_fund: record.lotteryFund || null,
      version: record.__v ?? null,
      created_at: record.createdAt?.$date || null,
      updated_at: record.updatedAt?.$date || null,
    }),
    columns: [
      'mongo_id', 'ministry', 'business_unit_name', 'recipient', 'program', 'amount',
      'lottery', 'payment_date', 'fiscal_year', 'display_fiscal_year', 'lottery_fund',
      'version', 'created_at', 'updated_at',
    ],
  },
  {
    file: 'test.opendata-fiscalyears.json',
    table: 'ab.ab_grants_fiscal_years',
    streaming: false,
    transform: (record) => ({
      mongo_id: record._id?.$oid || null,
      display_fiscal_year: record.displayFiscalYear || null,
      count: extractMongoValue(record.count),
      total_amount: extractMongoValue(record.totalAmount),
      last_updated: record.lastUpdated?.$date || null,
      version: record.__v ?? null,
    }),
    columns: ['mongo_id', 'display_fiscal_year', 'count', 'total_amount', 'last_updated', 'version'],
  },
  {
    file: 'test.opendata-ministries.json',
    table: 'ab.ab_grants_ministries',
    streaming: false,
    transform: (record) => ({
      mongo_id: record._id?.$oid || null,
      ministry: record.ministry || null,
      display_fiscal_year: record.displayFiscalYear || null,
      aggregation_type: record.aggregationType || null,
      count: extractMongoValue(record.count),
      total_amount: extractMongoValue(record.totalAmount),
      last_updated: record.lastUpdated?.$date || null,
      version: record.__v ?? null,
    }),
    columns: [
      'mongo_id', 'ministry', 'display_fiscal_year', 'aggregation_type',
      'count', 'total_amount', 'last_updated', 'version',
    ],
  },
  {
    file: 'test.opendata-programs.json',
    table: 'ab.ab_grants_programs',
    streaming: false,
    transform: (record) => ({
      mongo_id: record._id?.$oid || null,
      program: record.program || null,
      ministry: record.ministry || null,
      display_fiscal_year: record.displayFiscalYear || null,
      aggregation_type: record.aggregationType || null,
      count: extractMongoValue(record.count),
      total_amount: extractMongoValue(record.totalAmount),
      last_updated: record.lastUpdated?.$date || null,
      version: record.__v ?? null,
    }),
    columns: [
      'mongo_id', 'program', 'ministry', 'display_fiscal_year', 'aggregation_type',
      'count', 'total_amount', 'last_updated', 'version',
    ],
  },
  {
    file: 'test.opendata-recipients.json',
    table: 'ab.ab_grants_recipients',
    streaming: false,
    transform: (record) => ({
      mongo_id: record._id?.$oid || null,
      recipient: record.recipient || null,
      payments_count: extractMongoValue(record.paymentsCount),
      payments_amount: extractMongoValue(record.paymentsAmount),
      programs_count: extractMongoValue(record.programsCount),
      ministries_count: extractMongoValue(record.ministriesCount),
      last_updated: record.lastUpdated?.$date || null,
      version: record.__v ?? null,
    }),
    columns: [
      'mongo_id', 'recipient', 'payments_count', 'payments_amount',
      'programs_count', 'ministries_count', 'last_updated', 'version',
    ],
  },
];

function buildBulkInsertQuery(table, columns, batchSize) {
  const columnList = columns.join(', ');
  const valuePlaceholders = [];
  for (let i = 0; i < batchSize; i++) {
    const rowPlaceholders = columns.map((_, colIndex) =>
      `$${i * columns.length + colIndex + 1}`
    ).join(', ');
    valuePlaceholders.push(`(${rowPlaceholders})`);
  }
  return `INSERT INTO ${table} (${columnList})
          VALUES ${valuePlaceholders.join(', ')}
          ON CONFLICT (mongo_id) DO NOTHING`;
}

async function insertBatch(client, table, columns, batch) {
  if (batch.length === 0) return 0;
  const query = buildBulkInsertQuery(table, columns, batch.length);
  const values = batch.flatMap(record => columns.map(col => record[col]));
  const result = await client.query(query, values);
  return result.rowCount || 0;
}

async function checkTableHasData(client, table) {
  const result = await client.query(`SELECT COUNT(*) FROM ${table}`);
  return parseInt(result.rows[0].count);
}

/**
 * Import a large JSON file using streaming parser.
 */
async function importStreaming(dataFile, client) {
  const { file, table, transform, columns } = dataFile;
  const filePath = path.join(DATA_DIR, file);

  if (!fs.existsSync(filePath)) {
    log.warn(`File not found: ${filePath} - skipping.`);
    return { processed: 0, imported: 0, skipped: true };
  }

  const existingCount = await checkTableHasData(client, table);
  if (existingCount > 0) {
    log.info(`  Table ${table} already has ${existingCount.toLocaleString()} rows. Skipping.`);
    return { processed: 0, imported: 0, skipped: true, existing: existingCount };
  }

  return new Promise((resolve, reject) => {
    let batch = [];
    let totalProcessed = 0;
    let totalImported = 0;
    let errorCount = 0;

    const pipeline = chain([
      fs.createReadStream(filePath),
      parser(),
      streamArray(),
    ]);

    pipeline.on('data', async (data) => {
      try {
        const transformed = transform(data.value);
        batch.push(transformed);

        if (batch.length >= BATCH_SIZE) {
          pipeline.pause();
          const inserted = await insertBatch(client, table, columns, batch);
          totalImported += inserted;
          totalProcessed += batch.length;

          if (totalProcessed % 50000 === 0) {
            log.progress(totalProcessed, 0, `${file} processed`);
          }

          batch = [];
          pipeline.resume();
        }
      } catch (err) {
        errorCount++;
        if (errorCount <= 5) log.warn(`  Row error in ${file}: ${err.message}`);
        pipeline.resume();
      }
    });

    pipeline.on('end', async () => {
      try {
        if (batch.length > 0) {
          const inserted = await insertBatch(client, table, columns, batch);
          totalImported += inserted;
          totalProcessed += batch.length;
        }
        log.info(`  ${file}: ${totalProcessed.toLocaleString()} processed, ${totalImported.toLocaleString()} imported`);
        if (errorCount > 0) log.warn(`  ${errorCount} errors encountered`);
        resolve({ processed: totalProcessed, imported: totalImported, errors: errorCount });
      } catch (err) {
        reject(err);
      }
    });

    pipeline.on('error', (err) => reject(err));
  });
}

/**
 * Import a small JSON file (load entirely into memory).
 */
async function importSmallFile(dataFile, client) {
  const { file, table, transform, columns } = dataFile;
  const filePath = path.join(DATA_DIR, file);

  if (!fs.existsSync(filePath)) {
    log.warn(`File not found: ${filePath} - skipping.`);
    return { processed: 0, imported: 0, skipped: true };
  }

  const existingCount = await checkTableHasData(client, table);
  if (existingCount > 0) {
    log.info(`  Table ${table} already has ${existingCount.toLocaleString()} rows. Skipping.`);
    return { processed: 0, imported: 0, skipped: true, existing: existingCount };
  }

  const raw = fs.readFileSync(filePath, 'utf8');
  const records = JSON.parse(raw);
  log.info(`  ${file}: ${records.length.toLocaleString()} records to import`);

  let totalImported = 0;
  let batch = [];

  for (const record of records) {
    batch.push(transform(record));

    if (batch.length >= BATCH_SIZE) {
      const inserted = await insertBatch(client, table, columns, batch);
      totalImported += inserted;
      batch = [];
    }
  }

  if (batch.length > 0) {
    const inserted = await insertBatch(client, table, columns, batch);
    totalImported += inserted;
  }

  log.info(`  ${file}: ${records.length.toLocaleString()} processed, ${totalImported.toLocaleString()} imported`);
  return { processed: records.length, imported: totalImported };
}

async function run() {
  const client = await pool.connect();

  try {
    log.section('Alberta Grants - Data Import');
    log.info(`Batch size: ${BATCH_SIZE}`);
    log.info(`Data directory: ${DATA_DIR}`);

    const results = {};

    for (const dataFile of DATA_FILES) {
      log.info('');
      log.info(`Processing: ${dataFile.file} -> ${dataFile.table}`);

      if (dataFile.streaming) {
        results[dataFile.file] = await importStreaming(dataFile, client);
      } else {
        results[dataFile.file] = await importSmallFile(dataFile, client);
      }
    }

    log.section('Import Summary');
    for (const [file, result] of Object.entries(results)) {
      if (result.skipped) {
        log.info(`  ${file}: SKIPPED (${result.existing ? result.existing.toLocaleString() + ' existing rows' : 'file not found'})`);
      } else {
        log.info(`  ${file}: ${result.imported.toLocaleString()} imported / ${result.processed.toLocaleString()} processed`);
      }
    }
  } catch (err) {
    log.error(`Import error: ${err.message}`);
    console.error(err);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

run();
