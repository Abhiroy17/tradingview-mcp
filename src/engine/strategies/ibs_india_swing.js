/**
 * IBS Mean Reversion — India Swing (Daily).
 *
 * Buy oversold daily closes (IBS < ibsEntry) with volume + 200-SMA trend +
 * volatility filter + min-price + liquidity + optional Thursday skip.
 * Exit: TP 2.5% / SL 1.5% / max 3 bars / IBS bounce signal.
 *
 * Momentum confirmation:
 *   useMacd — require MACD histogram rising on the signal bar (bounce turning up).
 *             LOCKED ON by default (Phase I): on a mid_cap 4y basket this took the
 *             strategy from -210.8% (e=0.35, no filter, 587 tr, 1/10 prof) to
 *             -4.3% (e=0.20, MACD on, 83 tr, 4/10 prof) — a +206pp swing. With the
 *             execution regime gate it is 5/10 prof. Still experimental: needs
 *             per-symbol calibration; deploy with execution.gateOnRegime: true.
 *   useRsi  — optional RSI(rsiLen) < rsiMax oversold confirm (default OFF; did not
 *             add value on top of MACD in the basket sweep).
 * Canonical Pine: pdf/profitable/ibs_india_swing.pine (keep params in sync).
 */
import { ibs, sma, atrSeries, rsiSeries, macd } from '../indicators.js';
import { isThursday, isNseHoliday } from '../india-session.js';

export default {
  warmup: 200,
  defaultParams: {
    ibsEntry: 0.20, ibsExit: 0.65,
    volMult: 1.0, trendLen: 200,
    gapThresh: 2.0, minTurnover: 2e7,
    minAtrPct: 1.5, maxAtrPct: 5.0, minPrice: 100,
    useTrend: true, useGap: true, useLiquidity: true,
    useVolatility: true, useMinPrice: true,
    skipThursday: false,
    // ── momentum confirmation (Phase I tuned: MACD locked on, RSI opt-in) ──
    useRsi: false, rsiLen: 14, rsiMax: 40,
    useMacd: true,
    tp: 2.5, sl: 1.5, maxBars: 3,
  },
  buildExitRules({ params }) {
    return { tp: params.tp, sl: params.sl, maxBars: params.maxBars };
  },
  build({ bars, params }) {
    const atrArr = atrSeries(bars.highs, bars.lows, bars.closes, 14);
    const p = params;
    const rsiArr = p.useRsi  ? rsiSeries(bars.closes, p.rsiLen) : null;
    const hist   = p.useMacd ? macd(bars.closes).histogram      : null;
    return ({ i, state, bars }) => {
      if (i < p.trendLen) return { entry: false, exitSignal: false };
      const ibsPrev = ibs(bars.highs[i - 1], bars.lows[i - 1], bars.closes[i - 1]);
      const ibsCur = ibs(bars.highs[i], bars.lows[i], bars.closes[i]);

      const volMA = sma(bars.volumes, 20, i - 1);
      const volOK = volMA > 0 && bars.volumes[i - 1] > volMA * p.volMult;

      const trendSMA = sma(bars.closes, p.trendLen, i - 1);
      const trendOK = !p.useTrend || (trendSMA > 0 && bars.closes[i - 1] > trendSMA);

      const atrPctPrev = atrArr[i - 1] > 0 && bars.closes[i - 1] > 0
        ? (atrArr[i - 1] / bars.closes[i - 1]) * 100 : 0;
      const volatilityOK = !p.useVolatility || (atrPctPrev >= p.minAtrPct && atrPctPrev <= p.maxAtrPct);

      const priceOK = !p.useMinPrice || bars.closes[i - 1] >= p.minPrice;

      const openPrice = bars.opens?.[i] ?? bars.closes[i];
      const gapOK = !p.useGap || openPrice >= bars.closes[i - 1] * (1 - p.gapThresh / 100);

      let liquidityOK = true;
      if (p.useLiquidity) {
        let turnoverSum = 0, count = 0;
        for (let k = Math.max(0, i - 20); k < i; k++) {
          turnoverSum += bars.volumes[k] * bars.closes[k];
          count++;
        }
        liquidityOK = (count > 0 ? turnoverSum / count : 0) >= p.minTurnover;
      }

      // ── Optional momentum confirmation (signal bar = i-1, matches IBS/volume) ──
      const rsiOK  = !p.useRsi  || (rsiArr[i - 1] !== null && rsiArr[i - 1] < p.rsiMax);
      const macdOK = !p.useMacd || (i >= 2 && hist[i - 1] > hist[i - 2]);

      // Thursday filter (F&O weekly expiry pin in India). Uses IST day-of-week.
      const t = bars.times?.[i];
      const notThursday = !p.skipThursday || !t || !isThursday(t);
      // Defensive: skip NSE holiday bars (data should already exclude these)
      const notHoliday  = !t || !isNseHoliday(t);

      return {
        entry: !state.inTrade && ibsPrev < p.ibsEntry && volOK && trendOK
               && volatilityOK && priceOK && gapOK && liquidityOK && rsiOK && macdOK
               && notThursday && notHoliday,
        exitSignal: state.inTrade && ibsCur > p.ibsExit,
      };
    };
  },
};
