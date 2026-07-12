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
 *
 * Optional momentum confirmation (Phase I):
 *   useMacd — require MACD histogram rising on the current bar (bounce turning up).
 *             LOCKED ON by default: on large_cap 15m (~55d Upstox cap) this took the
 *             strategy from -16.4% (50 tr, WR 14%, 0/10) to -5.6% (23 tr, WR 22%,
 *             1/10) — it halves overtrading and nearly doubles win rate. Still
 *             experimental (short intraday history; needs more data to validate).
 *   useRsi  — optional current-bar RSI(rsiLen) < rsiMax oversold confirm (default OFF;
 *             rsiMax=40 — note <30 is too strict for 15m and zeroes out entries).
 * Canonical Pine: pdf/profitable/ibs_india_intraday.pine (keep params in sync).
 */
import { ibs, sma, rollingVwap, atrSeries, rsiSeries, macd } from '../indicators.js';
import { isNseSessionBar, isInIstWindow, isNseHoliday, istClock, NSE_DEFAULTS } from '../india-session.js';

export default {
  warmup: 35,
  defaultParams: {
    ibsEntry: 0.25, ibsExit: 0.75,
    volMult: 1.5,
    minAtrPct: 0.15,
    useVolatility: true,
    useSession: true,                      // NSE 09:15-15:30 enforcement
    entryWindow: NSE_DEFAULTS.ENTRY_WINDOW, // "0930-1430"
    exitWindow:  NSE_DEFAULTS.EXIT_WINDOW,  // "1500-1530"
    skipThursdayPM: true,                  // skip Thursday 14:00+ (F&O expiry pin)
    // ── momentum confirmation (Phase I tuned: MACD locked on, RSI opt-in) ──
    useRsi: false, rsiLen: 14, rsiMax: 40,
    useMacd: true,
    tp: 0.7, sl: 0.5, maxBars: 12,
  },
  buildExitRules({ params }) {
    return { tp: params.tp, sl: params.sl, maxBars: params.maxBars };
  },
  build({ bars, params }) {
    const atrArr = atrSeries(bars.highs, bars.lows, bars.closes, 14);
    const p = params;
    const warm = p.useMacd ? 35 : 25;
    const rsiArr = p.useRsi  ? rsiSeries(bars.closes, p.rsiLen) : null;
    const hist   = p.useMacd ? macd(bars.closes).histogram      : null;
    return ({ i, state, bars }) => {
      if (i < warm) return { entry: false, exitSignal: false };
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

      // ── Optional momentum confirmation (current bar, matches vwap/atr confirms) ──
      const rsiOK  = !p.useRsi  || (rsiArr[i] !== null && rsiArr[i] < p.rsiMax);
      const macdOK = !p.useMacd || (i >= 1 && hist[i] > hist[i - 1]);

      // Only enter inside the entry window (defaults 09:30-14:30 IST)
      const inEntryWindow = !p.useSession || !t || isInIstWindow(t, p.entryWindow);

      return {
        entry:      !state.inTrade && ibsPrev < p.ibsEntry && volOK && vwapOK && volatilityOK
                    && rsiOK && macdOK && inEntryWindow,
        exitSignal: state.inTrade && ibsCur > p.ibsExit,
      };
    };
  },
};
