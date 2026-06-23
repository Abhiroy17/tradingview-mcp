/**
 * Trend 200-SMA Positional — classic trend-following.
 *
 * Phase H tuned defaults (cap-tier basket × 4y sweep, india_delivery costs):
 *   fastLen=20, volMult=1.5, tp=25 (cap gains at 25% for mid/small), sl=12
 *   large_cap +23.8% (3/10), mid_cap +92.9% (6/10), small_cap +98.3% (6/10).
 *   Use as portfolio rotation across mid/small-cap for highest edge.
 *
 * Entry: close crosses above 200-SMA with volume confirmation + price > 20-SMA.
 * Exit:  hard SL 12%, TP 25%, exitSignal on close < 200-SMA (regime break).
 *        Note: ATR chandelier trail is in the Pine canonical; JS approximates with sma200-break
 *        until runner.js gains stop-trail support (Phase D).
 */
import { sma } from '../indicators.js';

export default {
  warmup: 205,
  defaultParams: { trendLen: 200, fastLen: 20, volMult: 1.5, tp: 25, sl: 12, maxBars: 250 },
  buildExitRules({ params }) {
    return { tp: params.tp, sl: params.sl, maxBars: params.maxBars };
  },
  build({ params }) {
    const p = params;
    return ({ i, state, bars }) => {
      if (i < p.trendLen) return { entry: false, exitSignal: false };
      const sma200     = sma(bars.closes, p.trendLen, i);
      const sma50      = sma(bars.closes, p.fastLen,  i);
      const prevSma200 = sma(bars.closes, p.trendLen, i - 1);
      const volMA      = sma(bars.volumes, 20, i);
      const volOK      = volMA > 0 && bars.volumes[i] > volMA * p.volMult;
      const crossAbove = bars.closes[i] > sma200 && bars.closes[i - 1] <= prevSma200;
      return {
        entry:      !state.inTrade && crossAbove && bars.closes[i] > sma50 && volOK,
        // Regime-break exit: close below 200-SMA = trend over
        exitSignal: state.inTrade && bars.closes[i] < sma200,
      };
    };
  },
};
