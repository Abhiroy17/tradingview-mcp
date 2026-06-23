/**
 * IBS Mean Reversion — India Intraday (5m / 15m / 30m / 1H).
 *
 * Buy oversold IBS readings during the NSE continuous session, exit on bounce
 * or force-flat near close. Stricter IBS threshold + rolling VWAP filter.
 *
 * NSE session enforcement (added Phase C):
 *   • Entry window:    09:30 – 14:30 IST  (skip volatile open + last hour)
 *   • Force-exit:      15:00 – 15:30 IST  (no overnight risk on intraday script)
 *   • Skip Thursday ≥ 14:00 IST (F&O weekly expiry pin distorts price)
 *   • Skip NSE holiday bars (defensive: data should already exclude these)
 */
import { ibs, sma, rollingVwap, atrSeries } from '../indicators.js';
import { isNseSessionBar, isInIstWindow, isNseHoliday, istClock, NSE_DEFAULTS } from '../india-session.js';

export default {
  warmup: 25,
  defaultParams: {
    ibsEntry: 0.25, ibsExit: 0.75,
    volMult: 1.5,
    minAtrPct: 0.15,
    useVolatility: true,
    useSession: true,                      // NSE 09:15-15:30 enforcement
    entryWindow: NSE_DEFAULTS.ENTRY_WINDOW, // "0930-1430"
    exitWindow:  NSE_DEFAULTS.EXIT_WINDOW,  // "1500-1530"
    skipThursdayPM: true,                  // skip Thursday 14:00+ (F&O expiry pin)
    tp: 0.7, sl: 0.5, maxBars: 12,
  },
  buildExitRules({ params }) {
    return { tp: params.tp, sl: params.sl, maxBars: params.maxBars };
  },
  build({ bars, params }) {
    const atrArr = atrSeries(bars.highs, bars.lows, bars.closes, 14);
    const p = params;
    return ({ i, state, bars }) => {
      if (i < 25) return { entry: false, exitSignal: false };
      const t = bars.times?.[i];

      // ---- NSE session gating ----
      if (p.useSession && t) {
        if (!isNseSessionBar(t) || isNseHoliday(t)) {
          // Out of session: no new entries, force exit any open position.
          return { entry: false, exitSignal: state.inTrade };
        }
        // Force-exit during the closing window (15:00-15:30 IST)
        if (isInIstWindow(t, p.exitWindow)) {
          return { entry: false, exitSignal: state.inTrade };
        }
        // Skip Thursday afternoon (F&O weekly expiry pin)
        if (p.skipThursdayPM) {
          const c = istClock(t);
          if (c && c.dow === 4 && c.h >= 14) {
            return { entry: false, exitSignal: state.inTrade };
          }
        }
      }

      // ---- Standard IBS entry logic ----
      const ibsPrev = ibs(bars.highs[i - 1], bars.lows[i - 1], bars.closes[i - 1]);
      const ibsCur  = ibs(bars.highs[i],     bars.lows[i],     bars.closes[i]);

      const volMA = sma(bars.volumes, 20, i - 1);
      const volOK = volMA > 0 && bars.volumes[i - 1] > volMA * p.volMult;

      const vwap   = rollingVwap(bars.highs, bars.lows, bars.closes, bars.volumes, 20, i);
      const vwapOK = vwap === null || bars.closes[i] > vwap;

      const atrPct       = bars.closes[i] > 0 ? (atrArr[i] / bars.closes[i]) * 100 : 0;
      const volatilityOK = !p.useVolatility || atrPct >= p.minAtrPct;

      // Only enter inside the entry window (defaults 09:30-14:30 IST)
      const inEntryWindow = !p.useSession || !t || isInIstWindow(t, p.entryWindow);

      return {
        entry:      !state.inTrade && ibsPrev < p.ibsEntry && volOK && vwapOK && volatilityOK && inEntryWindow,
        exitSignal: state.inTrade && ibsCur > p.ibsExit,
      };
    };
  },
};
