/**
 * RSI(2) India Swing — Larry Connors mean-reversion, Indian market tuning.
 *
 * Phase G.1 tuned defaults (NSE:RELIANCE 4y sweep, india_delivery costs):
 *   rsiOversold=10 (deeper pullbacks only) — was 30, raised win rate 52%→71%
 *   tp=1.0, sl=1.0   — symmetric R:R works under realistic costs
 *   PF 1.77, OOS Sharpe 0.24, stability=unstable (rsi-2 is regime-sensitive)
 *
 * Entry: RSI(2) CROSSES BELOW threshold (cross detection, not "still oversold") with volume > SMA(20).
 * Exit:  TP 1.0%, SL 1.0%, max 5 bars held, or RSI(2) > 50.
 */
import { rsi, sma } from '../indicators.js';

export default {
  warmup: 25,
  defaultParams: { tp: 1.0, sl: 1.0, maxBars: 5, rsiOversold: 10, rsiExit: 50, volLen: 20 },
  buildExitRules({ params }) {
    return { tp: params.tp, sl: params.sl, maxBars: params.maxBars };
  },
  build({ params }) {
    const p = params;
    return ({ i, state, bars }) => {
      const r     = rsi(bars.closes, 2, i);
      const rPrev = rsi(bars.closes, 2, i - 1);
      const volMA = sma(bars.volumes, p.volLen, i);
      const volOK = volMA > 0 && bars.volumes[i] > volMA;
      // FIX: cross-down detection — RSI ENTERED oversold THIS bar (was firing every bar in oversold zone)
      const crossDown = r !== null && rPrev !== null && r < p.rsiOversold && rPrev >= p.rsiOversold;
      return {
        entry:      !state.inTrade && crossDown && volOK,
        exitSignal: state.inTrade && r !== null && r > p.rsiExit,
      };
    };
  },
};
