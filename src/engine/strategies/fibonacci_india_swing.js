/**
 * Fibonacci India Swing — retracement reversal trades, both sides.
 *
 * Phase G.4 tuned defaults (NSE:RELIANCE 4y sweep, india_delivery costs):
 *   lookback=80 (longer swing capture), tp=4, sl=2, maxBars=10, allowShorts=true
 *   PF 3.44, WR 71%, OOS Sharpe 0.61, no overfit. Stability: unstable (PF CoV 1.34).
 *
 *   Long  : bullish bar that touches 50% / 61.8% from below (close above level).
 *   Short : bearish bar that rejects 23.6% / 38.2% from above (close below level).
 *
 * Exit by TP/SL (% from entry) or signal exit when price clears 23.6% / 50%.
 * NOTE: short trades require runner.allowShorts=true.
 */
import { highest, lowest } from '../indicators.js';

export default {
  warmup: 85,
  defaultParams: { lookback: 80, tp: 4.0, sl: 2.0, maxBars: 10, allowShorts: true },
  buildExitRules({ params }) {
    return { tp: params.tp, sl: params.sl, maxBars: params.maxBars };
  },
  build({ params }) {
    const lb = params.lookback;
    return ({ i, state, bars }) => {
      if (i < lb) return { entry: false, exitSignal: false };
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

      // Direction-aware exit signal (price clearing the opposing fib)
      let exitSignal = false;
      if (state.inTrade) {
        if (state.direction === 'short') exitSignal = c < fib618;  // short profit-take if price falls below 61.8
        else                              exitSignal = c > fib236;  // long profit-take if price clears 23.6
      }

      if (!state.inTrade && (atFib618 || atFib500)) {
        return { entry: true, direction: 'long', exitSignal: false };
      }
      if (!state.inTrade && params.allowShorts && (atFib236 || atFib382)) {
        return { entry: true, direction: 'short', exitSignal: false };
      }
      return { entry: false, exitSignal };
    };
  },
};
