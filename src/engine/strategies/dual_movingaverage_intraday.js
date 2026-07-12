/**
 * Dual Moving Average Intraday — SMA(fast) × SMA(slow) crossover gated by a
 * slope/angle filter, with volume confirmation and percentage TP/SL.
 *
 * Canonical Pine: pdf/profitable/dual_movingaverage_intraday.pine (keep in sync).
 *
 * Entry: a fast/slow cross occurred within the last `crossWindow` bars AND the
 *        slow-MA slope angle (degrees, ATR-normalised) exceeds ±angleThresh,
 *        confirmed by volume > SMA(volLen) × volMult.
 * Exit:  TP/SL %, maxBars time-stop, opposite recent cross, or RSI exit override.
 *
 * Optional momentum confirmation (Phase I; default OFF → original behavior):
 *   useMacd     — MACD histogram must agree with direction (hist>0 long, <0 short).
 *   useRsiExit  — exit long when RSI > rsiExitLong, short when RSI < rsiExitShort.
 *
 * NOTE: the JS engine is session-agnostic — the Pine intraday square-off has no
 *       JS equivalent. The 1D timeframe is authoritative for promotion.
 */
import { smaSeries, atrSeries, macd, rsiSeries } from '../indicators.js';

const RAD2DEG = 180 / Math.PI;

export default {
  warmup: 55,
  defaultParams: {
    fastLen: 8, slowLen: 21, angleLen: 2, atrPeriod: 10, angleThresh: 10,
    crossWindow: 10, volLen: 20, volMult: 1.0,
    // ── momentum (Phase I tuned: MACD locked on, RSI exit opt-in) ──
    useMacd: true,
    useRsiExit: false, rsiLen: 14, rsiExitLong: 70, rsiExitShort: 30,
    tp: 1.0, sl: 1.5, maxBars: 30,
  },
  buildExitRules({ params }) {
    return { tp: params.tp, sl: params.sl, maxBars: params.maxBars };
  },
  build({ params, bars }) {
    const p = params;
    const fast = smaSeries(bars.closes, p.fastLen);
    const slow = smaSeries(bars.closes, p.slowLen);
    const atrArr = atrSeries(bars.highs, bars.lows, bars.closes, p.atrPeriod);
    const volMA = smaSeries(bars.volumes, p.volLen);
    const hist   = p.useMacd    ? macd(bars.closes).histogram  : null;
    const rsiArr = p.useRsiExit ? rsiSeries(bars.closes, p.rsiLen) : null;
    const n = bars.closes.length;
    // Precompute fast/slow cross arrays
    const crossUpArr = new Array(n).fill(false);
    const crossDnArr = new Array(n).fill(false);
    for (let i = Math.max(p.fastLen, p.slowLen); i < n; i++) {
      crossUpArr[i] = fast[i] > slow[i] && fast[i - 1] <= slow[i - 1];
      crossDnArr[i] = fast[i] < slow[i] && fast[i - 1] >= slow[i - 1];
    }
    const warm = Math.max(p.slowLen, p.atrPeriod, p.volLen, p.angleLen, p.useMacd ? 35 : 0) + p.crossWindow + 1;
    return ({ i, state, bars }) => {
      if (i < warm) return { entry: false, exitSignal: false };
      // Slow-MA slope as an angle in degrees (ATR-normalised) — matches Pine f_angle
      const atrI = atrArr[i];
      const angle = atrI > 0
        ? RAD2DEG * Math.atan((slow[i] - slow[i - p.angleLen]) / atrI / p.angleLen)
        : 0;
      // Recent cross within window — EXCLUDES current bar (matches Pine _cond[1..N])
      let recentUp = false, recentDn = false;
      for (let j = i - p.crossWindow; j <= i - 1; j++) {
        if (j < 0) continue;
        if (crossUpArr[j]) recentUp = true;
        if (crossDnArr[j]) recentDn = true;
      }
      if (!state.inTrade) {
        const volOK = volMA[i] > 0 && bars.volumes[i] > volMA[i] * p.volMult;
        const macdLongOK  = !p.useMacd || hist[i] > 0;
        const macdShortOK = !p.useMacd || hist[i] < 0;
        if (recentUp && angle > p.angleThresh && volOK && macdLongOK)  return { entry: true, direction: 'long' };
        if (recentDn && angle < -p.angleThresh && volOK && macdShortOK) return { entry: true, direction: 'short' };
        return { entry: false };
      }
      const opp = state.direction === 'long' ? recentDn : recentUp;
      const rsiExit = p.useRsiExit && rsiArr[i] !== null && (
        (state.direction === 'long'  && rsiArr[i] > p.rsiExitLong) ||
        (state.direction === 'short' && rsiArr[i] < p.rsiExitShort)
      );
      return { exitSignal: opp || rsiExit };
    };
  },
};
