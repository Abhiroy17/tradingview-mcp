/**
 * Runner — bar-by-bar backtest engine.
 *
 * Cleanly separated from any specific strategy. Calling code passes a
 * `signalFn(ctx)` that returns `{entry, exitSignal}` per bar, plus the
 * trade-management params `{tp, sl, maxBars}`.
 *
 * Improvements over dashboard.js's `backtestLoop`:
 *   - Pure function; no module-level state
 *   - Symbol & timeframe propagate into the result (so callers can write
 *     to DB without re-tagging)
 *   - Mode flag short-circuits historical iteration when `mode === 'live'`
 *     (only evaluates the last bar for currentSignal)
 *   - Configurable execution defaults (TXN_COST_BPS, SLIPPAGE_BPS, capital)
 */

import { Quant } from './quant.js';
import { atrSeries, emaSeries } from './indicators.js';
import { compositeRegime, passesRegimeGate } from './regimes.js';

export const DEFAULT_EXECUTION = Object.freeze({
  initialCapital: 100000,
  positionSizePct: 100,
  txnCostBps: 10,           // round-trip cost (entry + exit), in basis points
  slippageBps: 5,           // adverse slippage per fill
  slippageMode: 'flat',     // 'flat' | 'atr_adaptive'
  slippageAtrMult: 0.05,    // adaptive: slippage_bps = atr_pct * 100 * mult * 100, floored at 1 bp
  oosSplit: 0.7,            // train 70%, test 30%
  costsPreset: null,        // 'india_delivery' | 'india_intraday' | 'us_equity' | null
  allowShorts: true,        // when false, signalFn shorts are rejected (long-only behaviour)
  gateOnRegime: false,      // when true, entries only fire if compositeRegime ∈ regimeAffinity
});

/**
 * Round-trip cost presets (in basis points) covering brokerage + STT + stamp +
 * exchange + GST + SEBI fees. Slippage is a separate adverse-fill estimate.
 *
 *   india_delivery  ≈ 18 bps round-trip (T+1 cash equity, full STT 0.1% on sell)
 *   india_intraday  ≈ 11 bps round-trip (intraday equity, STT 0.025% on sell)
 *   us_equity       ≈  5 bps round-trip (Interactive Brokers tier-1)
 */
export const COSTS_PRESETS = Object.freeze({
  india_delivery: { txnCostBps: 18, slippageBps: 8 },
  india_intraday: { txnCostBps: 11, slippageBps: 5 },
  us_equity:      { txnCostBps: 5,  slippageBps: 3 },
});

/**
 * detectRegime — lightweight per-bar regime tag using ADX + EMA cross.
 * Returns: 'trending_up' | 'trending_down' | 'ranging' | 'mixed' | 'unknown'.
 */
export function detectRegimeAt(bars, i, lookback = 50) {
  if (i < lookback) return 'unknown';
  const slice = bars.closes.slice(Math.max(0, i - lookback + 1), i + 1);
  const sliceH = bars.highs.slice(Math.max(0, i - lookback + 1), i + 1);
  const sliceL = bars.lows.slice(Math.max(0, i - lookback + 1), i + 1);
  const adxVal = Quant.adx(sliceH, sliceL, slice, 14);
  const ema9 = emaSeries(slice, 9);
  const ema21 = emaSeries(slice, 21);
  const last = slice.length - 1;
  const trendUp = ema9[last] && ema21[last] && ema9[last] > ema21[last];
  const trendDown = ema9[last] && ema21[last] && ema9[last] < ema21[last];
  if (adxVal && adxVal > 25 && trendUp) return 'trending_up';
  if (adxVal && adxVal > 25 && trendDown) return 'trending_down';
  if (adxVal && adxVal < 18) return 'ranging';
  return 'mixed';
}

/**
 * runBacktest — walk through bars, simulate trades, compute metrics.
 *
 * @param {Object} input
 * @param {Object} input.bars - {opens, highs, lows, closes, volumes, times}
 * @param {Function} input.signalFn - (ctx) => {entry, exitSignal}
 * @param {Object} input.exitRules - {tp, sl, maxBars}
 * @param {Object} [input.execution] - override DEFAULT_EXECUTION
 * @param {number} [input.startIdx=30] - first bar to evaluate
 * @param {string} [input.symbol] - propagated to result
 * @param {string} [input.timeframe] - propagated to result
 *
 * @returns {Object} result {trades, equity, metrics, currentSignal, regimePerformance, ...}
 */
export function runBacktest({
  bars,
  signalFn,
  exitRules,
  execution = DEFAULT_EXECUTION,
  startIdx = 30,
  symbol = null,
  timeframe = null,
  regimeAffinity = null,    // legacy array OR { trend:[], vol:[], momentum:[] }
}) {
  const { tp, sl, maxBars } = exitRules;
  // Resolve cost preset (preset → then user overrides on top)
  const merged = { ...DEFAULT_EXECUTION, ...execution };
  if (merged.costsPreset && COSTS_PRESETS[merged.costsPreset]) {
    const preset = COSTS_PRESETS[merged.costsPreset];
    if (execution?.txnCostBps === undefined) merged.txnCostBps = preset.txnCostBps;
    if (execution?.slippageBps === undefined) merged.slippageBps = preset.slippageBps;
  }
  const {
    initialCapital,
    positionSizePct,
    txnCostBps,
    slippageBps: baseSlippageBps,
    slippageMode,
    slippageAtrMult,
    oosSplit,
    allowShorts,
    gateOnRegime,
  } = merged;

  const costPct = (txnCostBps) / 100;       // round-trip drag (% of trade)
  const totalBars = bars.closes.length;

  if (totalBars < startIdx + 10) {
    return _emptyResult({ symbol, timeframe, reason: 'insufficient_bars', totalBars });
  }

  // Pre-compute ATR series for adaptive slippage (cheap; reused across bars)
  const atrArr = slippageMode === 'atr_adaptive'
    ? atrSeries(bars.highs, bars.lows, bars.closes, 14)
    : null;

  // Per-bar slippage in bps. Adaptive mode: floor of 1 bp, scaled by ATR%.
  const slippageBpsAt = (i) => {
    if (slippageMode !== 'atr_adaptive' || !atrArr || !atrArr[i] || !bars.closes[i]) {
      return baseSlippageBps;
    }
    const atrPct = (atrArr[i] / bars.closes[i]) * 100;
    return Math.max(1, atrPct * 100 * slippageAtrMult);
  };

  // Pre-compute regime tags (lazy: only for bars we evaluate)
  // Two layers: legacy single-string label (for trade.regime backward compat) +
  //             composite { trend, vol, momentum } object (for gating).
  const regimeAtBar = new Array(totalBars).fill('unknown');
  const compositeAtBar = new Array(totalBars).fill(null);
  const minRegimeIdx = Math.max(50, startIdx);
  for (let i = minRegimeIdx; i < totalBars; i++) {
    const composite = compositeRegime(bars, i);
    compositeAtBar[i] = composite;
    regimeAtBar[i] = composite.trend; // legacy label = trend axis
  }

  const oosStartIdx = Math.floor(totalBars * oosSplit);
  const trades = [];
  const equity = [0];
  let state = { inTrade: false, direction: null, entryPrice: 0, entryIdx: 0, signaledAt: -1, signaledDir: null };
  let cumPnl = 0;
  let maxEquity = 0, maxDrawdown = 0;
  let capitalEquity = initialCapital;
  let currentSignal = null;
  let regimeBlockedCount = 0; // entries skipped because regime ∉ affinity

  for (let i = startIdx; i < totalBars; i++) {
    // signalFn may return { entry, exitSignal, direction } — direction defaults to 'long'
    const sig = signalFn({ i, state, bars }) || {};
    const entry      = !!sig.entry;
    const exitSignal = !!sig.exitSignal;
    const sigDir     = sig.direction === 'short' ? 'short' : 'long';

    // ── Step 1: Execute pending entry from previous bar's signal ─────────
    // Signal on bar j → fill at OPEN of bar j+1 (matches TradingView default).
    if (!state.inTrade && state.signaledAt === i - 1) {
      const openPrice = bars.opens[i] || bars.closes[i];
      const slipBps   = slippageBpsAt(i);
      const slipFrac  = slipBps / 10000;
      const dir       = state.signaledDir || 'long';
      // Long: pay ABOVE open (adverse). Short: receive BELOW open (adverse).
      const fill = dir === 'short'
        ? openPrice * (1 - slipFrac)
        : openPrice * (1 + slipFrac);
      state = { inTrade: true, direction: dir, entryPrice: fill, entryIdx: i, signaledAt: -1, signaledDir: null };
    }

    // ── Step 2: Check exits intrabar (TP/SL via high/low, then signal/maxbars at close) ──
    // CRITICAL: TP/SL must be checked against bar HIGH/LOW, not close.
    // Direction-aware:
    //   Long :  TP above entry (high ≥ tpPrice), SL below entry (low ≤ slPrice)
    //   Short:  TP below entry (low ≤ tpPrice),  SL above entry (high ≥ slPrice)
    if (state.inTrade) {
      const high  = bars.highs[i];
      const low   = bars.lows[i];
      const open  = bars.opens[i];
      const close = bars.closes[i];
      const dir   = state.direction;
      const isLong = dir === 'long';

      const tpPrice = tp > 0
        ? state.entryPrice * (isLong ? (1 + tp / 100) : (1 - tp / 100))
        : (isLong ? Infinity  : -Infinity);
      const slPrice = sl > 0
        ? state.entryPrice * (isLong ? (1 - sl / 100) : (1 + sl / 100))
        : (isLong ? -Infinity : Infinity);
      const barsHeld = i - state.entryIdx;

      const tpHit = isLong ? high >= tpPrice : low  <= tpPrice;
      const slHit = isLong ? low  <= slPrice : high >= slPrice;

      let exitReason = null;
      let exitTrigger = close;  // pre-slippage trigger price

      if (tpHit && slHit) {
        // Both touched within same bar → ambiguous fill order.
        // Pessimistic default: SL fires first.
        if (isLong) {
          if      (open >= tpPrice) { exitReason = 'TP'; exitTrigger = open; }
          else if (open <= slPrice) { exitReason = 'SL'; exitTrigger = open; }
          else                      { exitReason = 'SL'; exitTrigger = slPrice; }
        } else {
          if      (open <= tpPrice) { exitReason = 'TP'; exitTrigger = open; }
          else if (open >= slPrice) { exitReason = 'SL'; exitTrigger = open; }
          else                      { exitReason = 'SL'; exitTrigger = slPrice; }
        }
      } else if (tpHit) {
        exitReason = 'TP';
        // Gap THROUGH TP → fill at open (better than TP). Else fill at TP price.
        if (isLong)  exitTrigger = open > tpPrice ? open : tpPrice;
        else         exitTrigger = open < tpPrice ? open : tpPrice;
      } else if (slHit) {
        exitReason = 'SL';
        // Gap THROUGH SL → fill at open (worse than SL — realistic gap slippage).
        if (isLong)  exitTrigger = open < slPrice ? open : slPrice;
        else         exitTrigger = open > slPrice ? open : slPrice;
      } else if (barsHeld >= maxBars) {
        exitReason  = 'MAX_BARS';
        exitTrigger = close;
      } else if (exitSignal) {
        exitReason  = 'SIGNAL';
        exitTrigger = close;
      }

      if (exitReason) {
        // Apply exit slippage (always adverse to position direction)
        const slipBps  = slippageBpsAt(i);
        const slipFrac = slipBps / 10000;
        // Long  exit (sell): receive BELOW trigger. Short exit (cover, buy): pay ABOVE trigger.
        const exitPrice = isLong
          ? exitTrigger * (1 - slipFrac)
          : exitTrigger * (1 + slipFrac);

        // Direction-aware PnL
        const finalGross = isLong
          ? ((exitPrice - state.entryPrice) / state.entryPrice) * 100
          : ((state.entryPrice - exitPrice) / state.entryPrice) * 100;
        const finalNet = finalGross - costPct;
        cumPnl += finalNet;
        const positionValue = capitalEquity * (positionSizePct / 100);
        const absProfit = positionValue * (finalNet / 100);
        capitalEquity += absProfit;
        trades.push({
          entryIdx: state.entryIdx,
          exitIdx: i,
          entryTime: bars.times?.[state.entryIdx] ?? null,
          exitTime: bars.times?.[i] ?? null,
          entryPrice: state.entryPrice,
          exitPrice,
          direction: dir,
          pnl: parseFloat(finalNet.toFixed(3)),
          grossPnl: parseFloat(finalGross.toFixed(3)),
          absProfit: Math.round(absProfit),
          barsHeld,
          exitReason,
          regime: regimeAtBar[state.entryIdx] || 'unknown',
          isOOS: state.entryIdx >= oosStartIdx,
        });
        state = { inTrade: false, direction: null, entryPrice: 0, entryIdx: 0, signaledAt: -1, signaledDir: null };
      }
    }

    // ── Step 3: Register new entry signal (executes at NEXT bar's open) ──
    if (!state.inTrade && entry && state.signaledAt !== i) {
      // Reject short signals when allowShorts=false (treat as no-op)
      const dirAllowed = sigDir !== 'short' || allowShorts;
      // Regime gate: skip entries when current bar's regime ∉ strategy affinity
      const regimeAllowed = !gateOnRegime || !regimeAffinity
        || passesRegimeGate(compositeAtBar[i], regimeAffinity);
      if (dirAllowed && regimeAllowed) {
        state.signaledAt  = i;
        state.signaledDir = sigDir;
      } else if (dirAllowed && !regimeAllowed) {
        regimeBlockedCount++;
      }
    }

    equity.push(parseFloat(cumPnl.toFixed(3)));
    maxEquity = Math.max(maxEquity, cumPnl);
    maxDrawdown = Math.max(maxDrawdown, maxEquity - cumPnl);

    if (i === totalBars - 1) {
      if (state.inTrade) {
        const isLong = state.direction === 'long';
        const grossPnl = isLong
          ? ((bars.closes[i] - state.entryPrice) / state.entryPrice) * 100
          : ((state.entryPrice - bars.closes[i]) / state.entryPrice) * 100;
        const netPnl = grossPnl - costPct;
        currentSignal = {
          type: 'IN_TRADE',
          direction: state.direction,
          entryPrice: state.entryPrice,
          unrealizedPnl: parseFloat(netPnl.toFixed(2)),
          barsHeld: i - state.entryIdx,
        };
      } else if (state.signaledAt === i) {
        currentSignal = {
          type: state.signaledDir === 'short' ? 'SELL' : 'BUY',
          direction: state.signaledDir || 'long',
          price: bars.closes[i],
          reason: 'Entry on next bar open',
        };
      } else {
        const probe = signalFn({
          i,
          state: { inTrade: false, direction: null, entryPrice: 0, entryIdx: 0, signaledAt: -1, signaledDir: null },
          bars,
        }) || {};
        const probeDir = probe.direction === 'short' ? 'short' : 'long';
        const allowed  = probeDir !== 'short' || allowShorts;
        currentSignal = {
          type: probe.entry && allowed ? (probeDir === 'short' ? 'SELL' : 'BUY') : 'WAIT',
          direction: probeDir,
          price: bars.closes[i],
        };
      }
    }
  }

  return _buildMetrics({
    symbol, timeframe, totalBars, startIdx,
    initialCapital, positionSizePct, oosStartIdx,
    trades, equity, currentSignal, maxDrawdown, capitalEquity,
    regimeBlockedCount,
  });
}

/**
 * runLiveSignal — evaluate signalFn ONCE on the last bar.
 *
 * Use for live monitor / multi-symbol scanner where you only need to know
 * "is this strategy firing right now?" without computing the full backtest.
 */
export function runLiveSignal({ bars, signalFn, lookback = 200, allowShorts = true }) {
  const totalBars = bars.closes.length;
  if (totalBars < 30) {
    return { currentSignal: { type: 'WAIT', reason: 'insufficient_bars' } };
  }
  const i = totalBars - 1;
  const startIdx = Math.max(30, totalBars - lookback);
  // Replay last few bars to build any state the signalFn might need
  // (most signalFns are stateless across bars; this is defensive)
  for (let j = startIdx; j < i; j++) {
    signalFn({ i: j, state: { inTrade: false, direction: null, entryPrice: 0, entryIdx: 0, signaledAt: -1, signaledDir: null }, bars });
  }
  const probe = signalFn({
    i,
    state: { inTrade: false, direction: null, entryPrice: 0, entryIdx: 0, signaledAt: -1, signaledDir: null },
    bars,
  }) || {};
  const probeDir = probe.direction === 'short' ? 'short' : 'long';
  const allowed  = probeDir !== 'short' || allowShorts;
  return {
    currentSignal: {
      type: probe.entry && allowed ? (probeDir === 'short' ? 'SELL' : 'BUY') : 'WAIT',
      direction: probeDir,
      price: bars.closes[i],
    },
    regime: detectRegimeAt(bars, i),
  };
}

// ── Internal: metric calculation ─────────────────────────────────────────

function _buildMetrics({
  symbol, timeframe, totalBars, startIdx,
  initialCapital, positionSizePct, oosStartIdx,
  trades, equity, currentSignal, maxDrawdown, capitalEquity,
  regimeBlockedCount = 0,
}) {
  const wins = trades.filter(t => t.pnl > 0);
  const losses = trades.filter(t => t.pnl <= 0);
  const totalPnl = trades.reduce((s, t) => s + t.pnl, 0);
  const avgWin = wins.length ? wins.reduce((s, t) => s + t.pnl, 0) / wins.length : 0;
  const avgLoss = losses.length ? Math.abs(losses.reduce((s, t) => s + t.pnl, 0) / losses.length) : 0;
  const profitFactor = avgLoss > 0
    ? (avgWin * wins.length) / (avgLoss * losses.length)
    : wins.length > 0 ? 99 : 0;
  const avgBarsHeld = trades.length ? trades.reduce((s, t) => s + t.barsHeld, 0) / trades.length : 0;
  const expectancy = trades.length ? totalPnl / trades.length : 0;
  const tradeReturns = trades.map(t => t.pnl);
  const stats = Quant.stats(tradeReturns);
  const sharpe = stats.std > 0 ? stats.mean / stats.std : 0;

  const wilsonWR = trades.length ? Quant.wilsonLower(wins.length, trades.length) : 0;
  const psr = Quant.probabilisticSharpe(tradeReturns, 0);
  const sortino = Quant.sortino(tradeReturns, 0);
  const calmar = Quant.calmar(totalPnl, maxDrawdown);
  const ulcer = Quant.ulcerIndex(equity);
  const bootstrap = Quant.bootstrapMean(tradeReturns, 500, 0.95);

  const oosTrades = trades.filter(t => t.isOOS);
  const oosWins = oosTrades.filter(t => t.pnl > 0);
  const oosTotalPnl = oosTrades.reduce((s, t) => s + t.pnl, 0);

  const regimeStats = {};
  for (const t of trades) {
    if (!regimeStats[t.regime]) regimeStats[t.regime] = { count: 0, wins: 0, pnl: 0 };
    regimeStats[t.regime].count++;
    if (t.pnl > 0) regimeStats[t.regime].wins++;
    regimeStats[t.regime].pnl += t.pnl;
  }
  for (const r of Object.keys(regimeStats)) {
    const rs = regimeStats[r];
    rs.winRate = rs.count ? Math.round((rs.wins / rs.count) * 100) : 0;
    rs.avgPnl = rs.count ? parseFloat((rs.pnl / rs.count).toFixed(2)) : 0;
    rs.totalPnl = parseFloat(rs.pnl.toFixed(2));
  }

  // Compress equity curve for transmission (sample ~50 points)
  const equityCompact = equity.length > 50
    ? equity.filter((_, i) => i % Math.ceil(equity.length / 50) === 0 || i === equity.length - 1)
    : equity;

  return {
    symbol,
    timeframe,
    totalTrades: trades.length,
    wins: wins.length,
    losses: losses.length,
    winRate: trades.length ? Math.round((wins.length / trades.length) * 100) : 0,
    totalPnl: parseFloat(totalPnl.toFixed(2)),
    avgWin: parseFloat(avgWin.toFixed(2)),
    avgLoss: parseFloat(avgLoss.toFixed(2)),
    profitFactor: parseFloat(profitFactor.toFixed(2)),
    maxDrawdown: parseFloat(maxDrawdown.toFixed(2)),
    expectancy: parseFloat(expectancy.toFixed(2)),
    sharpe: parseFloat(sharpe.toFixed(2)),
    avgBarsHeld: Math.round(avgBarsHeld),
    equity: equityCompact,
    equityFull: equity, // full series for DB persistence (Phase 2)
    trades, // full trade list (caller can slice for UI)
    tradesPreview: trades.slice(-10),
    currentSignal,
    barsAnalyzed: totalBars - startIdx,

    capital: {
      initial: initialCapital,
      final: Math.round(capitalEquity),
      netProfit: Math.round(capitalEquity - initialCapital),
      returnPct: parseFloat(((capitalEquity - initialCapital) / initialCapital * 100).toFixed(2)),
      positionSizePct,
      maxPositionValue: Math.round(initialCapital * positionSizePct / 100),
      maxDrawdownRs: Math.round(maxDrawdown * positionSizePct / 100 * initialCapital / 100),
    },

    wilsonWR: parseFloat((wilsonWR * 100).toFixed(1)),
    psr: parseFloat((psr * 100).toFixed(1)),
    sortino: parseFloat(sortino.toFixed(2)),
    calmar: parseFloat(calmar.toFixed(2)),
    ulcer: parseFloat(ulcer.toFixed(2)),
    bootstrap95: {
      lower: parseFloat(bootstrap.lower.toFixed(2)),
      upper: parseFloat(bootstrap.upper.toFixed(2)),
    },
    skew: parseFloat(stats.skew.toFixed(2)),
    kurtosis: parseFloat(stats.kurt.toFixed(2)),

    oos: {
      trades: oosTrades.length,
      winRate: oosTrades.length ? Math.round((oosWins.length / oosTrades.length) * 100) : 0,
      wilsonWR: oosTrades.length
        ? parseFloat((Quant.wilsonLower(oosWins.length, oosTrades.length) * 100).toFixed(1))
        : 0,
      totalPnl: parseFloat(oosTotalPnl.toFixed(2)),
    },

    regimePerformance: regimeStats,
    regimeBlocked: regimeBlockedCount,
  };
}

function _emptyResult({ symbol, timeframe, reason, totalBars }) {
  return {
    symbol, timeframe,
    totalTrades: 0, wins: 0, losses: 0, winRate: 0,
    totalPnl: 0, avgWin: 0, avgLoss: 0,
    profitFactor: 0, maxDrawdown: 0, expectancy: 0, sharpe: 0,
    avgBarsHeld: 0, equity: [], trades: [], tradesPreview: [],
    currentSignal: { type: 'WAIT', reason },
    barsAnalyzed: totalBars,
    capital: { initial: DEFAULT_EXECUTION.initialCapital, final: DEFAULT_EXECUTION.initialCapital, netProfit: 0, returnPct: 0 },
    wilsonWR: 0, psr: 0, sortino: 0, calmar: 0, ulcer: 0,
    bootstrap95: { lower: 0, upper: 0 }, skew: 0, kurtosis: 0,
    oos: { trades: 0, winRate: 0, wilsonWR: 0, totalPnl: 0 },
    regimePerformance: {},
  };
}
