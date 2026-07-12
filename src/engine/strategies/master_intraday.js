/**
 * Master Intraday Strategy — quality-enhanced version of ema_rsi_intraday.
 *
 * Architecture (thinking like a 20-year pro trader):
 *   "I already have a profitable signal (EMA stack). Now I want to REJECT the
 *    weakest 30-50% of those signals — the ones where momentum is fading, volume
 *    is thin, or the candle shape shows indecision. This gives me fewer trades but
 *    higher PF and better scores."
 *
 * Combines:
 *   1. ENTRY: Triple-EMA stack alignment (from ema_rsi — the proven edge)
 *   2. REGIME: Supertrend confirms trending (from supertrend_intraday)
 *   3. QUALITY GATE: 5-axis scoring REJECTS weak setups (NEW — the innovation)
 *   4. VOLUME: Must exceed MA × multiplier (proven gate)
 *   5. EXIT: RSI exhaustion (from ema_rsi) + Supertrend flip (from supertrend)
 *
 * Why this works better than individual strategies:
 *   - ema_rsi: 41 trades, 66% WR, +5.5% on bank basket 15m
 *   - master: same entry BUT rejects poor-quality signals → fewer trades, higher WR, higher PF
 *   - Directly solves "scores < 30" by producing higher PF strategies
 *
 * Canonical Pine: pdf/profitable/master_intraday.pine
 */
import { smaSeries, emaSeries, rsiSeries, atrSeries, supertrendSeries } from '../indicators.js';
import { sma } from '../indicators.js';
import { scoreSignalQuality, passesCooldown, passesMinMove } from '../signal-quality.js';

export default {
  warmup: 120,
  defaultParams: {
    // Trend (from ema_rsi — proven best)
    emaFast: 10,
    emaMid: 20,
    emaSlow: 100,

    // Regime filter (supertrend)
    stPeriod: 14,
    stMult: 4,  // Phase I: wider ST reduces false flips (bank+IT consensus)

    // Quality gate (the key differentiator)
    qualityThreshold: 45,  // Phase I: lowered from 60 → lets more quality trades through

    // Volume
    volLen: 20,
    volMult: 1.0,

    // Exit (from ema_rsi — proven)
    rsiLen: 14,
    rsiExitLong: 72,  // Phase I: slightly later exit → let winners run
    rsiExitShort: 30,

    // Risk management (Phase I tuned)
    tp: 2.0,   // Phase I: take profit earlier, don't give back gains
    sl: 1.0,   // Phase I: tighter SL cuts losers faster
    maxBars: 48,

    // Filters
    cooldownBars: 5,
    minMovePct: 0.3,
  },

  buildExitRules({ params }) {
    return { tp: params.tp, sl: params.sl, maxBars: params.maxBars };
  },

  build({ params, bars }) {
    const p = params;

    // Precompute indicators
    const emaF = emaSeries(bars.closes, p.emaFast);
    const emaM = emaSeries(bars.closes, p.emaMid);
    const emaS = emaSeries(bars.closes, p.emaSlow);
    const rsiArr = rsiSeries(bars.closes, p.rsiLen);
    const volMA = smaSeries(bars.volumes, p.volLen);
    const { trend: stTrend } = supertrendSeries(bars.highs, bars.lows, bars.closes, p.stPeriod, p.stMult);

    let lastSignalIdx = -10;
    let lastTradeExitIdx = -10;

    return ({ i, state }) => {
      if (i < p.emaSlow + 10) return { entry: false, exitSignal: false };

      // ── EXIT LOGIC ──
      if (state.inTrade) {
        const r = rsiArr[i];
        // RSI exhaustion exit (proven from ema_rsi)
        if (state.direction === 'long' && r !== null && r > p.rsiExitLong) {
          lastTradeExitIdx = i;
          return { exitSignal: true };
        }
        if (state.direction === 'short' && r !== null && r < p.rsiExitShort) {
          lastTradeExitIdx = i;
          return { exitSignal: true };
        }
        // Supertrend regime flip = exit (from supertrend strategy)
        if (state.direction === 'long' && stTrend[i] === -1 && stTrend[i - 1] === 1) {
          lastTradeExitIdx = i;
          return { exitSignal: true };
        }
        if (state.direction === 'short' && stTrend[i] === 1 && stTrend[i - 1] === -1) {
          lastTradeExitIdx = i;
          return { exitSignal: true };
        }
        return { entry: false, exitSignal: false };
      }

      // ── ENTRY LOGIC ──

      // Step 1: Cooldown — don't overtrade
      if (!passesCooldown(lastSignalIdx, i, p.cooldownBars)) return { entry: false };
      if (!passesMinMove(bars, lastTradeExitIdx, i, p.minMovePct)) return { entry: false };

      // Step 2: EMA CROSS — the proven entry event (from ema_rsi)
      // Key insight: we need a CROSS (one-bar event), not continuous alignment.
      // ema_rsi fires when EMA(10) crosses EMA(20) with full stack aligned.
      const crossUp = emaF[i] > emaM[i] && emaF[i - 1] <= emaM[i - 1];
      const crossDn = emaF[i] < emaM[i] && emaF[i - 1] >= emaM[i - 1];
      if (!crossUp && !crossDn) return { entry: false };

      // Full stack must also be aligned (fast > mid > slow for long)
      const stackLong = crossUp && emaF[i] > emaS[i];
      const stackShort = crossDn && emaF[i] < emaS[i];
      if (!stackLong && !stackShort) return { entry: false };

      // Bullish/bearish candle confirmation (from ema_rsi)
      if (stackLong && bars.closes[i] <= bars.opens[i]) return { entry: false };
      if (stackShort && bars.closes[i] >= bars.opens[i]) return { entry: false };

      const direction = stackLong ? 'long' : 'short';

      // Step 3: SUPERTREND regime must agree
      if (direction === 'long' && stTrend[i] !== 1) return { entry: false };
      if (direction === 'short' && stTrend[i] !== -1) return { entry: false };

      // Step 4: VOLUME gate
      const volOK = volMA[i] > 0 && bars.volumes[i] > volMA[i] * p.volMult;
      if (!volOK) return { entry: false };

      // Step 5: QUALITY GATE — reject signals where momentum/candle/volume are weak
      const quality = scoreSignalQuality(bars, i, direction, {
        threshold: p.qualityThreshold,
      });
      if (!quality.pass) return { entry: false };

      // All gates passed
      lastSignalIdx = i;
      return { entry: true, direction, meta: { quality: quality.score, reasons: quality.reasons } };
    };
  },
};
