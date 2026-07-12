/**
 * Moving Average Intraday — SMA(short) × SMA(long) crossover with volume
 * confirmation and percentage TP/SL.
 *
 * Canonical Pine: pdf/profitable/movingaverage_intraday.pine (keep params in sync).
 *
 * Entry: SMA(short) crosses SMA(long) — up → long, down → short — confirmed by
 *        volume > SMA(volLen) × volMult.
 * Exit:  TP/SL %, maxBars time-stop, opposite crossover, or RSI exit override.
 *
 * Optional momentum confirmation (Phase I; default OFF → original behavior):
 *   useMacd     — MACD histogram must agree with direction (hist>0 for long, <0 for short).
 *   useRsiExit  — exit long when RSI > rsiExitLong (overbought), short when RSI < rsiExitShort.
 *
 * NOTE: the JS engine is session-agnostic — the Pine intraday square-off has no
 *       JS equivalent. On intraday timeframes treat the JS backtest as a signal
 *       approximation; the 1D timeframe is authoritative for promotion.
 */
import { smaSeries, macd, rsiSeries } from '../indicators.js';

export default {
  warmup: 55,
  defaultParams: {
    shortPeriod: 5, longPeriod: 50, volLen: 20, volMult: 1.0,
    // ── momentum (Phase I tuned: MACD locked on, RSI exit opt-in) ──
    useMacd: true,
    useRsiExit: false, rsiLen: 14, rsiExitLong: 70, rsiExitShort: 30,
    tp: 2.5, sl: 1.5, maxBars: 30,
  },
  buildExitRules({ params }) {
    return { tp: params.tp, sl: params.sl, maxBars: params.maxBars };
  },
  build({ params, bars }) {
    const p = params;
    const maS = smaSeries(bars.closes, p.shortPeriod);
    const maL = smaSeries(bars.closes, p.longPeriod);
    const volMA = smaSeries(bars.volumes, p.volLen);
    const hist   = p.useMacd    ? macd(bars.closes).histogram  : null;
    const rsiArr = p.useRsiExit ? rsiSeries(bars.closes, p.rsiLen) : null;
    const warm = Math.max(p.longPeriod, p.volLen, p.useMacd ? 35 : 0) + 1;
    return ({ i, state, bars }) => {
      if (i < warm) return { entry: false, exitSignal: false };
      const crossUp = maS[i] > maL[i] && maS[i - 1] <= maL[i - 1];
      const crossDn = maS[i] < maL[i] && maS[i - 1] >= maL[i - 1];
      if (!state.inTrade) {
        const volOK = volMA[i] > 0 && bars.volumes[i] > volMA[i] * p.volMult;
        const macdLongOK  = !p.useMacd || hist[i] > 0;
        const macdShortOK = !p.useMacd || hist[i] < 0;
        if (crossUp && volOK && macdLongOK)  return { entry: true, direction: 'long' };
        if (crossDn && volOK && macdShortOK) return { entry: true, direction: 'short' };
        return { entry: false };
      }
      // Opposite crossover = regime flip → exit
      const opp = state.direction === 'long' ? crossDn : crossUp;
      // RSI exit override (overbought/oversold)
      const rsiExit = p.useRsiExit && rsiArr[i] !== null && (
        (state.direction === 'long'  && rsiArr[i] > p.rsiExitLong) ||
        (state.direction === 'short' && rsiArr[i] < p.rsiExitShort)
      );
      return { exitSignal: opp || rsiExit };
    };
  },
};
