/**
 * TV Strategy Tester runner.
 *
 * Drives a TradingView Desktop chart over CDP to backtest a strategy by:
 *   1. Switching symbol + timeframe
 *   2. Optionally setting a visible date range
 *   3. Injecting Pine Script source from `pdf/{source}/{pineFile}`
 *   4. Compiling + adding to chart (smartCompile)
 *   5. Reading reportData / ordersData / equityData
 *   6. Mapping TV's metrics into the same flat shape the JS engine emits
 *
 * The output is provider-agnostic and slots into the same downstream consumers
 * (DB matrix, ranker, UI) as `runBacktest` from `src/engine/runner.js`. Callers
 * can distinguish providers via `result.provider`.
 *
 * NOTE: This requires TradingView Desktop to be running with CDP on :9222.
 * Concurrency is *not* supported — the chart is global and only one backtest
 * can run at a time. Wrap calls in a queue (see api/v2.js tv endpoints).
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { getStrategy, getPineFilePath } from './registry.js';
import { setSymbol, setTimeframe, setVisibleRange } from '../core/chart.js';
import { setSource, smartCompile, getErrors } from '../core/pine.js';
import { openPanel } from '../core/ui.js';
import { getStrategyResults, getTrades, getEquity } from '../core/data.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..', '..');

const DEFAULT_INITIAL_CAPITAL = 100_000;
const RESULTS_POLL_INTERVAL_MS = 1000;
const RESULTS_POLL_MAX_MS = 10000;

/**
 * Module-level cache of the last compiled strategy.
 * When the same (code, symbol, timeframe) is re-run (e.g. across time windows),
 * we skip setSymbol/setTimeframe/setSource/smartCompile entirely and only
 * change the visible range.
 */
const _lastRun = { code: null, symbol: null, timeframe: null, compiledOk: false };

function num(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

/**
 * Read a numeric field from TV's reportData blob, tolerating multiple shapes:
 *   - direct: { netProfit: 1234 }
 *   - wrapped: { netProfit: { value: 1234 } }
 *   - keyed:   { netProfit: { all: { value: 1234 } } }
 * Tries each candidate key in order and returns the first numeric hit.
 */
function pickNumber(metrics, ...keys) {
  if (!metrics || typeof metrics !== 'object') return 0;
  for (const k of keys) {
    const v = metrics[k];
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    if (v && typeof v === 'object') {
      if (typeof v.value === 'number' && Number.isFinite(v.value)) return v.value;
      if (v.all && typeof v.all.value === 'number' && Number.isFinite(v.all.value)) return v.all.value;
    }
  }
  return 0;
}

/**
 * Map TradingView's strategy reportData / ordersData / equityData into the
 * same flat result shape that `runBacktest` emits, so downstream code (ranker,
 * DB persistence, UI) does not have to branch on provider.
 *
 * Fields TV does not natively report (calmar, ulcer, wilsonWR, OOS split,
 * regime breakdown) are zero-filled — they can be computed post-hoc by the
 * caller using the `equityFull` / `trades` arrays if needed.
 */
export function mapTvMetrics(metrics, equity, trades, { initialCapital = DEFAULT_INITIAL_CAPITAL } = {}) {
  const m = metrics || {};

  const totalTrades = num(pickNumber(m, 'totalTrades', 'numberOfTradesAll', 'numberOfTrades'));
  const wins = num(pickNumber(m, 'numberOfWinningTradesAll', 'numberOfWinningTrades', 'numberOfWiningTrades'));
  const losses = num(pickNumber(m, 'numberOfLosingTradesAll', 'numberOfLosingTrades'));
  let winRate = num(pickNumber(m, 'percentProfitableAll', 'percentProfitable'));
  if (winRate <= 1 && winRate > 0) winRate *= 100; // some shapes report 0..1
  if (!winRate && totalTrades > 0) winRate = Math.round((wins / totalTrades) * 100);

  const profitFactor = num(pickNumber(m, 'profitFactor'));
  const sharpe = num(pickNumber(m, 'sharpeRatio', 'sharpe'));
  const sortino = num(pickNumber(m, 'sortinoRatio', 'sortino'));
  const netProfit = num(pickNumber(m, 'netProfit', 'netProfitPercent', 'totalProfit'));

  let maxDdPct = num(pickNumber(m, 'maxDrawdownPercent', 'maxDrawdownPct', 'maxStrategyDrawDown'));
  if (!maxDdPct) {
    const maxDdAbs = num(pickNumber(m, 'maxDrawdown'));
    if (maxDdAbs && initialCapital > 0) maxDdPct = (maxDdAbs / initialCapital) * 100;
  }
  if (maxDdPct > 0 && maxDdPct <= 1) maxDdPct *= 100; // 0..1 → percent

  const avgWin = num(pickNumber(m, 'avgWinTrade', 'avgWinningTradeAll', 'avgWinningTrade', 'averageWinningTrade'));
  const avgLoss = num(pickNumber(m, 'avgLosTrade', 'avgLosingTradeAll', 'avgLosingTrade', 'averageLosingTrade'));
  const expectancy = num(pickNumber(m, 'avgTrade', 'avgTradeAll', 'expectancy'));

  // Equity curve normalisation. TV returns either:
  //   array of [time, equity, drawdown]   (tuple form)
  //   array of {time, equity, drawdown}   (object form, used by getEquity fallback)
  let equityArr = [];
  if (Array.isArray(equity)) {
    for (const p of equity) {
      if (Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1])) {
        equityArr.push({ t: p[0], e: p[1] });
      } else if (p && typeof p === 'object') {
        const t = p.time ?? p.t;
        const e = p.equity ?? p.e ?? p.value;
        if (Number.isFinite(t) && Number.isFinite(e)) equityArr.push({ t, e });
      }
    }
  }
  const equityCompact = equityArr.length > 50
    ? equityArr.filter((_, i) => i % Math.ceil(equityArr.length / 50) === 0 || i === equityArr.length - 1)
    : equityArr;

  // Trades flatten — TV's ordersData has buy + sell as separate entries; we keep
  // them as-is for now (callers that need paired entries should post-process).
  const flatTrades = (trades || []).map((t, i) => ({
    idx: i,
    entryTs: num(t.entryTime ?? t.openTime ?? t.time ?? 0) || null,
    exitTs: num(t.exitTime ?? t.closeTime ?? 0) || null,
    entryPx: num(t.entryPrice ?? t.openPrice ?? t.price ?? 0) || null,
    exitPx: num(t.exitPrice ?? t.closePrice ?? 0) || null,
    pnlPct: num(t.pnlPercent ?? t.profitPercent ?? t.pnl ?? 0),
    barsHeld: num(t.barsHeld ?? 0),
    exitReason: t.exitReason || t.comment || t.type || 'unknown',
    regime: null,
  }));

  return {
    totalTrades,
    wins,
    losses,
    winRate: Number(winRate.toFixed(1)),
    profitFactor: Number(profitFactor.toFixed(2)),
    sharpe: Number(sharpe.toFixed(2)),
    sortino: Number(sortino.toFixed(2)),
    calmar: 0,           // not natively reported by TV
    ulcer: 0,            // not natively reported by TV
    maxDrawdown: Number(maxDdPct.toFixed(2)),
    wilsonWR: 0,         // computed downstream from wins/totalTrades if caller wants
    totalPnl: Number(netProfit.toFixed(2)),
    avgWin: Number(avgWin.toFixed(2)),
    avgLoss: Number(avgLoss.toFixed(2)),
    expectancy: Number(expectancy.toFixed(2)),
    equity: equityCompact,
    equityFull: equityArr,
    trades: flatTrades,
    capital: {
      initial: initialCapital,
      final: Math.round(initialCapital + netProfit),
      netProfit: Math.round(netProfit),
      returnPct: initialCapital > 0 ? Number(((netProfit / initialCapital) * 100).toFixed(2)) : 0,
    },
    barsAnalyzed: equityArr.length,
    oos: { trades: 0, winRate: 0, wilsonWR: 0, totalPnl: 0 },
    regimePerformance: {},
  };
}

/**
 * Read a strategy's Pine source from disk relative to `pdf/`.
 * Throws if the file is missing or empty so callers fail fast before driving
 * the chart.
 */
async function loadPineSource(relPath) {
  const abs = path.join(PROJECT_ROOT, 'pdf', relPath);
  let source;
  try {
    source = await fs.readFile(abs, 'utf8');
  } catch (e) {
    throw new Error(`Failed to read Pine source ${abs}: ${e.message}`);
  }
  if (!source || !source.trim()) throw new Error(`Pine source empty: ${abs}`);
  return { source, abs };
}

/**
 * Run a single TV-backtester job for `code` on `symbol`/`timeframe`.
 *
 * @param {Object} args
 * @param {string} args.code       - registry strategy code
 * @param {string} args.symbol     - e.g. 'NSE:RELIANCE' or 'AAPL'
 * @param {string} args.timeframe  - TV resolution ('1','5','15','60','D','W')
 * @param {string} [args.dateFrom] - ISO date for visible range start
 * @param {string} [args.dateTo]   - ISO date for visible range end
 * @returns {Promise<Object>} flat result with `provider: 'tv_strategy_tester'`
 */
export async function runTvBacktest({ code, symbol, timeframe, dateFrom, dateTo } = {}) {
  if (!code) throw new Error('runTvBacktest: code required');
  if (!symbol) throw new Error('runTvBacktest: symbol required');
  if (!timeframe) throw new Error('runTvBacktest: timeframe required');

  const meta = getStrategy(code);
  if (!meta) throw new Error(`Unknown strategy code: ${code}`);
  if (!meta.tvBacktestable) throw new Error(`Strategy ${code} is not TV-backtestable (no Pine source).`);

  // Use the strategy's preferred timeframe if the requested one isn't supported.
  // Pine strategies are compiled for specific TFs — running on the wrong one gives
  // misleading results (e.g. daily ATR/SMA on 5m data).
  let effectiveTf = timeframe;
  if (meta.timeframes && meta.timeframes.length > 0) {
    const normTf = tf => tf.replace(/^1/, '');  // '1D' → 'D', '1W' → 'W'
    const supported = meta.timeframes.map(normTf);
    if (!supported.includes(normTf(timeframe))) {
      effectiveTf = meta.timeframes[0]; // use first (usually '1D')
    }
  }

  const pineRel = getPineFilePath(code);
  if (!pineRel) throw new Error(`No Pine file mapped for ${code}`);

  const { source, abs: pineAbsPath } = await loadPineSource(pineRel);

  // Fast-path: if same strategy+symbol+timeframe was just compiled, skip to visible range
  const sameSetup = _lastRun.compiledOk
    && _lastRun.code === code
    && _lastRun.symbol === symbol
    && _lastRun.timeframe === effectiveTf;

  if (!sameSetup) {
    // Full setup required — symbol, timeframe, compile
    const needSymbol = _lastRun.symbol !== symbol;
    const needTimeframe = _lastRun.timeframe !== effectiveTf;

    if (needSymbol) await setSymbol({ symbol });
    if (needTimeframe) await setTimeframe({ timeframe: effectiveTf });

    // Inject Pine source + compile
    await setSource({ source });
    await smartCompile();

    // Check for fatal compile errors (severity 8 = Error)
    const errs = await getErrors();
    if (errs && Array.isArray(errs.errors) && errs.errors.length > 0) {
      const fatalErrors = errs.errors.filter(e => (e.severity || 8) >= 8);
      if (fatalErrors.length > 0) {
        _lastRun.compiledOk = false;
        const summary = fatalErrors.slice(0, 3)
          .map(e => (typeof e === 'string' ? e : e.message || e.text || JSON.stringify(e)))
          .join('; ');
        throw new Error(`Pine compile errors for ${code}: ${summary}`);
      }
    }

    // Ensure Strategy Tester panel is open
    try { await openPanel({ panel: 'strategy-tester', action: 'open' }); } catch (_) {}

    _lastRun.code = code;
    _lastRun.symbol = symbol;
    _lastRun.timeframe = effectiveTf;
    _lastRun.compiledOk = true;
  }

  // Set visible range for this window (the only step needed on fast-path)
  if (dateFrom && dateTo) {
    const fromTs = Math.floor(new Date(dateFrom).getTime() / 1000);
    const toTs = Math.floor(new Date(dateTo).getTime() / 1000);
    if (Number.isFinite(fromTs) && Number.isFinite(toTs)) {
      try { await setVisibleRange({ from: fromTs, to: toTs }); } catch (_) {}
    }
    // Brief settle after range change so strategy recomputes
    await new Promise(r => setTimeout(r, sameSetup ? 1500 : 500));
  }

  // Poll for strategy results
  let metrics = {};
  let reportRes, tradesRes, equityRes;
  const pollStart = Date.now();
  while (Date.now() - pollStart < RESULTS_POLL_MAX_MS) {
    await new Promise(r => setTimeout(r, RESULTS_POLL_INTERVAL_MS));
    reportRes = await getStrategyResults();
    metrics = reportRes?.metrics || {};
    if (metrics && Object.keys(metrics).length > 0) break;
  }

  tradesRes = await getTrades({ max_trades: 100 });
  equityRes = await getEquity();

  const trades = tradesRes?.trades || [];
  const equity = equityRes?.data || [];

  if (!metrics || Object.keys(metrics).length === 0) {
    const note = reportRes?.error || tradesRes?.error || equityRes?.error || 'reportData empty';
    throw new Error(`TV strategy reported no metrics for ${code} on ${symbol}/${effectiveTf}: ${note}`);
  }

  const flat = mapTvMetrics(metrics, equity, trades, { initialCapital: DEFAULT_INITIAL_CAPITAL });

  return {
    success: true,
    provider: 'tv_strategy_tester',
    code,
    symbol,
    timeframe: effectiveTf,
    dateFrom: dateFrom || null,
    dateTo: dateTo || null,
    pineFile: pineRel,
    pineAbsPath,
    rawMetrics: metrics,
    ...flat,
  };
}
