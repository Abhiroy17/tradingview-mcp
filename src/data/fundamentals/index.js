/**
 * Fundamentals data layer — main entry point.
 *
 * Provides getFundamentals() and getFundamentalsMany() with:
 * - 24h disk cache (.data/fundamentals-cache.json)
 * - Bounded concurrency with rate-limit backoff
 * - Resumable batching with progress callback
 */

import { fetchFundamentals } from './yahoo-fundamentals.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(__dirname, '..', '..', '..', '.data');
const CACHE_FILE = path.join(DATA_DIR, 'fundamentals-cache.json');
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

// ── Cache management ──────────────────────────────────────────────────────

let cache = null;

function loadCache() {
  if (cache) return cache;
  try {
    if (fs.existsSync(CACHE_FILE)) {
      cache = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf-8'));
    } else {
      cache = {};
    }
  } catch {
    cache = {};
  }
  return cache;
}

function saveCache() {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2));
  } catch (e) {
    console.error('[fundamentals] cache write failed:', e.message);
  }
}

let savePending = null;
function debouncedSave() {
  if (savePending) return;
  savePending = setTimeout(() => { saveCache(); savePending = null; }, 2000);
}

function getCached(symbol) {
  const c = loadCache();
  const entry = c[symbol];
  if (!entry) return null;
  const age = Date.now() - new Date(entry.fetchedAt).getTime();
  if (age > CACHE_TTL_MS) return null;
  return entry;
}

function setCache(symbol, data) {
  loadCache();
  cache[symbol] = data;
  debouncedSave();
}

// ── Public API ────────────────────────────────────────────────────────────

/**
 * Get fundamentals for a single symbol (cache-first).
 * @param {string} symbol — Canonical "NSE:TICKER"
 * @param {object} [opts]
 * @param {boolean} [opts.forceRefresh] — Skip cache
 * @returns {Promise<object>} FundamentalSnapshot
 */
export async function getFundamentals(symbol, opts = {}) {
  if (!opts.forceRefresh) {
    const cached = getCached(symbol);
    if (cached) return cached;
  }

  const data = await fetchFundamentals(symbol);
  // Don't cache obviously broken results (no price, no name = Yahoo returned garbage)
  if (data && (data.price != null || data.name)) {
    setCache(symbol, data);
  }
  return data;
}

/**
 * Batch-fetch fundamentals with bounded concurrency and rate-limit backoff.
 * @param {string[]} symbols — Array of canonical symbols
 * @param {object} [opts]
 * @param {number} [opts.concurrency=4] — Max parallel requests
 * @param {Function} [opts.onProgress] — ({done, total, symbol, success}) => void
 * @param {boolean} [opts.forceRefresh] — Skip cache
 * @returns {Promise<{results: Map<string, object>, errors: Map<string, string>}>}
 */
export async function getFundamentalsMany(symbols, opts = {}) {
  const { concurrency = 4, onProgress, forceRefresh = false } = opts;
  const results = new Map();
  const errors = new Map();
  let done = 0;
  const total = symbols.length;

  // Split into cached vs need-fetch
  const toFetch = [];
  for (const sym of symbols) {
    if (!forceRefresh) {
      const cached = getCached(sym);
      if (cached) {
        results.set(sym, cached);
        done++;
        onProgress?.({ done, total, symbol: sym, success: true, cached: true });
        continue;
      }
    }
    toFetch.push(sym);
  }

  // Bounded concurrent fetch with backoff
  let backoffMs = 200;
  const maxBackoff = 10000;
  let consecutiveErrors = 0;

  const queue = [...toFetch];

  async function worker() {
    while (queue.length > 0) {
      const sym = queue.shift();
      if (!sym) break;

      try {
        // Rate limit: small delay between requests
        await sleep(backoffMs);

        const data = await fetchFundamentals(sym);
        setCache(sym, data);
        results.set(sym, data);
        done++;
        consecutiveErrors = 0;
        backoffMs = Math.max(200, backoffMs * 0.9); // ease off backoff on success
        onProgress?.({ done, total, symbol: sym, success: true, cached: false });
      } catch (e) {
        const msg = e.message || String(e);
        errors.set(sym, msg);
        done++;
        consecutiveErrors++;

        // Rate limit detection — back off
        if (msg.includes('429') || msg.includes('Too Many') || msg.includes('rate') || msg.includes('HTML instead of JSON') || msg.includes('consent page')) {
          backoffMs = Math.min(maxBackoff, backoffMs * 2);
          // Re-queue the symbol for retry
          if (consecutiveErrors < 3) {
            queue.push(sym);
            done--;
          }
        } else {
          backoffMs = Math.min(maxBackoff, backoffMs * 1.2);
        }

        onProgress?.({ done, total, symbol: sym, success: false, error: msg });
      }
    }
  }

  // Launch workers
  const workers = Array.from({ length: Math.min(concurrency, toFetch.length) }, () => worker());
  await Promise.all(workers);

  // Final cache save (non-fatal — don't lose results on disk write failure)
  try { saveCache(); } catch (e) {
    console.error('[fundamentals] final cache save failed (results still returned):', e.message);
  }

  return { results, errors };
}

/**
 * Get the in-memory cache map (for use by universe-filter preSectorRestrict).
 */
export function getCacheMap() {
  return loadCache();
}

/**
 * Get cache stats.
 */
export function getCacheStats() {
  const c = loadCache();
  const symbols = Object.keys(c);
  const now = Date.now();
  let fresh = 0, stale = 0;
  for (const sym of symbols) {
    const age = now - new Date(c[sym].fetchedAt).getTime();
    if (age <= CACHE_TTL_MS) fresh++;
    else stale++;
  }
  return { total: symbols.length, fresh, stale, cacheFile: CACHE_FILE };
}

/**
 * Clear entire cache or specific symbols.
 */
export function clearCache(symbols = null) {
  loadCache();
  if (symbols) {
    for (const sym of symbols) delete cache[sym];
  } else {
    cache = {};
  }
  saveCache();
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export default { getFundamentals, getFundamentalsMany, getCacheStats, clearCache };
