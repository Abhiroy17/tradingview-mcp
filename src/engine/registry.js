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
 * --- Roster (post-Phase-I) ---
 * Production tier (3): trend_200sma_positional, ema_rsi_intraday, master_intraday.
 * Experimental tier (10): fibonacci_india_swing (demoted H), ibs_india_swing,
 *                        ibs_india_intraday, overnight_swing,
 *                        monday_reversal, ibs_mean_reversion, movingaverage_intraday,
 *                        dual_movingaverage_intraday, supertrend_intraday,
 *                        phoenix_force_india_intraday.
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
    tunedParams: { ibsEntry: 0.20, useMacd: true, useRsi: false, tp: 2.5, sl: 1.5, maxBars: 3 },
    notes: 'Phase G.2: only HDFCBANK profitable (PF 1.31); other 6 lose. Phase I: added MACD-histogram-rising confirm + stricter ibsEntry=0.20 (locked defaults). On a mid_cap 4y basket this lifted the strategy from -210.8% (587 tr, 1/10 prof) to -4.3% (83 tr, 4/10 prof) — a +206pp swing; 5/10 prof with execution.gateOnRegime. Stays experimental: deploy with regime gate + per-symbol calibration via scripts/tune-multi.js.',
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
    tunedParams: { ibsEntry: 0.25, useMacd: true, useRsi: false, tp: 0.7, sl: 0.5, maxBars: 12 },
    notes: 'Phase G.3: 27-combo sweep on RELIANCE 5m × 60d showed WR 13-16%, PF 0.12-0.18 across all params. Phase I: added MACD-histogram-rising confirm (locked on). On large_cap 15m (~55d Upstox cap) MACD lifted it from -16.4% (50 tr, WR 14%, 0/10) to -5.6% (23 tr, WR 22%, 1/10) — halves overtrading, ~doubles WR. RSI<30 too strict for 15m (zeroes entries) so opt-in rsiMax relaxed to 40. Still experimental: intraday history is short; needs more data + per-symbol calibration.',
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
    tunedParams: { lookback: 50, tp: 4, sl: 3, maxBars: 20, allowShorts: false, useRsi: true, useMacd: true },
    notes: 'Phase H: DEMOTED (raw retracement lost -86.4% on large-cap basket, no universal edge). Phase I: RE-ENRICHED with optional trend/RSI/MACD/volume filters. RSI+MACD momentum confirmation flips the large-cap basket from -86.4% -> +6.0% (WR 55%, 6/10 profitable, india_delivery 4y). Highly selective (~20 basket trades/4y) so the edge is thin; trend-only filter is a higher-frequency alternative (+1.7%, 197 trades). Stays experimental pending per-symbol calibration + larger sample.',
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
    notes: 'Phase I: added opt-in useRsi(>55)/useMacd(>0) filters (kept OFF by default). 288-combo sweep on large_cap 4y = best -55.1% (WR 13%, 1/10 prof); mid_cap = best -9.3% (WR 23%, 3/10). Filters do NOT rescue the strategy — the overnight gap-up edge simply doesn\'t exist under india_delivery costs. Strategy remains experimental/research-only; do not deploy without fundamental redesign.',
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
    backtestable: true,
    tunedParams: { rsiThresh: 30, volMult: 1.5, tp: 2.0, sl: 0.8, maxBars: 3 },
    notes: 'Phase I: ported to JS engine. Calendar strategy fires ~1/week — sample inherently small (N=29). RSI oversold + volume are the relevant filters; MACD/SMA showed no lift and were removed.',
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
    backtestable: true,
    tunedParams: { ibsThresh: 0.15, tp: 2.0, sl: 1.0, maxBars: 5, useSma: true, useRsi: false, useMacd: true },
    notes: 'Phase I: ported to JS engine (was Pine-only). Added useSma/useRsi/useMacd + maxBars. 288-combo sweep on large_cap 4y: SMA+MACD dominate all top-5 slots. Locked ibsThresh=0.15, SMA on, MACD on → -9.8% (35 tr, WR 34%, 2/10 prof, best +5.5%). Still net-negative; stays experimental; generic baseline for comparison with ibs_india_swing.',
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
    tunedParams: { shortPeriod: 5, longPeriod: 50, volMult: 1.0, tp: 2.5, sl: 1.5, maxBars: 30, useMacd: true, useRsiExit: false },
    notes: 'Phase I: added MACD entry confirm + RSI exit override (opt-in). 384-combo sweep on large_cap 15m ~55d: MACD lifts from -6.1% to -1.7% (same params, 80 tr, WR 36%, 5/10 prof). Locked: shortPeriod=5, longPeriod=50, volMult=1, tp=2.5, sl=1.5, useMacd=true. Near break-even; per-symbol calibration advised.',
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
    tunedParams: { angleThresh: 10, crossWindow: 10, volMult: 1.0, tp: 1.0, sl: 1.5, maxBars: 30, useMacd: true, useRsiExit: false },
    notes: 'Phase I: added MACD entry confirm + RSI exit override (opt-in). 576-combo sweep on large_cap 15m ~55d: MACD+vol+angleThresh=10 best at -17.7% (93 tr, WR 38%, 4/10). Locked: angleThresh=10, crossWindow=10, volMult=1, tp=1, sl=1.5, useMacd=true. Still negative; stays experimental.',
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
    tunedParams: { atrPeriod: 14, multiplier: 3, volMult: 1.0, tp: 2.5, sl: 1.5, maxBars: 30, useMacd: true, useRsiEntry: false, useRsiExit: false },
    notes: 'Phase I: added MACD entry confirm + RSI entry/exit (opt-in). 768-combo sweep on large_cap 15m ~55d: MACD turns strategy NET POSITIVE → +4.2% (83 tr, WR 40%, 7/10 profitable). Locked: multiplier=3, volMult=1, tp=2.5, sl=1.5, useMacd=true. Strong candidate for promotion after multi-sector validation.',
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
      stPeriod: 14, stMult: 4,
      qualityThreshold: 45,
      volLen: 20, volMult: 1.0,
      rsiLen: 14, rsiExitLong: 72, rsiExitShort: 30,
      tp: 2.0, sl: 1.0, maxBars: 48,
      cooldownBars: 5, minMovePct: 0.3,
    },
    notes: 'Phase I: Tuned quality gate + ST mult + risk params. Bank 15m: +18.0% (31 tr, 65% WR, 9/10 prof). IT 15m: +13.8% (37 tr, 65% WR, 10/10 prof). Key changes: stMult 3→4 (fewer false flips), qualityThreshold 60→45 (more trades through), tp 3→2 + sl 1.5→1 (faster exits). 2× improvement over Phase H.',
  },
  // ── Phoenix Force (Phase I: ported from Pine — 4-factor confluence) ─────────
  phoenix_force_india_intraday: {
    code: 'phoenix_force_india_intraday',
    name: 'Phoenix Force India Intraday (4-Factor)',
    description: 'PSAR + EMA(50) trend + MACD + RSI confluence, gated by Choppiness Index + volume + ATR floor.',
    family: 'momentum',
    style: 'intraday',
    tier: 'experimental',
    timeframes: ['5m', '15m', '30m'],
    regimeAffinity: {
      trend: ['trending_up', 'trending_down'],
      vol:   ['normal', 'high'],
    },
    direction: 'both',
    tags: ['psar', 'ema', 'macd', 'rsi', 'choppiness', 'intraday', 'momentum', 'experimental'],
    source: 'untested',
    pineFile: 'phoenix_force_india_intraday.pine',
    tvBacktestable: true,
    backtestable: true,
    tunedParams: { psarStart: 0.02, psarInc: 0.02, psarMax: 0.20, maLen: 50, rsiLen: 14, rsiLongTh: 55, rsiShortTh: 47, ciLen: 14, ciThresh: 42, volMult: 1.0, atrFloor: 0.25, tp: 1.5, sl: 0.8, maxBars: 30, allowShorts: false },
    notes: 'Phase I: Ported from Pine to JS. 4-factor (PSAR+EMA+MACD+RSI) with Choppiness Index trending gate. Large_cap 15m sweep: -8.0% (116 tr, 41% WR, 6/10 prof). Selective — designed for volatile mid-caps (AGIINFRA/MCX/KAYNES). Per-stock presets advised.',
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
