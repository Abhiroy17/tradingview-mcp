/**
 * Fibonacci India Swing — retracement reversal trades, both sides.
 *
 * Phase G.4 single-symbol tuned (NSE:RELIANCE 4y): lookback=80, tp=4, sl=2,
 *   maxBars=10, allowShorts=true — PF 3.44 on RELIANCE but lost -86.4% on the
 *   large-cap basket (no universal edge).
 * Phase I basket lock (large_cap 4y, india_delivery): adding RSI + MACD momentum
 *   confirmation flips the basket from -86.4% → +6.0% (WR 55%, 6/10 profitable).
 *   Locked: lookback=50, tp=4, sl=3, maxBars=20, allowShorts=false, useRsi+useMacd.
 *   Trade-off: highly selective (~20 basket trades/4y); trend-only filter is a
 *   higher-frequency alternative (+1.7%, 197 trades).
 *
 *   Long  : bullish bar that touches 50% / 61.8% from below (close above level).
 *   Short : bearish bar that rejects 23.6% / 38.2% from above (close below level).
 *
 * Optional confirmation filters (default OFF → identical to original behavior;
 * turned ON during tuning to add trend / momentum / volume context):
 *   useTrend  — long only if close > SMA(trendLen), short only if close < SMA.
 *               Aligns retracement entries with the dominant trend (buy dips in
 *               uptrends, sell rallies in downtrends).
 *   useRsi    — long only if RSI(rsiLen) <= rsiLong, short only if RSI >= rsiShort.
 *   useMacd   — long only if MACD histogram > 0, short only if histogram < 0.
 *   useVolume — require volume > SMA(volLen) * volMult.
 *
 * Exit by TP/SL (% from entry) or signal exit when price clears 23.6% / 50%.
 * NOTE: short trades require runner.allowShorts=true.
 * Canonical Pine: pdf/profitable/fibonacci_india_swing.pine (keep params in sync).
 */
import { highest, lowest, smaSeries, rsi, macd } from '../indicators.js';

export default {
  warmup: 85,
  defaultParams: {
    lookback: 50, tp: 4.0, sl: 3.0, maxBars: 20, allowShorts: false,
    // ── confirmation filters (Phase I basket lock: RSI + MACD ON) ──
    useTrend: false, trendLen: 200,
    useRsi: true, rsiLen: 14, rsiLong: 45, rsiShort: 55,
    useMacd: true,
    useVolume: false, volLen: 20, volMult: 1.0,
  },
  buildExitRules({ params }) {
    return { tp: params.tp, sl: params.sl, maxBars: params.maxBars };
  },
  build({ params, bars }) {
    const p = params;
    const lb = p.lookback;
    // Precompute series once (forward-recursive → safe to index by bar i).
    const smaTrend = p.useTrend  ? smaSeries(bars.closes,  p.trendLen) : null;
    const volMA    = p.useVolume ? smaSeries(bars.volumes, p.volLen)   : null;
    const hist     = p.useMacd   ? macd(bars.closes).histogram         : null;
    const warm = Math.max(
      lb,
      p.useTrend  ? p.trendLen : 0,
      p.useVolume ? p.volLen   : 0,
      p.useRsi    ? p.rsiLen   : 0,
      p.useMacd   ? 35         : 0,
    );

    return ({ i, state, bars }) => {
      if (i < warm) return { entry: false, exitSignal: false };
      const hh = highest(bars.highs, lb + 1, i);
      const ll = lowest(bars.lows,   lb + 1, i);
      const range = hh - ll;
      if (range === 0) return { entry: false, exitSignal: false };

      const fib618 = hh - range * 0.618;
      const fib500 = hh - range * 0.500;
      const fib382 = hh - range * 0.382;
      const fib236 = hh - range * 0.236;

      const c = bars.closes[i], o = bars.opens[i], h = bars.highs[i], l = bars.lows[i];
      const bullishCandle = c > o;
      const bearishCandle = c < o;

      // Long entries (50 / 61.8 retracement bounce)
      const atFib618 = bullishCandle && l <= fib618 * 1.005 && c > fib618;
      const atFib500 = bullishCandle && l <= fib500 * 1.005 && c > fib500;
      // Short entries (23.6 / 38.2 retracement rejection)
      const atFib236 = bearishCandle && h >= fib236 * 0.995 && c < fib236;
      const atFib382 = bearishCandle && h >= fib382 * 0.995 && c < fib382;

      // ── Optional confirmation filters (skipped entirely when toggled off) ──
      const rsiVal = p.useRsi ? rsi(bars.closes, p.rsiLen, i) : null;
      const volOK  = !p.useVolume || (volMA[i] > 0 && bars.volumes[i] > volMA[i] * p.volMult);
      const longConfirm =
        (!p.useTrend || (smaTrend[i] > 0 && c > smaTrend[i])) &&
        (!p.useRsi   || (rsiVal !== null && rsiVal <= p.rsiLong)) &&
        (!p.useMacd  || hist[i] > 0) &&
        volOK;
      const shortConfirm =
        (!p.useTrend || (smaTrend[i] > 0 && c < smaTrend[i])) &&
        (!p.useRsi   || (rsiVal !== null && rsiVal >= p.rsiShort)) &&
        (!p.useMacd  || hist[i] < 0) &&
        volOK;

      // Direction-aware exit signal (price clearing the opposing fib)
      let exitSignal = false;
      if (state.inTrade) {
        if (state.direction === 'short') exitSignal = c < fib618;  // short profit-take if price falls below 61.8
        else                              exitSignal = c > fib236;  // long profit-take if price clears 23.6
      }

      if (!state.inTrade && (atFib618 || atFib500) && longConfirm) {
        return { entry: true, direction: 'long', exitSignal: false };
      }
      if (!state.inTrade && p.allowShorts && (atFib236 || atFib382) && shortConfirm) {
        return { entry: true, direction: 'short', exitSignal: false };
      }
      return { entry: false, exitSignal };
    };
  },
};
