/**
 * Overnight Swing — buy strong-close days (top 10% of bar range) above SMA50 with volume,
 * hold 1-2 bars overnight. Asymmetric R:R 1.5% TP / 0.8% SL.
 *
 * Edge comes from:
 *   - Close position strength (IBS-like): close in top 10% of bar range = strong buying
 *   - Trend filter: price above SMA(50) = macro uptrend context
 *   - Volume confirmation: institutional activity on the strong-close bar
 *
 * MACD/RSI tested Phase I — no improvement on any basket. The strategy is
 * fundamentally weak on Indian equities (overnight gap risk dominates).
 *
 * Canonical Pine: pdf/untested/overnight_swing.pine (keep params in sync).
 */
import { sma } from '../indicators.js';

export default {
  warmup: 55,
  defaultParams: {
    closeThresh: 0.9, smaLen: 50, volMult: 1.5,
    tp: 1.5, sl: 0.8, maxBars: 2,
  },
  buildExitRules({ params }) {
    return { tp: params.tp, sl: params.sl, maxBars: params.maxBars };
  },
  build({ bars, params }) {
    const p = params;
    return ({ i, state, bars }) => {
      if (i < p.smaLen) return { entry: false, exitSignal: false };
      const range = bars.highs[i] - bars.lows[i];
      if (range === 0) return { entry: false, exitSignal: false };
      const closePos = (bars.closes[i] - bars.lows[i]) / range;
      const smaVal   = sma(bars.closes, p.smaLen, i);
      const volMA    = sma(bars.volumes, 20, i);
      const volOK    = volMA > 0 && bars.volumes[i] > volMA * p.volMult;

      return {
        entry:      !state.inTrade && closePos >= p.closeThresh && bars.closes[i] > smaVal && volOK,
        exitSignal: false,
      };
    };
  },
};
