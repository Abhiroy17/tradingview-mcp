/**
 * File-backed historical bar cache.
 *
 * Layout: .data/ohlcv-cache/{provider}/{safe-symbol}/{tf}.json
 *
 * Each file stores ascending bars. TTL is enforced on read:
 *  - intraday (<1D)  : 24h freshness for in-window slices, 7d for stale tail
 *  - daily/weekly    : 7d freshness
 *
 * A read merges cache + live fetch; only the missing range is fetched live.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { TIMEFRAME_SECONDS, normalizeBars, tfKey, toUnixSec } from './types.js';

const CACHE_ROOT = path.resolve(process.cwd(), '.data', 'ohlcv-cache');

const FRESHNESS_SEC = {
  intraday: 24 * 3600,
  daily: 7 * 24 * 3600,
};

function safeSeg(s) {
  return String(s).replace(/[^a-z0-9_-]/gi, '_');
}

function cacheFile(provider, symbol, tf) {
  return path.join(
    CACHE_ROOT,
    safeSeg(provider),
    safeSeg(symbol),
    `${tfKey(tf)}.json`,
  );
}

async function ensureDir(p) {
  await fs.mkdir(path.dirname(p), { recursive: true });
}

/**
 * Read cached bars (returns [] if no cache).
 * @returns {Promise<{bars: Array, fetchedAt: number}>}
 */
export async function readCache(provider, symbol, tf) {
  const file = cacheFile(provider, symbol, tf);
  try {
    const raw = await fs.readFile(file, 'utf8');
    const parsed = JSON.parse(raw);
    return {
      bars: Array.isArray(parsed.bars) ? parsed.bars : [],
      fetchedAt: Number(parsed.fetchedAt) || 0,
    };
  } catch {
    return { bars: [], fetchedAt: 0 };
  }
}

/**
 * Write merged bars back to disk.
 */
export async function writeCache(provider, symbol, tf, bars) {
  const file = cacheFile(provider, symbol, tf);
  await ensureDir(file);
  const payload = {
    provider,
    symbol,
    timeframe: tf,
    fetchedAt: Date.now(),
    count: bars.length,
    firstTime: bars[0]?.time ?? null,
    lastTime: bars[bars.length - 1]?.time ?? null,
    bars,
  };
  await fs.writeFile(file, JSON.stringify(payload), 'utf8');
}

/**
 * Merge two bar arrays, ascending, de-duped by `time`.
 */
export function mergeBars(a, b) {
  if (!a?.length) return normalizeBars(b || []);
  if (!b?.length) return normalizeBars(a);
  return normalizeBars([...a, ...b]);
}

/**
 * Slice bars to the requested [from, to] window (inclusive).
 */
export function sliceBars(bars, fromSec, toSec) {
  if (!Array.isArray(bars) || bars.length === 0) return [];
  const lo = fromSec == null ? -Infinity : fromSec;
  const hi = toSec == null ? Infinity : toSec;
  return bars.filter(b => b.time >= lo && b.time <= hi);
}

/**
 * Decide whether a cached window is fresh enough to skip a live re-fetch.
 *
 * @param {string} tf
 * @param {number} fetchedAt - ms
 * @param {number} toSec     - upper bound of requested window (sec)
 */
export function isFresh(tf, fetchedAt, toSec) {
  if (!fetchedAt) return false;
  const ageSec = (Date.now() - fetchedAt) / 1000;
  const isIntraday = TIMEFRAME_SECONDS[tf] < 86400;
  const ttl = isIntraday ? FRESHNESS_SEC.intraday : FRESHNESS_SEC.daily;
  // If the requested window ends in the past (older than ttl ago), cache is always fine
  const nowSec = Math.floor(Date.now() / 1000);
  if (toSec && nowSec - toSec > ttl) return true;
  return ageSec < ttl;
}

/**
 * Compute the missing time range that must be fetched live.
 * Returns null if cache covers the request fully.
 */
export function missingRange(cachedBars, fromSec, toSec) {
  if (!cachedBars?.length) return { from: fromSec, to: toSec };
  const first = cachedBars[0].time;
  const last = cachedBars[cachedBars.length - 1].time;
  // Hole on the left
  if (fromSec < first) return { from: fromSec, to: Math.min(toSec, first - 1) };
  // Hole on the right
  if (toSec > last) return { from: Math.max(fromSec, last + 1), to: toSec };
  return null;
}

export const CACHE_PATHS = { CACHE_ROOT, cacheFile };

// Re-export helpers used by callers
export { toUnixSec };
