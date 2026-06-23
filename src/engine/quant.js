/**
 * Quant — statistical primitives for performance analysis.
 *
 * All functions are pure. Inputs are arrays of numbers (returns, equity
 * curve points, etc). Outputs are scalars or small objects.
 *
 * Lifted unchanged from dashboard.js (Jane Street-grade metrics).
 */

export const Quant = {
  // Welford's online mean/variance/skew/kurt (numerically stable)
  stats(arr) {
    const n = arr.length;
    if (n === 0) return { mean: 0, std: 0, variance: 0, skew: 0, kurt: 0, n: 0 };
    let mean = 0, M2 = 0, M3 = 0, M4 = 0;
    for (let i = 0; i < n; i++) {
      const x = arr[i];
      const delta = x - mean;
      const delta_n = delta / (i + 1);
      const delta_n2 = delta_n * delta_n;
      const term1 = delta * delta_n * i;
      mean += delta_n;
      M4 += term1 * delta_n2 * (i * i - 3 * i + 3) + 6 * delta_n2 * M2 - 4 * delta_n * M3;
      M3 += term1 * delta_n * (i - 1) - 3 * delta_n * M2;
      M2 += term1;
    }
    const variance = n > 1 ? M2 / (n - 1) : 0;
    const std = Math.sqrt(variance);
    const skew = n > 2 && M2 > 0 ? (Math.sqrt(n) * M3) / Math.pow(M2, 1.5) : 0;
    const kurt = n > 3 && M2 > 0 ? (n * M4) / (M2 * M2) - 3 : 0;
    return { mean, std, variance, skew, kurt, n };
  },

  // Wilson score interval lower bound (better than Wald for small n)
  wilsonLower(wins, n, z = 1.96) {
    if (n === 0) return 0;
    const p = wins / n;
    const denom = 1 + (z * z) / n;
    const center = p + (z * z) / (2 * n);
    const margin = z * Math.sqrt((p * (1 - p) + (z * z) / (4 * n)) / n);
    return Math.max(0, (center - margin) / denom);
  },

  // Probabilistic Sharpe Ratio (Bailey & López de Prado 2012)
  probabilisticSharpe(returns, benchmarkSR = 0) {
    const s = Quant.stats(returns);
    if (s.n < 4 || s.std === 0) return 0;
    const sr = s.mean / s.std;
    const psrDenom = Math.sqrt((1 - s.skew * sr + (s.kurt / 4) * sr * sr) / (s.n - 1));
    if (psrDenom === 0) return sr > benchmarkSR ? 1 : 0;
    const z = (sr - benchmarkSR) / psrDenom;
    return Quant.normalCDF(z);
  },

  // Deflated Sharpe Ratio — corrects for selection bias
  deflatedSharpe(returns, numTrials = 1) {
    const s = Quant.stats(returns);
    if (s.n < 4 || s.std === 0 || numTrials < 1) return 0;
    const sr = s.mean / s.std;
    const emc = 0.5772156649;
    const expectedMax = Math.sqrt(2 * Math.log(Math.max(numTrials, 2))) -
      (emc / Math.sqrt(2 * Math.log(Math.max(numTrials, 2))));
    const psrDenom = Math.sqrt((1 - s.skew * sr + (s.kurt / 4) * sr * sr) / (s.n - 1));
    if (psrDenom === 0) return 0;
    const z = (sr - expectedMax) / psrDenom;
    return Quant.normalCDF(z);
  },

  normalCDF(x) {
    const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741;
    const a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911;
    const sign = x < 0 ? -1 : 1;
    x = Math.abs(x) / Math.sqrt(2);
    const t = 1.0 / (1.0 + p * x);
    const y = 1.0 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);
    return 0.5 * (1.0 + sign * y);
  },

  sortino(returns, mar = 0) {
    if (returns.length < 2) return 0;
    const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
    const downside = returns.filter(r => r < mar).map(r => (r - mar) ** 2);
    if (downside.length === 0) return mean > 0 ? 99 : 0;
    const downsideStd = Math.sqrt(downside.reduce((a, b) => a + b, 0) / downside.length);
    return downsideStd > 0 ? (mean - mar) / downsideStd : 0;
  },

  calmar(totalReturn, maxDrawdown) {
    if (maxDrawdown <= 0) return totalReturn > 0 ? 99 : 0;
    return totalReturn / maxDrawdown;
  },

  ulcerIndex(equity) {
    if (equity.length < 2) return 0;
    let sumSqDD = 0, peak = equity[0];
    for (const v of equity) {
      peak = Math.max(peak, v);
      const dd = peak === 0 ? 0 : ((v - peak) / Math.max(Math.abs(peak), 1)) * 100;
      sumSqDD += dd * dd;
    }
    return Math.sqrt(sumSqDD / equity.length);
  },

  bootstrapMean(returns, iterations = 1000, confidence = 0.95) {
    if (returns.length < 5) return { lower: 0, upper: 0, mean: 0 };
    const n = returns.length;
    const means = new Array(iterations);
    for (let it = 0; it < iterations; it++) {
      let sum = 0;
      for (let i = 0; i < n; i++) sum += returns[Math.floor(Math.random() * n)];
      means[it] = sum / n;
    }
    means.sort((a, b) => a - b);
    const lo = Math.floor(((1 - confidence) / 2) * iterations);
    const hi = Math.floor((1 - (1 - confidence) / 2) * iterations);
    const mean = returns.reduce((a, b) => a + b, 0) / n;
    return { lower: means[lo], upper: means[hi], mean };
  },

  adx(highs, lows, closes, period = 14) {
    const n = closes.length;
    if (n < period * 2) return null;
    const trs = [], plusDMs = [], minusDMs = [];
    for (let i = 1; i < n; i++) {
      const tr = Math.max(highs[i] - lows[i], Math.abs(highs[i] - closes[i - 1]), Math.abs(lows[i] - closes[i - 1]));
      const upMove = highs[i] - highs[i - 1];
      const downMove = lows[i - 1] - lows[i];
      trs.push(tr);
      plusDMs.push(upMove > downMove && upMove > 0 ? upMove : 0);
      minusDMs.push(downMove > upMove && downMove > 0 ? downMove : 0);
    }
    let trAvg = trs.slice(0, period).reduce((a, b) => a + b, 0);
    let plusDM = plusDMs.slice(0, period).reduce((a, b) => a + b, 0);
    let minusDM = minusDMs.slice(0, period).reduce((a, b) => a + b, 0);
    const dxs = [];
    for (let i = period; i < trs.length; i++) {
      trAvg = trAvg - trAvg / period + trs[i];
      plusDM = plusDM - plusDM / period + plusDMs[i];
      minusDM = minusDM - minusDM / period + minusDMs[i];
      const plusDI = trAvg > 0 ? (plusDM / trAvg) * 100 : 0;
      const minusDI = trAvg > 0 ? (minusDM / trAvg) * 100 : 0;
      const sumDI = plusDI + minusDI;
      const dx = sumDI > 0 ? (Math.abs(plusDI - minusDI) / sumDI) * 100 : 0;
      dxs.push(dx);
    }
    if (dxs.length < period) return null;
    let adx = dxs.slice(0, period).reduce((a, b) => a + b, 0) / period;
    for (let i = period; i < dxs.length; i++) adx = (adx * (period - 1) + dxs[i]) / period;
    return adx;
  },

  hurst(values) {
    if (values.length < 50) return null;
    const N = values.length;
    const lags = [10, 20, 40, Math.min(80, Math.floor(N / 2))];
    const rsVals = [];
    const lagVals = [];
    for (const lag of lags) {
      if (lag >= N) continue;
      const returns = [];
      for (let i = 1; i < lag + 1; i++) {
        returns.push(Math.log(values[N - lag + i - 1] / values[N - lag + i - 2]));
      }
      if (returns.length < 2) continue;
      const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
      let cumDev = 0, minCum = 0, maxCum = 0;
      for (const r of returns) {
        cumDev += r - mean;
        minCum = Math.min(minCum, cumDev);
        maxCum = Math.max(maxCum, cumDev);
      }
      const range = maxCum - minCum;
      const std = Math.sqrt(returns.reduce((a, b) => a + (b - mean) ** 2, 0) / returns.length);
      if (std === 0 || range === 0) continue;
      rsVals.push(Math.log(range / std));
      lagVals.push(Math.log(lag));
    }
    if (rsVals.length < 2) return null;
    const m = rsVals.length;
    const sumX = lagVals.reduce((a, b) => a + b, 0);
    const sumY = rsVals.reduce((a, b) => a + b, 0);
    const sumXY = lagVals.reduce((s, x, i) => s + x * rsVals[i], 0);
    const sumXX = lagVals.reduce((s, x) => s + x * x, 0);
    const slope = (m * sumXY - sumX * sumY) / (m * sumXX - sumX * sumX);
    return slope;
  },

  varianceRatio(closes, lag = 5) {
    if (closes.length < lag * 4) return null;
    const returns = [];
    for (let i = 1; i < closes.length; i++) returns.push(Math.log(closes[i] / closes[i - 1]));
    const lagReturns = [];
    for (let i = lag; i < closes.length; i++) lagReturns.push(Math.log(closes[i] / closes[i - lag]));
    const var1 = Quant.stats(returns).variance;
    const varK = Quant.stats(lagReturns).variance;
    if (var1 === 0) return null;
    return varK / (lag * var1);
  },

  scale(x, midpoint, steepness = 1) {
    return 100 / (1 + Math.exp(-steepness * (x - midpoint)));
  },
};
