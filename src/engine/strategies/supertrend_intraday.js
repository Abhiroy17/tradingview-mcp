/**
 * Supertrend Intraday — ATR Supertrend flip entries with volume confirmation
 * and percentage TP/SL.
 *
 * Canonical Pine: pdf/profitable/supertrend_intraday.pine (keep params in sync).
 *
 * Entry: Supertrend flips up (price crosses above the line) → long; flips down →
 *        short. Confirmed by volume > SMA(volLen) × volMult.
 * Exit:  TP/SL %, maxBars time-stop, or the opposite Supertrend flip.
 *
 * NOTE: the JS engine is session-agnostic — the Pine intraday square-off has no
 *       JS equivalent. The 1D timeframe is authoritative for promotion.
 */
import { supertrendSeries, smaSeries } from '../indicators.js';

export default {
  warmup: 35,
  defaultParams: { atrPeriod: 14, multiplier: 4, volLen: 20, volMult: 1.0, tp: 2.0, sl: 1.5, maxBars: 30 },
  buildExitRules({ params }) {
    return { tp: params.tp, sl: params.sl, maxBars: params.maxBars };
  },
  build({ params, bars }) {
    const p = params;
    const { trend } = supertrendSeries(bars.highs, bars.lows, bars.closes, p.atrPeriod, p.multiplier);
    const volMA = smaSeries(bars.volumes, p.volLen);
    const warm = Math.max(p.atrPeriod, p.volLen) + 2;
    return ({ i, state, bars }) => {
      if (i < warm) return { entry: false, exitSignal: false };
      const flipUp = trend[i] === 1 && trend[i - 1] === -1;
      const flipDn = trend[i] === -1 && trend[i - 1] === 1;
      if (!state.inTrade) {
        const volOK = volMA[i] > 0 && bars.volumes[i] > volMA[i] * p.volMult;
        if (flipUp && volOK) return { entry: true, direction: 'long' };
        if (flipDn && volOK) return { entry: true, direction: 'short' };
        return { entry: false };
      }
      const opp = state.direction === 'long' ? flipDn : flipUp;
      return { exitSignal: opp };
    };
  },
};
