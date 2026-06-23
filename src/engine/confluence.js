/**
 * Multi-timeframe confluence engine.
 *
 * Runs a strategy in LIVE mode across several timeframes (default: 15m + 5m + 3m)
 * and reports whether the live signals agree.
 *
 * Confluence verdicts:
 *   - 'strong'   : majority BUYs (or majority SELLs) on >= ceil(n/2) timeframes,
 *                  and no opposing-direction signal anywhere.
 *   - 'weak'     : single timeframe shows a directional signal, others WAIT.
 *   - 'conflict' : both BUY and SELL appear across timeframes.
 *   - 'none'     : all timeframes WAIT or IN_TRADE.
 *
 * The engine intentionally treats IN_TRADE as neutral (neither confirming nor
 * conflicting) so existing positions don't poison the confluence check.
 */
import pLimit from 'p-limit';
import { runStrategy } from './contract.js';

export const DEFAULT_CONFLUENCE_TIMEFRAMES = Object.freeze(['15', '5', '3']);

/**
 * Classify a signal type as directional ('long' | 'short') or neutral.
 */
function direction(signalType) {
  if (signalType === 'BUY') return 'long';
  if (signalType === 'SELL') return 'short';
  return 'neutral';
}

/**
 * Aggregate per-TF signals into a single verdict.
 */
function verdictOf(perTf) {
  const dirs = Object.values(perTf).map(s => direction(s.signalType));
  const longCount = dirs.filter(d => d === 'long').length;
  const shortCount = dirs.filter(d => d === 'short').length;
  const neutralCount = dirs.filter(d => d === 'neutral').length;
  const total = dirs.length || 1;

  if (longCount > 0 && shortCount > 0) {
    return { verdict: 'conflict', longCount, shortCount, neutralCount };
  }
  if (longCount === 0 && shortCount === 0) {
    return { verdict: 'none', longCount, shortCount, neutralCount };
  }
  const directionalCount = longCount + shortCount;
  const threshold = Math.ceil(total / 2);
  if (directionalCount >= threshold) {
    return {
      verdict: 'strong',
      direction: longCount > shortCount ? 'long' : 'short',
      longCount, shortCount, neutralCount,
    };
  }
  return {
    verdict: 'weak',
    direction: longCount > shortCount ? 'long' : 'short',
    longCount, shortCount, neutralCount,
  };
}

/**
 * Check signal confluence for one (code, symbol) across the given timeframes.
 *
 * @param {Object} args
 * @param {string} args.code
 * @param {string} args.symbol
 * @param {Array<string>} [args.timeframes]  - TV-style codes (e.g. '15', '5', '3', '1', '60', '1D')
 * @param {Object} [args.params]             - strategy param overrides
 * @param {number} [args.concurrency=3]
 * @returns {Promise<Object>}
 */
export async function checkConfluence({
  code, symbol,
  timeframes = DEFAULT_CONFLUENCE_TIMEFRAMES,
  params,
  concurrency = 3,
} = {}) {
  if (!code) throw new Error('checkConfluence: code required');
  if (!symbol) throw new Error('checkConfluence: symbol required');
  if (!Array.isArray(timeframes) || timeframes.length === 0) {
    throw new Error('checkConfluence: timeframes[] required');
  }

  const limit = pLimit(Math.max(1, concurrency));
  const tasks = timeframes.map((tf) => limit(async () => {
    try {
      const res = await runStrategy({ code, symbol, timeframe: tf, params, mode: 'live' });
      const sig = res?.currentSignal || {};
      return {
        timeframe: tf,
        ok: true,
        signalType: sig.type || 'WAIT',
        reason: sig.reason || null,
        regime: res?.regime || null,
        meta: { name: res?.name || code },
      };
    } catch (err) {
      return {
        timeframe: tf,
        ok: false,
        signalType: 'WAIT',
        error: err?.message || String(err),
      };
    }
  }));

  const results = await Promise.all(tasks);
  const perTf = {};
  for (const r of results) perTf[r.timeframe] = r;

  const verdict = verdictOf(perTf);

  return {
    code, symbol,
    timeframes,
    signals: perTf,
    ...verdict,
  };
}

/**
 * Bulk confluence — run `checkConfluence` for many (code, symbol) pairs.
 * Each pair is processed in parallel; within each pair, timeframes are
 * already parallelized internally.
 */
export async function checkConfluenceBatch({
  pairs,
  timeframes = DEFAULT_CONFLUENCE_TIMEFRAMES,
  params,
  concurrency = 4,
} = {}) {
  if (!Array.isArray(pairs) || pairs.length === 0) {
    throw new Error('checkConfluenceBatch: pairs[] required');
  }
  if (pairs.length > 100) {
    throw new Error('checkConfluenceBatch: max 100 pairs');
  }
  const limit = pLimit(Math.max(1, concurrency));
  const tasks = pairs.map((p) => limit(() => checkConfluence({
    code: p.code,
    symbol: p.symbol,
    timeframes,
    params: p.params || params,
  })));
  return Promise.all(tasks);
}
