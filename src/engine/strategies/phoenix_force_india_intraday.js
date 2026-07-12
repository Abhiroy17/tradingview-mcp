/**
 * Phoenix Force [India — Intraday]
 *
 * 4-factor confluence intraday momentum: PSAR + EMA trend + MACD + RSI,
 * gated by Choppiness Index (trending filter) + volume + ATR volatility floor.
 *
 * Canonical Pine: pdf/untested/phoenix_force_india_intraday.pine
 *
 * Entry long:  close > PSAR AND close > EMA(50) AND MACD line ≥ 0 AND RSI ≥ 53
 *              AND Choppiness < ciThresh AND volume > SMA20 × volMult
 *              AND ATR% ≥ atrFloor
 * Entry short: mirror (close < PSAR, < EMA, MACD < 0, RSI ≤ 47, etc.)
 * Exit: TP/SL percentage + maxBars time-stop.
 *
 * NOTE: JS engine doesn't enforce IST session/entry-window/square-off —
 *       the Pine canonical handles those. JS uses maxBars as time-stop proxy.
 */
import { emaSeries, rsiSeries, smaSeries, macd, atrSeries, psarSeries, chopSeries } from '../indicators.js';

export default {
  warmup: 55,
  defaultParams: {
    // Indicators
    psarStart: 0.02, psarInc: 0.02, psarMax: 0.20,
    maLen: 50,
    rsiLen: 14, rsiLongTh: 55, rsiShortTh: 47,
    ciLen: 14, ciThresh: 42,
    // Filters
    volMult: 1.0,
    atrFloor: 0.25,
    // Risk
    tp: 1.5, sl: 0.8, maxBars: 30,
    // Direction
    allowShorts: false,
  },
  buildExitRules({ params }) {
    return { tp: params.tp, sl: params.sl, maxBars: params.maxBars };
  },
  build({ bars, params }) {
    const p = params;
    const sar     = psarSeries(bars.highs, bars.lows, p.psarStart, p.psarInc, p.psarMax);
    const trendMA = emaSeries(bars.closes, p.maLen);
    const { macdLine } = macd(bars.closes);
    const rsiArr  = rsiSeries(bars.closes, p.rsiLen);
    const ci      = chopSeries(bars.highs, bars.lows, bars.closes, p.ciLen);
    const volMA   = smaSeries(bars.volumes, 20);
    const atrArr  = atrSeries(bars.highs, bars.lows, bars.closes, 14);

    const warm = Math.max(p.maLen, p.ciLen, 26) + 1; // 26 for MACD slow default

    return ({ i, state }) => {
      if (i < warm) return { entry: false, exitSignal: false };
      if (state.inTrade) return { exitSignal: false };

      // Choppiness filter — only trade when trending
      const trending = ci[i] < p.ciThresh;
      if (!trending) return { entry: false };

      // Volume filter
      const volOK = volMA[i] > 0 && bars.volumes[i] > volMA[i] * p.volMult;
      if (!volOK) return { entry: false };

      // ATR volatility floor (skip dead sessions)
      const atrPct = bars.closes[i] > 0 ? (atrArr[i] / bars.closes[i]) * 100 : 0;
      if (atrPct < p.atrFloor) return { entry: false };

      // 4-factor confluence
      const psarLong  = bars.closes[i] > sar[i];
      const trendLong = bars.closes[i] > trendMA[i] && trendMA[i] > 0;
      const macdLong  = macdLine[i] >= 0;
      const rsiLong   = rsiArr[i] !== null && rsiArr[i] >= p.rsiLongTh;

      if (psarLong && trendLong && macdLong && rsiLong) {
        return { entry: true, direction: 'long' };
      }

      if (p.allowShorts) {
        const psarShort  = bars.closes[i] < sar[i];
        const trendShort = bars.closes[i] < trendMA[i] && trendMA[i] > 0;
        const macdShort  = macdLine[i] <= 0;
        const rsiShort   = rsiArr[i] !== null && rsiArr[i] <= p.rsiShortTh;

        if (psarShort && trendShort && macdShort && rsiShort) {
          return { entry: true, direction: 'short' };
        }
      }

      return { entry: false };
    };
  },
};
