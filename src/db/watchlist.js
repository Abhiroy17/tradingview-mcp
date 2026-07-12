/**
 * DB-backed watchlist + munafa scan persistence.
 *
 * Watchlist: unique symbols, manual/munafa/multibagger sources.
 * Munafa scans: daily tips persisted with date, purged before next scan.
 * Multibagger auto-add: high-scoring munafa symbols go to watchlist automatically.
 */

import { query, isDbConfigured } from './client.js';

// ── Watchlist CRUD ──────────────────────────────────────────────────────

/**
 * Get all watchlist items, ordered by added_at DESC.
 * @returns {Promise<Array>}
 */
export async function dbGetWatchlist() {
  if (!isDbConfigured()) return null;
  const r = await query(`
    SELECT symbol, source, price, change_pct, signal, optimal_strategy,
           multibagger_score, added_at, updated_at
    FROM watchlist ORDER BY added_at DESC
  `);
  return r.rows;
}

/**
 * Add a symbol to watchlist (upsert — no duplicates).
 * @param {string} symbol
 * @param {object} [meta] — { source, price, change_pct, signal, optimal_strategy, multibagger_score }
 * @returns {Promise<object>} — the upserted row
 */
export async function dbAddToWatchlist(symbol, meta = {}) {
  if (!isDbConfigured()) return null;
  const r = await query(`
    INSERT INTO watchlist (symbol, source, price, change_pct, signal, optimal_strategy, multibagger_score)
    VALUES ($1, $2, $3, $4, $5, $6, $7)
    ON CONFLICT (symbol) DO UPDATE SET
      price = COALESCE(EXCLUDED.price, watchlist.price),
      change_pct = COALESCE(EXCLUDED.change_pct, watchlist.change_pct),
      signal = COALESCE(EXCLUDED.signal, watchlist.signal),
      optimal_strategy = COALESCE(EXCLUDED.optimal_strategy, watchlist.optimal_strategy),
      multibagger_score = COALESCE(EXCLUDED.multibagger_score, watchlist.multibagger_score),
      source = CASE WHEN watchlist.source = 'manual' THEN watchlist.source ELSE COALESCE(EXCLUDED.source, watchlist.source) END,
      updated_at = NOW()
    RETURNING *
  `, [
    symbol,
    meta.source || 'manual',
    meta.price || null,
    meta.change_pct || null,
    meta.signal || null,
    meta.optimal_strategy || null,
    meta.multibagger_score || null,
  ]);
  return r.rows[0];
}

/**
 * Bulk add symbols to watchlist (upsert, no duplicates).
 * @param {Array<{symbol: string, source?: string, price?: number}>} items
 * @returns {Promise<number>} — count of rows affected
 */
export async function dbBulkAddToWatchlist(items) {
  if (!isDbConfigured() || !items.length) return 0;
  const values = [];
  const params = [];
  let idx = 1;
  for (const item of items) {
    values.push(`($${idx}, $${idx + 1}, $${idx + 2})`);
    params.push(item.symbol, item.source || 'manual', item.price || null);
    idx += 3;
  }
  const r = await query(`
    INSERT INTO watchlist (symbol, source, price)
    VALUES ${values.join(', ')}
    ON CONFLICT (symbol) DO UPDATE SET
      price = COALESCE(EXCLUDED.price, watchlist.price),
      updated_at = NOW()
  `, params);
  return r.rowCount;
}

/**
 * Remove a symbol from watchlist.
 * @param {string} symbol
 * @returns {Promise<boolean>}
 */
export async function dbRemoveFromWatchlist(symbol) {
  if (!isDbConfigured()) return false;
  const r = await query(`DELETE FROM watchlist WHERE symbol = $1`, [symbol]);
  return r.rowCount > 0;
}

/**
 * Check if a symbol is in watchlist.
 */
export async function dbIsInWatchlist(symbol) {
  if (!isDbConfigured()) return false;
  const r = await query(`SELECT 1 FROM watchlist WHERE symbol = $1`, [symbol]);
  return r.rows.length > 0;
}

// ── Munafa Scan Persistence ─────────────────────────────────────────────

/**
 * Purge old munafa scan results (before inserting today's new scan).
 * Keeps only today's results by default.
 */
export async function dbPurgeMunafaScans() {
  if (!isDbConfigured()) return 0;
  const r = await query(`DELETE FROM munafa_scans WHERE scan_date < CURRENT_DATE`);
  return r.rowCount;
}

/**
 * Insert today's munafa scan results (upsert per symbol+date).
 * @param {Array<{symbol: string, endpoint_url?: string, price?: number}>} results
 * @returns {Promise<number>}
 */
export async function dbInsertMunafaScan(results) {
  if (!isDbConfigured() || !results.length) return 0;
  const values = [];
  const params = [];
  let idx = 1;
  for (const r of results) {
    values.push(`($${idx}, CURRENT_DATE, $${idx + 1}, $${idx + 2})`);
    params.push(r.symbol, r.endpoint_url || null, r.price || null);
    idx += 3;
  }
  const res = await query(`
    INSERT INTO munafa_scans (symbol, scan_date, endpoint_url, price)
    VALUES ${values.join(', ')}
    ON CONFLICT (symbol, scan_date) DO UPDATE SET
      endpoint_url = COALESCE(EXCLUDED.endpoint_url, munafa_scans.endpoint_url),
      price = COALESCE(EXCLUDED.price, munafa_scans.price)
  `, params);
  return res.rowCount;
}

/**
 * Get today's munafa scan results.
 */
export async function dbGetTodayMunafaScans() {
  if (!isDbConfigured()) return null;
  const r = await query(`
    SELECT symbol, endpoint_url, price, multibagger_score, auto_watchlisted, created_at
    FROM munafa_scans WHERE scan_date = CURRENT_DATE
    ORDER BY multibagger_score DESC NULLS LAST
  `);
  return r.rows;
}

/**
 * Update multibagger score for munafa scan results.
 * @param {Array<{symbol: string, score: number}>} scored
 */
export async function dbUpdateMunafaScores(scored) {
  if (!isDbConfigured() || !scored.length) return;
  for (const { symbol, score } of scored) {
    await query(`
      UPDATE munafa_scans SET multibagger_score = $1
      WHERE symbol = $2 AND scan_date = CURRENT_DATE
    `, [score, symbol]);
  }
}

/**
 * Mark munafa scan symbols as auto-watchlisted.
 * @param {string[]} symbols
 */
export async function dbMarkAutoWatchlisted(symbols) {
  if (!isDbConfigured() || !symbols.length) return;
  await query(`
    UPDATE munafa_scans SET auto_watchlisted = TRUE
    WHERE symbol = ANY($1) AND scan_date = CURRENT_DATE
  `, [symbols]);
}
