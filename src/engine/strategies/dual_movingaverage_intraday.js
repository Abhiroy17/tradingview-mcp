/**
 * Dual Moving Average Intraday — SMA(fast) × SMA(slow) crossover gated by a
 * slope/angle filter, with volume confirmation and percentage TP/SL.
 *
 * Canonical Pine: pdf/profitable/dual_movingaverage_intraday.pine (keep in sync).
 *
 * Entry: a fast/slow cross occurred within the last `crossWindow` bars AND the
 *        slow-MA slope angle (degrees, ATR-normalised) exceeds ±angleThresh,
 *        confirmed by volume > SMA(volLen) × volMult.
 * Exit:  TP/SL %, maxBars time-stop, or an opposite recent cross (regime flip).
 *
 * NOTE: the JS engine is session-agnostic — the Pine intraday square-off has no
 *       JS equivalent. The 1D timeframe is authoritative for promotion.
 */
import { smaSeries, atrSeries } from '../indicators.js';

const RAD2DEG = 180 / Math.PI;

export default {
  warmup: 50,
  defaultParams: {
    fastLen: 8, slowLen: 21, angleLen: 2, atrPeriod: 10, angleThresh: 7,
    crossWindow: 15, volLen: 20, volMult: 1.0, tp: 1.5, sl: 1.0, maxBars: 30,
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
    const n = bars.closes.length;
    // Precompute fast/slow cross arrays
    const crossUpArr = new Array(n).fill(false);
    const crossDnArr = new Array(n).fill(false);
    for (let i = Math.max(p.fastLen, p.slowLen); i < n; i++) {
      crossUpArr[i] = fast[i] > slow[i] && fast[i - 1] <= slow[i - 1];
      crossDnArr[i] = fast[i] < slow[i] && fast[i - 1] >= slow[i - 1];
    }
    const warm = Math.max(p.slowLen, p.atrPeriod, p.volLen, p.angleLen) + p.crossWindow + 1;
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
        if (recentUp && angle > p.angleThresh && volOK) return { entry: true, direction: 'long' };
        if (recentDn && angle < -p.angleThresh && volOK) return { entry: true, direction: 'short' };
        return { entry: false };
      }
      const opp = state.direction === 'long' ? recentDn : recentUp;
      return { exitSignal: opp };
    };
  },
};
