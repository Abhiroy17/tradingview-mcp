/**
 * AMFI mutual-fund portfolio provider (official monthly disclosures).
 *
 * AMFI / AMCs publish monthly scheme portfolios. There is no single official
 * JSON API, so this module ingests disclosure files (CSV/TSV — convert XLSX to
 * CSV first, or drop `.csv` exports into the ingest dir) and builds a REVERSE
 * INDEX: company symbol → list of holding funds. Parsed ONCE per month into
 * `mf_portfolio_holdings`, then queried by symbol (indexed) — never re-scanned
 * per request.
 *
 * Expected CSV columns (case-insensitive, flexible header matching):
 *   Scheme Name | ISIN | Instrument/Company Name | Market Value | % to NAV
 * Fund house is inferred from the file name or a "Fund House"/"AMC" column.
 *
 * Symbol mapping uses ISIN → canonical 'NSE:TICKER' via `.data/isin-map.json`
 * (built from the symbols table / upstox instruments) with a name fallback.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { query, isDbConfigured } from '../../db/client.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(__dirname, '..', '..', '..', '.data');
const ISIN_MAP_FILE = path.join(DATA_DIR, 'isin-map.json');

let _isinMap = null;

/** Load ISIN → canonical-symbol map (lazily). */
function loadIsinMap() {
  if (_isinMap) return _isinMap;
  try {
    _isinMap = JSON.parse(fs.readFileSync(ISIN_MAP_FILE, 'utf8'));
  } catch {
    _isinMap = {};
  }
  return _isinMap;
}

/** Minimal, dependency-free CSV parser (handles quoted fields + commas). */
export function parseCsv(text) {
  const rows = [];
  let field = '';
  let row = [];
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (c === '\r') { /* skip */ }
    else field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows;
}

const HEADER_ALIASES = {
  scheme: ['scheme name', 'scheme', 'scheme_name'],
  isin: ['isin', 'isin code', 'isin no'],
  company: ['instrument name', 'company name', 'name of instrument', 'company', 'instrument', 'name of the instrument'],
  marketValue: ['market value', 'market value (rs. in lakhs)', 'market value(rs. lakhs)', 'market/fair value', 'value'],
  pctToNav: ['% to nav', 'percentage to nav', '% of nav', 'pct to nav', '% to net assets'],
  fundHouse: ['fund house', 'amc', 'mutual fund', 'amc name'],
};

function matchHeader(headerRow) {
  const idx = {};
  const lower = headerRow.map((h) => (h || '').trim().toLowerCase());
  for (const [key, aliases] of Object.entries(HEADER_ALIASES)) {
    idx[key] = lower.findIndex((h) => aliases.includes(h));
  }
  return idx;
}

function toNum(v) {
  if (v == null) return null;
  const n = parseFloat(String(v).replace(/[₹,%\s]/g, ''));
  return Number.isFinite(n) ? n : null;
}

function resolveSymbol(isin, company) {
  const map = loadIsinMap();
  if (isin && map[isin.trim().toUpperCase()]) return map[isin.trim().toUpperCase()];
  // Name fallback: exact upper match against a name→symbol reverse (if present).
  if (company && map.__byName) {
    const key = company.trim().toUpperCase();
    if (map.__byName[key]) return map.__byName[key];
  }
  return null;
}

/**
 * Parse a single AMFI/AMC portfolio CSV into normalized holding rows.
 * @param {string} filePath
 * @param {object} [opts] { period: 'YYYY-MM-DD', fundHouse }
 * @returns {Array<object>} rows ready for DB upsert
 */
export function parseAmfiPortfolioFile(filePath, opts = {}) {
  const text = fs.readFileSync(filePath, 'utf8');
  const rows = parseCsv(text).filter((r) => r.some((c) => c && c.trim()));
  if (rows.length < 2) return [];

  // Find the header row (first row containing an ISIN or % to NAV alias).
  let headerRowIdx = 0;
  for (let i = 0; i < Math.min(rows.length, 15); i++) {
    const lower = rows[i].map((h) => (h || '').trim().toLowerCase());
    if (lower.some((h) => HEADER_ALIASES.isin.includes(h) || HEADER_ALIASES.pctToNav.includes(h))) {
      headerRowIdx = i;
      break;
    }
  }
  const idx = matchHeader(rows[headerRowIdx]);
  const fundHouseFromName = path.basename(filePath).replace(/[_-]/g, ' ').replace(/\.csv$/i, '');

  const out = [];
  for (let i = headerRowIdx + 1; i < rows.length; i++) {
    const r = rows[i];
    const isin = idx.isin >= 0 ? r[idx.isin] : null;
    const company = idx.company >= 0 ? r[idx.company] : null;
    if (!isin && !company) continue;
    const symbol = resolveSymbol(isin, company);
    if (!symbol) continue; // only keep rows we can map to a tradable NSE symbol
    out.push({
      symbol,
      period: opts.period || firstOfMonth(new Date()),
      fundHouse: (idx.fundHouse >= 0 ? r[idx.fundHouse] : null) || opts.fundHouse || fundHouseFromName,
      schemeName: idx.scheme >= 0 ? (r[idx.scheme] || '').trim() : 'Unknown Scheme',
      holdingValueCr: laksToCr(toNum(idx.marketValue >= 0 ? r[idx.marketValue] : null)),
      pctOfPortfolio: toNum(idx.pctToNav >= 0 ? r[idx.pctToNav] : null),
    });
  }
  return out;
}

function laksToCr(lakhs) {
  return lakhs == null ? null : Math.round((lakhs / 100) * 10000) / 10000; // lakhs → crore
}

function firstOfMonth(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`;
}

/**
 * Ingest all `.csv` portfolio files in a directory into `mf_portfolio_holdings`.
 * @param {string} dir
 * @param {object} [opts] { period }
 * @returns {Promise<{files:number, rows:number}>}
 */
export async function ingestAmfiDirectory(dir, opts = {}) {
  if (!isDbConfigured()) throw new Error('DATABASE_URL not set — cannot ingest AMFI data.');
  const files = fs.readdirSync(dir).filter((f) => /\.csv$/i.test(f));
  let total = 0;
  for (const f of files) {
    const rows = parseAmfiPortfolioFile(path.join(dir, f), opts);
    for (const row of rows) {
      await upsertHolding(row);
      total++;
    }
  }
  return { files: files.length, rows: total };
}

async function upsertHolding(row) {
  await query(
    `INSERT INTO mf_portfolio_holdings
       (symbol, period, fund_house, scheme_name, holding_value_cr, pct_of_portfolio, source, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,'amfi',NOW())
     ON CONFLICT (symbol, period, scheme_name) DO UPDATE SET
       fund_house = EXCLUDED.fund_house,
       holding_value_cr = EXCLUDED.holding_value_cr,
       pct_of_portfolio = EXCLUDED.pct_of_portfolio,
       updated_at = NOW()`,
    [row.symbol, row.period, row.fundHouse, row.schemeName, row.holdingValueCr, row.pctOfPortfolio],
  );
}

/**
 * Read MF holdings for a symbol (latest two periods) + compute fund churn.
 * @returns {Promise<{period, schemes:Array, count, entered:Array, exited:Array}|null>}
 */
export async function getMfHoldingsForSymbol(symbol) {
  if (!isDbConfigured()) return null;
  try {
    const periods = await query(
      `SELECT DISTINCT period FROM mf_portfolio_holdings WHERE symbol=$1 ORDER BY period DESC LIMIT 2`,
      [symbol],
    );
    if (!periods.rows.length) return null;
    const latest = periods.rows[0].period;
    const prev = periods.rows[1]?.period || null;

    const cur = await query(
      `SELECT fund_house, scheme_name, holding_value_cr, pct_of_portfolio
         FROM mf_portfolio_holdings WHERE symbol=$1 AND period=$2
         ORDER BY holding_value_cr DESC NULLS LAST`,
      [symbol, latest],
    );
    let entered = [];
    let exited = [];
    if (prev) {
      const prevRows = await query(
        `SELECT scheme_name FROM mf_portfolio_holdings WHERE symbol=$1 AND period=$2`,
        [symbol, prev],
      );
      const curNames = new Set(cur.rows.map((r) => r.scheme_name));
      const prevNames = new Set(prevRows.rows.map((r) => r.scheme_name));
      entered = [...curNames].filter((n) => !prevNames.has(n));
      exited = [...prevNames].filter((n) => !curNames.has(n));
    }
    return {
      period: toIso(latest),
      count: cur.rows.length,
      schemes: cur.rows.map((r) => ({
        fundHouse: r.fund_house,
        scheme: r.scheme_name,
        valueCr: r.holding_value_cr != null ? Number(r.holding_value_cr) : null,
        pctOfPortfolio: r.pct_of_portfolio != null ? Number(r.pct_of_portfolio) : null,
      })),
      entered,
      exited,
    };
  } catch (e) {
    if (process.env.OWNERSHIP_DEBUG) console.error(`[amfi] ${symbol}: ${e.message}`);
    return null;
  }
}

function toIso(d) {
  if (!d) return null;
  return d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10);
}
