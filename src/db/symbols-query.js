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

/**
 * Pre-filter symbols using DB-stored fundamentals.
 * Returns symbols that pass ALL the given filter criteria.
 * This avoids expensive Yahoo API calls for stocks that will be eliminated anyway.
 *
 * @param {object} filters
 * @param {number} [filters.minMarketCap] — Minimum market cap (raw INR)
 * @param {number} [filters.minPrice] — Minimum price
 * @param {number} [filters.maxPrice] — Maximum price
 * @param {number} [filters.maxDebtToEquity] — Max D/E ratio (scale: 0-100 where 100 = 1x)
 * @param {number} [filters.minROE] — Minimum ROE %
 * @param {number} [filters.minROCE] — Minimum ROCE %
 * @param {number} [filters.maxPE] — Maximum P/E ratio
 * @param {number} [filters.minCurrentRatio] — Minimum current ratio
 * @param {string} [filters.sector] — GICS sector label
 * @param {string[]} [filters.industryPatterns] — Industry keyword patterns
 * @param {string[]} [filters.symbols] — Restrict to these symbols (if provided)
 * @param {number} [filters.limit] — Max rows to return
 * @returns {Promise<string[]|null>} Array of canonical symbols or null if DB unavailable
 */
export async function preFilterSymbols(filters = {}) {
  if (!isDbConfigured()) return null;

  try {
    const conditions = ['exchange = \'NSE\'', 'active = TRUE'];
    const params = [];
    let paramIdx = 1;

    if (filters.minMarketCap) {
      conditions.push(`market_cap >= $${paramIdx}`);
      params.push(filters.minMarketCap);
      paramIdx++;
    }
    if (filters.minPrice) {
      conditions.push(`price >= $${paramIdx}`);
      params.push(filters.minPrice);
      paramIdx++;
    }
    if (filters.maxPrice) {
      conditions.push(`price <= $${paramIdx}`);
      params.push(filters.maxPrice);
      paramIdx++;
    }
    if (filters.maxDebtToEquity != null) {
      conditions.push(`(debt_to_equity IS NULL OR debt_to_equity <= $${paramIdx})`);
      params.push(filters.maxDebtToEquity);
      paramIdx++;
    }
    if (filters.minROE) {
      conditions.push(`roe >= $${paramIdx}`);
      params.push(filters.minROE);
      paramIdx++;
    }
    if (filters.minROCE) {
      conditions.push(`roce >= $${paramIdx}`);
      params.push(filters.minROCE);
      paramIdx++;
    }
    if (filters.maxPE) {
      conditions.push(`(pe IS NULL OR (pe > 0 AND pe <= $${paramIdx}))`);
      params.push(filters.maxPE);
      paramIdx++;
    }
    if (filters.minCurrentRatio) {
      conditions.push(`current_ratio >= $${paramIdx}`);
      params.push(filters.minCurrentRatio);
      paramIdx++;
    }
    if (filters.sector) {
      conditions.push(`sector = $${paramIdx}`);
      params.push(filters.sector);
      paramIdx++;
    }
    if (filters.industryPatterns?.length) {
      const iConds = filters.industryPatterns.map((_, i) => `industry ILIKE $${paramIdx + i}`);
      conditions.push(`(${iConds.join(' OR ')})`);
      for (const p of filters.industryPatterns) {
        params.push(`%${p}%`);
        paramIdx++;
      }
    }
    if (filters.symbols?.length) {
      conditions.push(`canonical = ANY($${paramIdx})`);
      params.push(filters.symbols);
      paramIdx++;
    }

    let sql = `
      SELECT canonical FROM symbols
      WHERE ${conditions.join(' AND ')}
      ORDER BY market_cap DESC NULLS LAST
    `;
    if (filters.limit) {
      sql += ` LIMIT ${parseInt(filters.limit)}`;
    }

    const result = await query(sql, params);
    return result.rows.map(r => r.canonical);
  } catch (err) {
    console.warn('[db] preFilterSymbols failed:', err.message);
    return null;
  }
}

/**
 * Get refresh stats — how many symbols have data and how fresh.
 * @returns {Promise<object|null>}
 */
export async function getRefreshStats() {
  if (!isDbConfigured()) return null;

  try {
    const result = await query(`
      SELECT
        COUNT(*) FILTER (WHERE active = TRUE) as total_active,
        COUNT(*) FILTER (WHERE data_refreshed_at IS NOT NULL AND active = TRUE) as refreshed,
        COUNT(*) FILTER (WHERE market_cap IS NOT NULL AND active = TRUE) as has_mcap,
        COUNT(*) FILTER (WHERE sector IS NOT NULL AND active = TRUE) as has_sector,
        COUNT(*) FILTER (WHERE roe IS NOT NULL AND active = TRUE) as has_roe,
        COUNT(*) FILTER (WHERE data_refreshed_at > NOW() - INTERVAL '24 hours' AND active = TRUE) as fresh_24h,
        MIN(data_refreshed_at) FILTER (WHERE active = TRUE) as oldest_refresh,
        MAX(data_refreshed_at) FILTER (WHERE active = TRUE) as newest_refresh
      FROM symbols WHERE exchange = 'NSE'
    `);
    return result.rows[0] || null;
  } catch {
    return null;
  }
}
