/**
 * EMA + RSI Intraday — triple-EMA trend stack with RSI exit, volume confirmation
 * and percentage TP/SL.
 *
 * Canonical Pine: pdf/profitable/ema_rsi_intraday.pine (keep params in sync).
 *
 * Entry long : EMA(A) crosses above EMA(B), EMA(A) > EMA(C) trend filter, bullish
 *              candle (close > open), volume > SMA(volLen) × volMult.
 * Entry short: mirror (cross down, EMA(A) < EMA(C), bearish candle).
 * Exit:  RSI > rsiExitLong (long) / RSI < rsiExitShort (short), plus TP/SL % and
 *        the maxBars time-stop (handled by the engine).
 *
 * NOTE: the JS engine is session-agnostic — the Pine intraday square-off has no
 *       JS equivalent. The 1D timeframe is authoritative for promotion.
 */
import { emaSeries, rsiSeries, smaSeries } from '../indicators.js';

export default {
  warmup: 105,
  defaultParams: {
    emaA: 10, emaB: 20, emaC: 100, rsiLen: 14, rsiExitLong: 70, rsiExitShort: 30,
    volLen: 20, volMult: 1.0, tp: 3.0, sl: 1.5, maxBars: 48,
  },
  buildExitRules({ params }) {
    return { tp: params.tp, sl: params.sl, maxBars: params.maxBars };
  },
  build({ params, bars }) {
    const p = params;
    const a = emaSeries(bars.closes, p.emaA);
    const b = emaSeries(bars.closes, p.emaB);
    const c = emaSeries(bars.closes, p.emaC);
    const rsiArr = rsiSeries(bars.closes, p.rsiLen);
    const volMA = smaSeries(bars.volumes, p.volLen);
    const warm = Math.max(p.emaC, p.rsiLen, p.volLen) + 1;
    return ({ i, state, bars }) => {
      if (i < warm) return { entry: false, exitSignal: false };
      if (!state.inTrade) {
        const crossUp = a[i] > b[i] && a[i - 1] <= b[i - 1];
        const crossDn = a[i] < b[i] && a[i - 1] >= b[i - 1];
        const volOK = volMA[i] > 0 && bars.volumes[i] > volMA[i] * p.volMult;
        if (crossUp && a[i] > c[i] && bars.closes[i] > bars.opens[i] && volOK) {
          return { entry: true, direction: 'long' };
        }
        if (crossDn && a[i] < c[i] && bars.closes[i] < bars.opens[i] && volOK) {
          return { entry: true, direction: 'short' };
        }
        return { entry: false };
      }
      const r = rsiArr[i];
      if (r === null) return { exitSignal: false };
      const exit = state.direction === 'long' ? r > p.rsiExitLong : r < p.rsiExitShort;
      return { exitSignal: exit };
    };
  },
};
