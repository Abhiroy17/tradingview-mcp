/**
 * Canonical strategy registry — single source of truth.
 *
 * Each entry has:
 *   - code         : stable id used in DB rows, API requests, store keys
 *   - name         : human-friendly label
 *   - description  : 1-line summary for UI
 *   - family       : 'mean_reversion' | 'trend_following' | 'breakout' | 'momentum' | 'gap' | 'calendar' | 'hybrid'
 *   - style        : 'intraday' | 'swing' | 'positional'
 *   - tier         : 'production' | 'experimental' (Phase A two-tier roster)
 *   - timeframes   : recommended TF codes (subset of TIMEFRAMES in providers/types.js)
 *   - regimeAffinity : array of regime codes the strategy works best in
 *                     (Phase F may upgrade this to a structured object)
 *   - direction    : 'long' | 'short' | 'both' (Phase C short-side rules)
 *   - tags         : freeform labels for UI filtering / DNA scoring
 *   - source       : 'profitable' | 'untested' (origin folder under pdf/)
 *   - pineFile     : exact .pine filename in `pdf/{source}/` (null if no Pine source exists)
 *   - tvBacktestable : true if pineFile resolves to a real strategy() Pine script
 *   - backtestable : true if a JS run function exists in `src/engine/strategies/<code>.js`
 *   - tunedParams  : Phase G basket-validated parameter set (reference defaults).
 *                    Production deployment SHOULD recalibrate per-symbol via
 *                    scripts/tune-multi.js — these are starting points, not
 *                    universally optimal across all NSE stocks.
 *   - notes        : freeform research notes (Phase G findings, known limitations)
 *
 * Note: the `runFn` (actual strategy implementation) is loaded lazily by
 * `src/engine/contract.js` from `src/engine/strategies/<code>.js`.
 *
 * --- Roster (post-Phase-H) ---
 * Production tier (3): trend_200sma_positional, ema_rsi_intraday, master_intraday.
 * Experimental tier (10): rsi2_india_swing (demoted H), fibonacci_india_swing (demoted H),
 *                        ibs_india_swing, ibs_india_intraday, overnight_swing,
 *                        monday_reversal, ibs_mean_reversion, movingaverage_intraday,
 *                        dual_movingaverage_intraday, supertrend_intraday.
 *
 * Phase G demoted both ibs strategies after multi-symbol sweep showed they fail
 * to produce universal edge on the NSE large-cap basket at any tested params.
 * They remain available for research / per-symbol calibration but are no longer
 * surfaced in default production lists.
 */

import { matchesRegimeAffinity } from './regimes.js';

export const STRATEGY_REGISTRY = Object.freeze({
  // ══════════════════════════════════════════════════════════════════
  // PRODUCTION TIER — fully validated, basket-profitable, Indian-market tuned
  // Production: trend_200sma_positional, ema_rsi_intraday
  // ══════════════════════════════════════════════════════════════════

  // ── Demoted strategies (tier=experimental, kept at original position) ──
  rsi2_india_swing: {
    code: 'rsi2_india_swing',
    name: 'RSI(2) India Swing (Experimental)',
    description: 'RSI(2) tuned for Indian large-caps with volume confirmation. Daily mean-reversion, 200-EMA trend filter.',
    family: 'mean_reversion',
    style: 'swing',
    tier: 'experimental',
    timeframes: ['1D'],
    regimeAffinity: {
      trend: ['ranging', 'trending_up', 'mixed'],
      vol:   ['low', 'normal', 'high'],
    },
    direction: 'long',
    tags: ['rsi', 'india', 'volume', 'connors', 'experimental'],
    source: 'profitable',
    pineFile: 'rsi2_india_swing.pine',
    tvBacktestable: true,
    backtestable: true,
    notes: 'Phase H: DEMOTED. 4y cross-basket sweep (cap tier): large_cap 1/10 profitable (-130%), mid_cap 3/10 (-105%), small_cap 2/10 (-155%). No universal edge found at any tested param combo. Per-symbol calibration may still work (RELIANCE PF 1.77) but not deployable as a basket strategy.',
  },

  // ── Mean Reversion (IBS / range-position) ────────────────────────
  // NOTE: Both ibs_* strategies demoted to experimental in Phase G after
  // multi-symbol basket sweep showed no universal edge. Kept available for
  // research and per-symbol calibration via scripts/tune-multi.js.
  ibs_india_swing: {
    code: 'ibs_india_swing',
    name: 'IBS India Swing (Experimental)',
    description: 'Internal Bar Strength swing with volatility (1.5%-5% ATR), liquidity (₹2 Cr), price ≥ ₹100 filters.',
    family: 'mean_reversion',
    style: 'swing',
    tier: 'experimental',
    timeframes: ['1D'],
    regimeAffinity: {
      trend: ['ranging', 'trending_up', 'mixed'],
      vol:   ['low', 'normal', 'high'],
    },
    direction: 'long',
    tags: ['ibs', 'india', 'volume', 'atr', 'liquidity', 'experimental'],
    source: 'profitable',
    pineFile: 'ibs_india_swing.pine',
    tvBacktestable: true,
    backtestable: true,
    notes: 'Phase G.2: Tested 7 NSE large-caps × 4y under india_delivery costs. Only HDFCBANK profitable (PF 1.31); other 6 lose. No tested param combo rescued the strategy. Demoted to experimental — needs signal-logic redesign before re-promotion.',
  },
  ibs_india_intraday: {
    code: 'ibs_india_intraday',
    name: 'IBS India Intraday (Experimental)',
    description: 'Strict IBS < 0.25 + session VWAP for intraday mean-reversion. NSE 09:30-14:30 entry, 15:00 force-exit.',
    family: 'mean_reversion',
    style: 'intraday',
    tier: 'experimental',
    timeframes: ['5m', '15m'],
    // Intraday: avoid only crisis vol (regime is computed on intraday bars but the
    // 50-bar lookback still gives a useful relative read on volatility)
    regimeAffinity: {
      vol: ['low', 'normal', 'high'],
    },
    direction: 'long',
    tags: ['ibs', 'india', 'vwap', 'intraday', 'session', 'experimental'],
    source: 'profitable',
    pineFile: 'ibs_india_intraday.pine',
    tvBacktestable: true,
    backtestable: true,
    notes: 'Phase G.3: 27-combo sweep on RELIANCE 5m × 60d showed WR 13-16%, PF 0.12-0.18 across all params. Demoted to experimental — same fundamental issue as ibs_india_swing.',
  },

  // ── Fibonacci / Retracement ──────────────────────────────────────
  fibonacci_india_swing: {
    code: 'fibonacci_india_swing',
    name: 'Fibonacci Retracement India Swing (Experimental)',
    description: 'Buy 0.382/0.5/0.618 retracements in an uptrend with volume + IBS pre-confirm.',
    family: 'mean_reversion',
    style: 'swing',
    tier: 'experimental',
    timeframes: ['4h', '1D'],
    regimeAffinity: {
      trend: ['trending_up', 'trending_down'],
      vol:   ['low', 'normal', 'high'],
    },
    direction: 'both',
    tags: ['fibonacci', 'india', 'retracement', 'experimental'],
    source: 'profitable',
    pineFile: 'fibonacci_india_swing.pine',
    tvBacktestable: true,
    backtestable: true,
    notes: 'Phase H: DEMOTED. 4y large-cap sweep: best combo 6/10 profitable but net -86.4%. No universal edge across the basket. Per-symbol calibration works (RELIANCE PF 3.44, BAJFINANCE +26%) but basket deployment loses money.',
  },

  // ── Trend Following ──────────────────────────────────────────────
  trend_200sma_positional: {
    code: 'trend_200sma_positional',
    name: '200-SMA Trend Positional',
    description: 'Long-only when price > 200-SMA. Multi-tier exit (20-SMA trail / -12% hard SL / ATR×3 trail).',
    family: 'trend_following',
    style: 'positional',
    tier: 'production',
    timeframes: ['1D', '1W'],
    // Trend-follow only fires in confirmed uptrend. Mixed/sideways added to allow
    // early-stage breakouts to build positions.
    regimeAffinity: {
      trend: ['trending_up', 'mixed'],
      vol:   ['low', 'normal', 'high'],
    },
    direction: 'long',
    tags: ['sma', 'trend', 'positional', 'india'],
    source: 'untested', // promoted to production after Phase G validation, file stays in untested/ for now
    pineFile: 'trend_200sma_positional.pine',
    tvBacktestable: true,
    backtestable: true,
    tunedParams: { trendLen: 200, fastLen: 20, volMult: 1.5, tp: 25, sl: 12, maxBars: 250 },
    notes: 'Phase H: Re-validated across cap tiers. large_cap +23.8% (3/10), mid_cap +92.9% (6/10), small_cap +98.3% (6/10). Best universal: fastLen=20, sl=12, tp=25, volMult=1.5. Use as portfolio rotation across mid/small-cap for highest edge.',
  },

  // ══════════════════════════════════════════════════════════════════
  // EXPERIMENTAL TIER — research / unvalidated, hidden by default in UI
  // ══════════════════════════════════════════════════════════════════

  overnight_swing: {
    code: 'overnight_swing',
    name: 'Overnight Swing (Experimental)',
    description: 'Strong-close continuation: enter at close, exit at next open. Skips Thursdays and pre-holiday entries.',
    family: 'calendar',
    style: 'swing',
    tier: 'experimental',
    timeframes: ['1D'],
    regimeAffinity: {
      trend:    ['trending_up'],
      vol:      ['low', 'normal'],
      momentum: ['up', 'up_strong'],
    },
    direction: 'long',
    tags: ['overnight', 'calendar', 'experimental'],
    source: 'untested',
    pineFile: 'overnight_swing.pine',
    tvBacktestable: true,
    backtestable: true,
  },
  monday_reversal: {
    code: 'monday_reversal',
    name: 'Monday Reversal (Experimental)',
    description: 'Calendar reversal: Monday gap-up → short signal; Monday gap-down → long signal. ATR-based thresholds.',
    family: 'calendar',
    style: 'swing',
    tier: 'experimental',
    timeframes: ['1D'],
    regimeAffinity: {
      trend:    ['ranging', 'mixed'],
      vol:      ['normal', 'high'],
      momentum: ['flat', 'down', 'up'],
    },
    direction: 'both',
    tags: ['calendar', 'reversal', 'monday', 'experimental'],
    source: 'untested',
    pineFile: 'monday_reversal.pine',
    tvBacktestable: true,
    backtestable: false, // Phase B will port to JS
  },
  ibs_mean_reversion: {
    code: 'ibs_mean_reversion',
    name: 'IBS Mean Reversion (Baseline)',
    description: 'Provisional: research baseline for IBS. May be deprecated in Phase G if ibs_india_swing clearly outperforms.',
    family: 'mean_reversion',
    style: 'swing',
    tier: 'experimental',
    timeframes: ['1D'],
    regimeAffinity: {
      trend:    ['ranging'],
      vol:      ['low', 'normal'],
      momentum: ['flat', 'down'],
    },
    direction: 'long',
    tags: ['ibs', 'baseline', 'experimental'],
    source: 'untested',
    pineFile: 'ibs_mean_reversion.pine',
    tvBacktestable: true,
    backtestable: false, // Phase B may port to JS only if kept
  },

  // ── Generic intraday templates (Phase 1: risk-managed + JS-wired) ────────
  // Originally Pine-only templates with no stops. Phase 1 added percentage
  // TP/SL + volume confirmation (Pine canonical) and ported to JS so the engine
  // can backtest/tune them. Experimental until basket-validated (Phase 3).
  movingaverage_intraday: {
    code: 'movingaverage_intraday',
    name: 'MA Crossover Intraday (Experimental)',
    description: 'SMA(short)×SMA(long) crossover with volume confirmation and % TP/SL. Intraday trend-follow.',
    family: 'trend_following',
    style: 'intraday',
    tier: 'experimental',
    timeframes: ['15m', '1h', '1D'],
    regimeAffinity: {
      trend: ['trending_up', 'trending_down', 'mixed'],
      vol:   ['low', 'normal', 'high'],
    },
    direction: 'both',
    tags: ['sma', 'crossover', 'intraday', 'trend', 'experimental'],
    source: 'profitable',
    pineFile: 'movingaverage_intraday.pine',
    tvBacktestable: true,
    backtestable: true,
    notes: 'Phase 1: added % TP/SL (1.5/1.0) + volume filter to the original stop-less template. Pending basket tuning. JS engine is session-agnostic — 1D is authoritative; intraday is a signal approximation.',
  },
  dual_movingaverage_intraday: {
    code: 'dual_movingaverage_intraday',
    name: 'Dual MA + Angle Intraday (Experimental)',
    description: 'SMA(fast)×SMA(slow) crossover gated by slope angle, with volume confirmation and % TP/SL.',
    family: 'trend_following',
    style: 'intraday',
    tier: 'experimental',
    timeframes: ['15m', '1h', '1D'],
    regimeAffinity: {
      trend: ['trending_up', 'trending_down', 'mixed'],
      vol:   ['low', 'normal', 'high'],
    },
    direction: 'both',
    tags: ['sma', 'crossover', 'angle', 'intraday', 'trend', 'experimental'],
    source: 'profitable',
    pineFile: 'dual_movingaverage_intraday.pine',
    tvBacktestable: true,
    backtestable: true,
    notes: 'Phase 1: CRITICAL fix — original had no stops AND held overnight. Added session square-off + % TP/SL (1.5/1.0) + volume filter. Pending basket tuning.',
  },
  ema_rsi_intraday: {
    code: 'ema_rsi_intraday',
    name: 'EMA Stack + RSI Intraday',
    description: 'Triple-EMA trend stack (10/20/100) with RSI exit, volume confirmation and % TP/SL. Profitable on 15m across bank/IT/pharma/large-cap.',
    family: 'trend_following',
    style: 'intraday',
    tier: 'production',
    timeframes: ['15m', '1h'],
    regimeAffinity: {
      trend: ['trending_up', 'trending_down', 'mixed'],
      vol:   ['low', 'normal', 'high'],
    },
    direction: 'both',
    tags: ['ema', 'rsi', 'intraday', 'trend'],
    source: 'profitable',
    pineFile: 'ema_rsi_intraday.pine',
    tvBacktestable: true,
    backtestable: true,
    tunedParams: { emaA: 10, emaB: 20, emaC: 100, rsiLen: 14, rsiExitLong: 70, rsiExitShort: 30, volLen: 20, volMult: 1, tp: 3.0, sl: 1.5, maxBars: 48 },
    notes: 'Phase H: PROMOTED. 55d cross-basket validation on 15m: bank 9/10 (+13.3%), IT 8/10 (+7.1%), pharma 7/10 (+8.8%), large_cap 7/10 (+5.9%), mid_cap 7/10 (+0.2%). Best sectors: bank, IT, pharma. Weak on auto/metal (4/10). Universal params: rsiExitLong=70, volMult=1, tp=3, sl=1.5, maxBars=48.',
  },
  supertrend_intraday: {
    code: 'supertrend_intraday',
    name: 'Supertrend Intraday (Experimental)',
    description: 'ATR Supertrend flip entries with volume confirmation and % TP/SL. Intraday trend-follow.',
    family: 'trend_following',
    style: 'intraday',
    tier: 'experimental',
    timeframes: ['15m', '1h', '1D'],
    regimeAffinity: {
      trend: ['trending_up', 'trending_down', 'mixed'],
      vol:   ['low', 'normal', 'high'],
    },
    direction: 'both',
    tags: ['supertrend', 'atr', 'intraday', 'trend', 'experimental'],
    source: 'profitable',
    pineFile: 'supertrend_intraday.pine',
    tvBacktestable: true,
    backtestable: true,
    notes: 'Phase 1: switched entry from every-bar-above-line to flip-only (crossover), added % TP/SL (2.0/1.5) + volume filter. Pending basket tuning.',
  },

  // ── Master Strategy (Phase H: quality-gated composite) ───────────────────
  master_intraday: {
    code: 'master_intraday',
    name: 'Master Intraday (Quality-Gated)',
    description: 'EMA cross + Supertrend regime + 5-axis quality gate. Quality-enhanced ema_rsi — fewer trades, higher WR.',
    family: 'hybrid',
    style: 'intraday',
    tier: 'production',
    timeframes: ['15m'],
    regimeAffinity: {
      trend: ['trending_up', 'trending_down'],
      vol:   ['normal', 'high'],
    },
    direction: 'both',
    tags: ['master', 'quality', 'ema', 'supertrend', 'rsi', 'intraday'],
    source: 'profitable',
    pineFile: 'master_intraday.pine',
    tvBacktestable: false,  // Pine to be created
    backtestable: true,
    tunedParams: {
      emaFast: 10, emaMid: 20, emaSlow: 100,
      stPeriod: 14, stMult: 3,
      qualityThreshold: 60,
      volLen: 20, volMult: 1.0,
      rsiLen: 14, rsiExitLong: 70, rsiExitShort: 30,
      tp: 3.0, sl: 1.5, maxBars: 48,
      cooldownBars: 5, minMovePct: 0.3,
    },
    notes: 'Phase H: Cross-based entry (from ema_rsi_intraday) + Supertrend regime filter + quality gate (q=60). Bank 15m: +9.1%, 71% WR, 7/10 profitable. IT 15m: +2.1%, 67% WR, 5/10 profitable. Fewer trades than ema_rsi (17 vs 41) but higher PnL due to better selectivity.',
  },
});

// ══════════════════════════════════════════════════════════════════
// Helpers for Pine source resolution
// ══════════════════════════════════════════════════════════════════

/**
 * Resolve a strategy code to its absolute Pine file path inside `pdf/{source}/`.
 * Returns null if the strategy has no Pine source or is not TV-backtestable.
 */
export function getPineFilePath(code) {
  const meta = STRATEGY_REGISTRY[code];
  if (!meta || !meta.tvBacktestable || !meta.pineFile) return null;
  return `${meta.source}/${meta.pineFile}`;
}

/** List only strategies that can be run through the TV Strategy Tester. */
export function listTvBacktestable() {
  return Object.values(STRATEGY_REGISTRY).filter(s => s.tvBacktestable);
}

export const STRATEGY_CODES = Object.freeze(Object.keys(STRATEGY_REGISTRY));

export const STRATEGY_FAMILIES = Object.freeze([
  'mean_reversion',
  'trend_following',
  'momentum',
  'breakout',
  'gap',
  'calendar',
  'hybrid',
]);

export const STRATEGY_TIERS = Object.freeze(['production', 'experimental']);

export function getStrategy(code) {
  return STRATEGY_REGISTRY[code] || null;
}

export function listStrategies({ family, style, source, tier, backtestableOnly = true } = {}) {
  return Object.values(STRATEGY_REGISTRY).filter(s => {
    if (backtestableOnly && !s.backtestable) return false;
    if (family && s.family !== family) return false;
    if (style && s.style !== style) return false;
    if (source && s.source !== source) return false;
    if (tier && s.tier !== tier) return false;
    return true;
  });
}

/** List only production-tier strategies (default UI surface). */
export function listProduction({ backtestableOnly = true } = {}) {
  return listStrategies({ tier: 'production', backtestableOnly });
}

/** List only experimental-tier strategies (opt-in UI). */
export function listExperimental({ backtestableOnly = false } = {}) {
  return listStrategies({ tier: 'experimental', backtestableOnly });
}

/**
 * Filter strategies whose affinity matches a regime label or composite.
 *
 *   strategiesForRegime('trending_up')                  // legacy (trend axis)
 *   strategiesForRegime({ trend, vol, momentum })       // composite
 */
export function strategiesForRegime(regime) {
  return Object.values(STRATEGY_REGISTRY).filter(s => {
    const aff = s.regimeAffinity;
    if (!aff) return true;
    const label = typeof regime === 'string' ? regime : regime?.trend;
    return matchesRegimeAffinity(aff, label);
  });
}

export function strategiesForTimeframe(timeframe) {
  return Object.values(STRATEGY_REGISTRY).filter(s => s.timeframes?.includes(timeframe));
}
