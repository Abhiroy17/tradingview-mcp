/**
 * Supertrend Intraday — ATR Supertrend flip entries with volume confirmation
 * and percentage TP/SL.
 *
 * Canonical Pine: pdf/profitable/supertrend_intraday.pine (keep params in sync).
 *
 * Entry: Supertrend flips up (price crosses above the line) → long; flips down →
 *        short. Confirmed by volume > SMA(volLen) × volMult.
 * Exit:  TP/SL %, maxBars time-stop, opposite Supertrend flip, or RSI exit override.
 *
 * Optional momentum confirmation (Phase I; default OFF → original behavior):
 *   useMacd     — MACD histogram must agree with direction (hist>0 long, <0 short).
 *   useRsiExit  — exit long when RSI > rsiExitLong, short when RSI < rsiExitShort.
 *   useRsiEntry — entry long requires RSI > rsiEntryMin (bullish momentum, not oversold).
 *
 * NOTE: the JS engine is session-agnostic — the Pine intraday square-off has no
 *       JS equivalent. The 1D timeframe is authoritative for promotion.
 */
import { supertrendSeries, smaSeries, macd, rsiSeries } from '../indicators.js';

export default {
  warmup: 40,
  defaultParams: {
    atrPeriod: 14, multiplier: 3, volLen: 20, volMult: 1.0,
    // ── momentum (Phase I tuned: MACD locked on, RSI entry/exit opt-in) ──
    useMacd: true,
    useRsiEntry: false, rsiEntryMin: 50,
    useRsiExit: false, rsiLen: 14, rsiExitLong: 70, rsiExitShort: 30,
    tp: 2.5, sl: 1.5, maxBars: 30,
  },
  buildExitRules({ params }) {
    return { tp: params.tp, sl: params.sl, maxBars: params.maxBars };
  },
  build({ params, bars }) {
    const p = params;
    const { trend } = supertrendSeries(bars.highs, bars.lows, bars.closes, p.atrPeriod, p.multiplier);
    const volMA = smaSeries(bars.volumes, p.volLen);
    const hist   = p.useMacd                      ? macd(bars.closes).histogram  : null;
    const rsiArr = (p.useRsiExit || p.useRsiEntry) ? rsiSeries(bars.closes, p.rsiLen) : null;
    const warm = Math.max(p.atrPeriod, p.volLen, p.useMacd ? 35 : 0) + 2;
    return ({ i, state, bars }) => {
      if (i < warm) return { entry: false, exitSignal: false };
      const flipUp = trend[i] === 1 && trend[i - 1] === -1;
      const flipDn = trend[i] === -1 && trend[i - 1] === 1;
      if (!state.inTrade) {
        const volOK = volMA[i] > 0 && bars.volumes[i] > volMA[i] * p.volMult;
        const macdLongOK  = !p.useMacd || hist[i] > 0;
        const macdShortOK = !p.useMacd || hist[i] < 0;
        const rsiLongOK   = !p.useRsiEntry || (rsiArr[i] !== null && rsiArr[i] > p.rsiEntryMin);
        if (flipUp && volOK && macdLongOK && rsiLongOK)  return { entry: true, direction: 'long' };
        if (flipDn && volOK && macdShortOK) return { entry: true, direction: 'short' };
        return { entry: false };
      }
      const opp = state.direction === 'long' ? flipDn : flipUp;
      const rsiExit = p.useRsiExit && rsiArr[i] !== null && (
        (state.direction === 'long'  && rsiArr[i] > p.rsiExitLong) ||
        (state.direction === 'short' && rsiArr[i] < p.rsiExitShort)
      );
      return { exitSignal: opp || rsiExit };
    };
  },
};
