/**
 * Indicators — rolling technical indicators on bar arrays.
 *
 * Conventions:
 *   - `bars` is `{opens, highs, lows, closes, volumes, times}` (parallel arrays).
 *   - Functions ending in `Series` return a full array (same length as input,
 *     leading values are 0 or NaN until warmup completes).
 *   - Pointwise helpers take `(values, period, endIdx)` and return scalar
 *     value AT endIdx using the trailing `period` values.
 */

// ── Moving Averages ───────────────────────────────────────────────────────

export function sma(values, period, endIdx) {
  if (endIdx < period - 1) return 0;
  let sum = 0;
  for (let i = endIdx - period + 1; i <= endIdx; i++) sum += values[i];
  return sum / period;
}

export function smaSeries(values, period) {
  const out = new Array(values.length).fill(0);
  for (let i = period - 1; i < values.length; i++) {
    let sum = 0;
    for (let k = i - period + 1; k <= i; k++) sum += values[k];
    out[i] = sum / period;
  }
  return out;
}

export function emaSeries(values, period) {
  const out = new Array(values.length).fill(0);
  const k = 2 / (period + 1);
  let ema = 0;
  for (let i = 0; i < values.length; i++) {
    if (i < period) {
      ema += values[i] / period;
      out[i] = i === period - 1 ? ema : 0;
    } else {
      ema = values[i] * k + ema * (1 - k);
      out[i] = ema;
    }
  }
  return out;
}

// Wilder smoothing (RMA) — used by RSI, ATR, ADX
export function rmaSeries(values, period) {
  const out = new Array(values.length).fill(0);
  let rma = 0;
  for (let i = 0; i < values.length; i++) {
    if (i < period) {
      rma += values[i] / period;
      out[i] = i === period - 1 ? rma : 0;
    } else {
      rma = (rma * (period - 1) + values[i]) / period;
      out[i] = rma;
    }
  }
  return out;
}

// ── Oscillators ───────────────────────────────────────────────────────────

export function rsi(closes, period, endIdx) {
  if (endIdx < period) return null;
  let avgGain = 0, avgLoss = 0;
  for (let i = endIdx - period + 1; i <= endIdx; i++) {
    const change = closes[i] - closes[i - 1];
    if (change > 0) avgGain += change;
    else avgLoss -= change;
  }
  avgGain /= period;
  avgLoss /= period;
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

export function rsiSeries(closes, period) {
  const out = new Array(closes.length).fill(null);
  if (closes.length <= period) return out;
  let avgGain = 0, avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    const ch = closes[i] - closes[i - 1];
    if (ch > 0) avgGain += ch;
    else avgLoss -= ch;
  }
  avgGain /= period;
  avgLoss /= period;
  out[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  for (let i = period + 1; i < closes.length; i++) {
    const ch = closes[i] - closes[i - 1];
    const gain = ch > 0 ? ch : 0;
    const loss = ch < 0 ? -ch : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return out;
}

export function stochRsi(closes, rsiPeriod, stochPeriod, endIdx) {
  if (endIdx < rsiPeriod + stochPeriod) return null;
  const rsiVals = [];
  for (let i = endIdx - stochPeriod + 1; i <= endIdx; i++) {
    const r = rsi(closes, rsiPeriod, i);
    if (r !== null) rsiVals.push(r);
  }
  if (rsiVals.length === 0) return null;
  const min = Math.min(...rsiVals);
  const max = Math.max(...rsiVals);
  if (max === min) return 50;
  return ((rsiVals[rsiVals.length - 1] - min) / (max - min)) * 100;
}

export function macd(closes, fast = 12, slow = 26, signal = 9) {
  const emaFast = emaSeries(closes, fast);
  const emaSlow = emaSeries(closes, slow);
  const macdLine = closes.map((_, i) => emaFast[i] - emaSlow[i]);
  const signalLine = emaSeries(macdLine, signal);
  const histogram = macdLine.map((v, i) => v - signalLine[i]);
  return { macdLine, signalLine, histogram };
}

// ── Volatility ────────────────────────────────────────────────────────────

export function trueRangeSeries(highs, lows, closes) {
  const out = new Array(closes.length).fill(0);
  for (let i = 1; i < closes.length; i++) {
    out[i] = Math.max(
      highs[i] - lows[i],
      Math.abs(highs[i] - closes[i - 1]),
      Math.abs(lows[i] - closes[i - 1])
    );
  }
  return out;
}

export function atrSeries(highs, lows, closes, period = 14) {
  const tr = trueRangeSeries(highs, lows, closes);
  return rmaSeries(tr, period);
}

export function atr(highs, lows, closes, period, endIdx) {
  return atrSeries(highs, lows, closes, period)[endIdx] || 0;
}

// ── Bollinger Bands ───────────────────────────────────────────────────────

export function bollinger(closes, period, mult, endIdx) {
  if (endIdx < period - 1) return null;
  const slice = closes.slice(endIdx - period + 1, endIdx + 1);
  const mean = slice.reduce((a, b) => a + b, 0) / period;
  const variance = slice.reduce((s, v) => s + (v - mean) ** 2, 0) / period;
  const std = Math.sqrt(variance);
  return {
    mid: mean,
    upper: mean + mult * std,
    lower: mean - mult * std,
    width: ((mult * 2 * std) / mean) * 100, // % bandwidth
  };
}

// ── VWAP (rolling proxy — no session reset) ───────────────────────────────

export function rollingVwap(highs, lows, closes, volumes, period, endIdx) {
  if (endIdx < period - 1) return null;
  let pvSum = 0, vSum = 0;
  for (let i = endIdx - period + 1; i <= endIdx; i++) {
    const tp = (highs[i] + lows[i] + closes[i]) / 3;
    pvSum += tp * volumes[i];
    vSum += volumes[i];
  }
  return vSum > 0 ? pvSum / vSum : closes[endIdx];
}

// ── Internal Bar Strength ─────────────────────────────────────────────────

export function ibs(high, low, close) {
  return high !== low ? (close - low) / (high - low) : 0.5;
}

// ── Supertrend (returns direction + level at endIdx) ──────────────────────

export function supertrendSeries(highs, lows, closes, period = 10, mult = 3) {
  const n = closes.length;
  const atrArr = atrSeries(highs, lows, closes, period);
  const upper = new Array(n).fill(0);
  const lower = new Array(n).fill(0);
  const trend = new Array(n).fill(1); // 1=up, -1=down
  const st = new Array(n).fill(0);
  for (let i = 0; i < n; i++) {
    const hl2 = (highs[i] + lows[i]) / 2;
    const basicUpper = hl2 + mult * atrArr[i];
    const basicLower = hl2 - mult * atrArr[i];
    upper[i] = i === 0 ? basicUpper
      : (basicUpper < upper[i - 1] || closes[i - 1] > upper[i - 1]) ? basicUpper : upper[i - 1];
    lower[i] = i === 0 ? basicLower
      : (basicLower > lower[i - 1] || closes[i - 1] < lower[i - 1]) ? basicLower : lower[i - 1];
    trend[i] = i === 0 ? 1
      : closes[i] > upper[i - 1] ? 1
      : closes[i] < lower[i - 1] ? -1
      : trend[i - 1];
    st[i] = trend[i] === 1 ? lower[i] : upper[i];
  }
  return { trend, st, upper, lower };
}

// ── Highest / Lowest in window ────────────────────────────────────────────

export function highest(values, period, endIdx) {
  if (endIdx < period - 1) return 0;
  let h = -Infinity;
  for (let i = endIdx - period + 1; i <= endIdx; i++) if (values[i] > h) h = values[i];
  return h;
}

export function lowest(values, period, endIdx) {
  if (endIdx < period - 1) return 0;
  let l = Infinity;
  for (let i = endIdx - period + 1; i <= endIdx; i++) if (values[i] < l) l = values[i];
  return l;
}

// ── Rate of Change ────────────────────────────────────────────────────────

export function roc(closes, period, endIdx) {
  if (endIdx < period) return 0;
  const past = closes[endIdx - period];
  if (past === 0) return 0;
  return ((closes[endIdx] - past) / past) * 100;
}

// ── Parabolic SAR (Wilder) ────────────────────────────────────────────────
export function psarSeries(highs, lows, start = 0.02, inc = 0.02, max = 0.20) {
  const n = highs.length;
  const sar = new Array(n).fill(0);
  if (n < 2) return sar;

  // Initialize: assume first bar is uptrend
  let isLong = highs[1] > highs[0] || lows[1] > lows[0];
  let af = start;
  let ep = isLong ? highs[0] : lows[0];
  sar[0] = isLong ? lows[0] : highs[0];

  for (let i = 1; i < n; i++) {
    // Calculate SAR for this bar
    sar[i] = sar[i - 1] + af * (ep - sar[i - 1]);

    // Clamp SAR so it doesn't penetrate prior bars
    if (isLong) {
      sar[i] = Math.min(sar[i], lows[i - 1]);
      if (i >= 2) sar[i] = Math.min(sar[i], lows[i - 2]);
    } else {
      sar[i] = Math.max(sar[i], highs[i - 1]);
      if (i >= 2) sar[i] = Math.max(sar[i], highs[i - 2]);
    }

    // Check for reversal
    let reverse = false;
    if (isLong && lows[i] < sar[i]) {
      reverse = true;
      isLong = false;
      sar[i] = ep; // SAR = prior EP on reversal
      af = start;
      ep = lows[i];
    } else if (!isLong && highs[i] > sar[i]) {
      reverse = true;
      isLong = true;
      sar[i] = ep;
      af = start;
      ep = highs[i];
    }

    if (!reverse) {
      // Update EP and AF
      if (isLong) {
        if (highs[i] > ep) {
          ep = highs[i];
          af = Math.min(af + inc, max);
        }
      } else {
        if (lows[i] < ep) {
          ep = lows[i];
          af = Math.min(af + inc, max);
        }
      }
    }
  }
  return sar;
}

// ── Choppiness Index ──────────────────────────────────────────────────────
export function chopSeries(highs, lows, closes, period = 14) {
  const n = highs.length;
  const ci = new Array(n).fill(50);
  const tr = trueRangeSeries(highs, lows, closes);
  for (let i = period; i < n; i++) {
    let sumTR = 0;
    let hiMax = -Infinity, loMin = Infinity;
    for (let j = i - period + 1; j <= i; j++) {
      sumTR += tr[j];
      if (highs[j] > hiMax) hiMax = highs[j];
      if (lows[j] < loMin) loMin = lows[j];
    }
    const range = hiMax - loMin;
    ci[i] = range > 0 ? 100 * Math.log10(sumTR / range) / Math.log10(period) : 50;
  }
  return ci;
}
