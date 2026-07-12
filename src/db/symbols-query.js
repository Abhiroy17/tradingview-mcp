/**
 * Fast Postgres queries for symbol lookups by sector/industry.
 * Used by the multibagger screener for instant sector resolution.
 */

import { query, isDbConfigured } from './client.js';

/**
 * Get all active NSE symbols for a given Yahoo GICS sector.
 * Returns array of canonical symbols (e.g. ['NSE:SUNPHARMA', 'NSE:CIPLA', ...]).
 * Returns null if DB is not configured (caller should fallback to cache).
 *
 * @param {string} sector — Yahoo GICS sector label (e.g. 'Healthcare')
 * @param {object} [opts]
 * @param {number} [opts.minMarketCap] — Optional market cap floor (raw value)
 * @param {number} [opts.minPrice] — Optional price floor
 * @returns {Promise<string[]|null>}
 */
export async function getSymbolsBySector(sector, opts = {}) {
  if (!isDbConfigured()) return null;

  try {
    const { minMarketCap, minPrice } = opts;
    let sql = `
      SELECT canonical FROM symbols
      WHERE sector = $1 AND exchange = 'NSE' AND active = TRUE
    `;
    const params = [sector];
    let paramIdx = 2;

    if (minMarketCap) {
      sql += ` AND market_cap >= $${paramIdx}`;
      params.push(minMarketCap);
      paramIdx++;
    }
    if (minPrice) {
      sql += ` AND price >= $${paramIdx}`;
      params.push(minPrice);
      paramIdx++;
    }

    sql += ` ORDER BY market_cap DESC NULLS LAST`;

    const result = await query(sql, params);
    return result.rows.map(r => r.canonical);
  } catch (err) {
    console.warn('[db] getSymbolsBySector failed, falling back:', err.message);
    return null;
  }
}

/**
 * Get all active NSE symbols matching industry keyword patterns.
 * Used for India-specific sectors (Chemicals, Defence, Textiles, etc.)
 *
 * @param {string[]} industryPatterns — Keywords to match (e.g. ['Chemicals', 'Specialty Chemicals'])
 * @param {object} [opts]
 * @returns {Promise<string[]|null>}
 */
export async function getSymbolsByIndustry(industryPatterns, opts = {}) {
  if (!isDbConfigured() || !industryPatterns?.length) return null;

  try {
    // Build ILIKE conditions for each pattern
    const conditions = industryPatterns.map((_, i) => `industry ILIKE $${i + 1}`);
    const params = industryPatterns.map(p => `%${p}%`);

    const sql = `
      SELECT canonical FROM symbols
      WHERE (${conditions.join(' OR ')})
        AND exchange = 'NSE' AND active = TRUE
      ORDER BY market_cap DESC NULLS LAST
    `;

    const result = await query(sql, params);
    return result.rows.map(r => r.canonical);
  } catch (err) {
    console.warn('[db] getSymbolsByIndustry failed:', err.message);
    return null;
  }
}

/**
 * Get all distinct sectors with counts.
 * @returns {Promise<Array<{sector: string, count: number}>|null>}
 */
export async function getSectorCounts() {
  if (!isDbConfigured()) return null;

  try {
    const result = await query(`
      SELECT sector, COUNT(*)::int as count
      FROM symbols
      WHERE exchange = 'NSE' AND active = TRUE AND sector IS NOT NULL
      GROUP BY sector
      ORDER BY count DESC
    `);
    return result.rows;
  } catch (err) {
    console.warn('[db] getSectorCounts failed:', err.message);
    return null;
  }
}

/**
 * Get symbol metadata (sector, industry, market_cap) for a single symbol.
 * @param {string} canonical — e.g. 'NSE:SHILPAMED'
 * @returns {Promise<object|null>}
 */
export async function getSymbolMeta(canonical) {
  if (!isDbConfigured()) return null;

  try {
    const result = await query(
      `SELECT canonical, ticker, sector, industry, name, market_cap, price
       FROM symbols WHERE canonical = $1`,
      [canonical]
    );
    return result.rows[0] || null;
  } catch {
    return null;
  }
}
