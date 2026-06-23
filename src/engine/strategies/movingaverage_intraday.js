/**
 * Moving Average Intraday — SMA(short) × SMA(long) crossover with volume
 * confirmation and percentage TP/SL.
 *
 * Canonical Pine: pdf/profitable/movingaverage_intraday.pine (keep params in sync).
 *
 * Entry: SMA(short) crosses SMA(long) — up → long, down → short — confirmed by
 *        volume > SMA(volLen) × volMult.
 * Exit:  TP/SL %, maxBars time-stop, or opposite crossover (regime flip).
 *
 * NOTE: the JS engine is session-agnostic — the Pine intraday square-off has no
 *       JS equivalent. On intraday timeframes treat the JS backtest as a signal
 *       approximation; the 1D timeframe is authoritative for promotion.
 */
import { smaSeries } from '../indicators.js';

export default {
  warmup: 50,
  defaultParams: { shortPeriod: 10, longPeriod: 40, volLen: 20, volMult: 1.0, tp: 1.5, sl: 1.0, maxBars: 30 },
  buildExitRules({ params }) {
    return { tp: params.tp, sl: params.sl, maxBars: params.maxBars };
  },
  build({ params, bars }) {
    const p = params;
    const maS = smaSeries(bars.closes, p.shortPeriod);
    const maL = smaSeries(bars.closes, p.longPeriod);
    const volMA = smaSeries(bars.volumes, p.volLen);
    const warm = Math.max(p.longPeriod, p.volLen) + 1;
    return ({ i, state, bars }) => {
      if (i < warm) return { entry: false, exitSignal: false };
      const crossUp = maS[i] > maL[i] && maS[i - 1] <= maL[i - 1];
      const crossDn = maS[i] < maL[i] && maS[i - 1] >= maL[i - 1];
      if (!state.inTrade) {
        const volOK = volMA[i] > 0 && bars.volumes[i] > volMA[i] * p.volMult;
        if (crossUp && volOK) return { entry: true, direction: 'long' };
        if (crossDn && volOK) return { entry: true, direction: 'short' };
        return { entry: false };
      }
      // Opposite crossover = regime flip → exit (engine re-enters next flat bar)
      const opp = state.direction === 'long' ? crossDn : crossUp;
      return { exitSignal: opp };
    };
  },
};
