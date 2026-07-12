/**
 * Trend 200-SMA Positional — classic trend-following.
 *
 * Phase H tuned defaults (cap-tier basket × 4y sweep, india_delivery costs):
 *   fastLen=20, volMult=1.5, tp=25 (cap gains at 25% for mid/small), sl=12
 *   large_cap +23.8% (3/10), mid_cap +92.9% (6/10), small_cap +98.3% (6/10).
 *   Use as portfolio rotation across mid/small-cap for highest edge.
 *
 * Edge comes from:
 *   - Trend strength: 200-SMA as regime filter (THE defining signal)
 *   - Fast SMA(20): confirms near-term momentum alignment
 *   - Volume: requires institutional participation on breakout bar
 *   - Regime-break exit: close below 200-SMA = trend over (clean, no ambiguity)
 *
 * MACD/RSI early exits tested Phase I — BOTH HURT performance. Trend-following
 * strategies MUST ride the full trend; early exits cut winners short.
 *
 * Canonical Pine: pdf/untested/trend_200sma_positional.pine (keep params in sync).
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
        exitSignal: state.inTrade && bars.closes[i] < sma200,
      };
    };
  },
};
