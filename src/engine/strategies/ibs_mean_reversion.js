/**
 * IBS Mean Reversion (Generic Baseline) — no India-specific tuning.
 * Buy when prior bar's IBS < ibsThresh (close near low) + volume confirmation.
 * Exit: TP 2% / SL 1% / signal exit when close > prev close / max 5 bars.
 *
 * Phase I tuning (large_cap 4y, 288 combos): SMA+MACD filters dominate ALL top-5 slots.
 *   Best robust combo: ibsThresh=0.15, tp=2, sl=1, maxBars=5, useSma=true, useMacd=true
 *   → -9.8% (35 tr, WR 34%, 2/10 prof, best +5.5%). Significantly better than baseline
 *   (no-filter version = -50%+ range). Still net-negative; stays experimental.
 *
 * Confirmation filters (Phase I; useSma + useMacd LOCKED ON):
 *   useSma  — require close > SMA(smaLen) (trend — avoid falling knives).
 *   useRsi  — require RSI(rsiLen) < rsiMax (oversold confirm, OFF — did not help on top of SMA+MACD).
 *   useMacd — require MACD histogram rising (bounce turning up).
 * Canonical Pine: pdf/untested/ibs_mean_reversion.pine (keep params in sync).
 */
import { ibs, sma, rsiSeries, macd } from '../indicators.js';

export default {
  warmup: 55,
  defaultParams: {
    ibsThresh: 0.15, volLen: 20, volMult: 1.0,
    // ── confirmation (Phase I tuned: SMA+MACD locked on, RSI opt-in) ──
    useSma: true, smaLen: 50,
    useRsi: false, rsiLen: 14, rsiMax: 30,
    useMacd: true,
    tp: 2.0, sl: 1.0, maxBars: 5,
  },
  buildExitRules({ params }) {
    return { tp: params.tp, sl: params.sl, maxBars: params.maxBars };
  },
  build({ bars, params }) {
    const p = params;
    const rsiArr = p.useRsi  ? rsiSeries(bars.closes, p.rsiLen) : null;
    const hist   = p.useMacd ? macd(bars.closes).histogram      : null;
    return ({ i, state, bars }) => {
      if (i < Math.max(p.smaLen, 35, 2)) return { entry: false, exitSignal: false };

      const ibsPrev = ibs(bars.highs[i - 1], bars.lows[i - 1], bars.closes[i - 1]);

      const volMA = sma(bars.volumes, p.volLen, i - 1);
      const volOK = volMA > 0 && bars.volumes[i - 1] > volMA * p.volMult;

      // ── Optional confirmation (signal bar = i-1) ──
      const smaVal = p.useSma ? sma(bars.closes, p.smaLen, i - 1) : 0;
      const smaOK  = !p.useSma || (smaVal > 0 && bars.closes[i - 1] > smaVal);
      const rsiOK  = !p.useRsi  || (rsiArr[i - 1] !== null && rsiArr[i - 1] < p.rsiMax);
      const macdOK = !p.useMacd || (i >= 2 && hist[i - 1] > hist[i - 2]);

      // Discretionary exit: close > prev close (bounce completed)
      const bounceExit = state.inTrade && bars.closes[i] > bars.closes[i - 1];

      return {
        entry: !state.inTrade && ibsPrev < p.ibsThresh && volOK && smaOK && rsiOK && macdOK,
        exitSignal: bounceExit,
      };
    };
  },
};
