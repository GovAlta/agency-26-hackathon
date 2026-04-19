/**
 * Data transformation helpers for CRA T3010 API data.
 * Converts raw API string values to typed JavaScript values for database insertion.
 */

/** Convert Y/N string to boolean. Returns null for empty/missing values. */
function yesNoToBool(value) {
  if (!value || value === '') return null;
  return value.toUpperCase() === 'Y';
}

/**
 * Convert "X" presence-flag string to boolean.
 * Used by cra_political_activity_resources where the source publishes
 * staff/volunteers/financial/property as "X" markers (meaning "this
 * resource was used") rather than counts or amounts. Empty → NULL,
 * "X" → true, anything else → false.
 */
function xFlagToBool(value) {
  if (value === null || value === undefined || value === '') return null;
  return String(value).trim().toUpperCase() === 'X';
}

/** Parse a decimal string. Returns null for empty/invalid. */
function parseDecimal(value) {
  if (!value || value === '') return null;
  const cleaned = String(value).replace(/,/g, '');
  const parsed = parseFloat(cleaned);
  return isNaN(parsed) ? null : parsed;
}

/** Parse an integer string. Returns null for empty/invalid. */
function parseInteger(value) {
  if (!value || value === '') return null;
  const parsed = Number.parseInt(value, 10);
  return isNaN(parsed) ? null : parsed;
}

/** Parse and validate a date string (YYYY-MM-DD or YYYY/MM/DD). Returns null for invalid. */
function parseDate(value) {
  if (!value || value === '') return null;
  const cleaned = value.toString().trim().replace(/[\r\n\t]+/g, '');
  if (cleaned.length < 8 || cleaned.length > 10) return null;
  if (!/^\d{4}[-/]\d{1,2}[-/]\d{1,2}$/.test(cleaned)) return null;
  return cleaned;
}

/** Trim a string. Returns null for empty/missing. */
function cleanString(value) {
  if (!value || value === '') return null;
  return value.trim();
}

/** Validate a 2-letter province/country code. Returns uppercase or null. */
function cleanCode2(value) {
  const cleaned = cleanString(value);
  if (!cleaned || cleaned.length !== 2 || !/^[A-Z]{2}$/i.test(cleaned)) return null;
  return cleaned.toUpperCase();
}

/** Escape a string for SQL insertion (single quotes). */
function sqlStr(value) {
  if (value === null || value === undefined) return 'NULL';
  return `'${String(value).replace(/'/g, "''")}'`;
}

/** Format a value for SQL: strings get quoted, null/undefined become NULL, others pass through. */
function sqlVal(value) {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'string') return sqlStr(value);
  if (typeof value === 'boolean') return value.toString();
  return value;
}

module.exports = {
  yesNoToBool,
  xFlagToBool,
  parseDecimal,
  parseInteger,
  parseDate,
  cleanString,
  cleanCode2,
  sqlStr,
  sqlVal,
};
