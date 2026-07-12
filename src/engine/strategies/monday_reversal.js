/**
 * Monday Reversal — buy Monday opens that gap down, with RSI(5) oversold + volume.
 * Captures weekend-news noise mean-reversion. Exit: TP 2% / SL 0.8% / max 3 bars.
 *
 * Edge comes from:
 *   - Calendar effect: Monday gap reversals (behavioral overreaction to weekend news)
 *   - RSI(5) oversold: confirms prior-week selling exhaustion
 *   - Volume: institutional Friday selling precedes Monday bounce
 *
 * MACD/SMA tested Phase I (large_cap 4y, 288 combos) — no significant lift at N=29.
 * Calendar strategies have inherently small sample sizes.
 *
 * Canonical Pine: pdf/untested/monday_reversal.pine (keep params in sync).
 */
import { sma, rsi } from '../indicators.js';
import { istClock } from '../india-session.js';

export default {
  warmup: 55,
  defaultParams: {
    rsiLen: 5, rsiThresh: 30,
    volLen: 20, volMult: 1.5,
    tp: 2.0, sl: 0.8, maxBars: 3,
  },
  buildExitRules({ params }) {
    return { tp: params.tp, sl: params.sl, maxBars: params.maxBars };
  },
  build({ bars, params }) {
    const p = params;
    return ({ i, state, bars }) => {
      if (i < Math.max(p.volLen, 35)) return { entry: false, exitSignal: false };

      // Monday detection via IST clock (dow 1 = Monday)
      const t = bars.times?.[i];
      const clock = t ? istClock(t) : null;
      const isMonday = clock && clock.dow === 1;
      if (!isMonday) return { entry: false, exitSignal: false };

      // Gap-down: open < previous close
      const gapDown = bars.opens?.[i] != null && bars.opens[i] < bars.closes[i - 1];

      // RSI(5) oversold on previous bar (Friday's close)
      const rsiVal = rsi(bars.closes, p.rsiLen, i - 1);
      const rsiOK = rsiVal !== null && rsiVal < p.rsiThresh;

      // Volume confirmation on prev bar
      const volMA = sma(bars.volumes, p.volLen, i - 1);
      const volOK = volMA > 0 && bars.volumes[i - 1] > volMA * p.volMult;

      return {
        entry: !state.inTrade && gapDown && rsiOK && volOK,
        exitSignal: false,
      };
    };
  },
};
