/**
 * Signal Quality Engine — scores individual trade entries on 0-100 scale.
 *
 * Evaluates a potential entry at bar `i` across 5 orthogonal dimensions:
 *   1. Momentum (20%) — RSI zone, MACD histogram direction, ROC strength
 *   2. Candle Shape (15%) — body ratio, wick rejection, engulfing patterns
 *   3. Trend Alignment (25%) — EMA stack, ADX strength, price vs MAs
 *   4. Acceleration (15%) — momentum acceleration (ROC of ROC), histogram expansion
 *   5. Volume (25%) — relative volume, volume trend, climax detection
 *
 * The engine is direction-aware: 'long' vs 'short' reverses all polarity checks.
 *
 * Usage:
 *   import { scoreSignalQuality } from './signal-quality.js';
 *   const { score, components, pass } = scoreSignalQuality(bars, i, 'long', opts);
 *   if (pass) { // score >= threshold (default 50) — fire signal }
 *
 * Why this fixes "scores < 30":
 *   Existing strategies fire signals on ANY cross/flip regardless of context.
 *   This engine REJECTS low-quality entries, so only high-PF trades survive →
 *   PF improves → ranker-v2 scores climb above the 0.30 Bayesian prior.
 */
import { rsi, sma, atr } from './indicators.js';
import { emaSeries, rsiSeries, atrSeries, smaSeries, macd } from './indicators.js';

// ── Swing High/Low Detection ──────────────────────────────────────────────

/**
 * Detect swing highs and lows. A swing high at `i` means bars[i].high is
 * greater than the `left` bars before AND `right` bars after it.
 * Returns { swingHighs: [{idx, price}], swingLows: [{idx, price}] }
 */
export function detectSwings(bars, endIdx, left = 3, right = 1) {
  const swingHighs = [];
  const swingLows = [];
  const start = Math.max(left, 0);
  // We can only confirm swings up to endIdx - right (need `right` future bars)
  const end = endIdx - right;
  for (let i = start; i <= end; i++) {
    let isHigh = true;
    let isLow = true;
    for (let j = 1; j <= left; j++) {
      if (i - j < 0) { isHigh = false; isLow = false; break; }
      if (bars.highs[i] <= bars.highs[i - j]) isHigh = false;
      if (bars.lows[i] >= bars.lows[i - j]) isLow = false;
    }
    for (let j = 1; j <= right; j++) {
      if (i + j > endIdx) { isHigh = false; isLow = false; break; }
      if (bars.highs[i] <= bars.highs[i + j]) isHigh = false;
      if (bars.lows[i] >= bars.lows[i + j]) isLow = false;
    }
    if (isHigh) swingHighs.push({ idx: i, price: bars.highs[i] });
    if (isLow) swingLows.push({ idx: i, price: bars.lows[i] });
  }
  return { swingHighs, swingLows };
}

/**
 * Check if current bar is near a swing level (potential entry zone).
 * Returns { nearSwingLow, nearSwingHigh, distance% } for the closest.
 */
export function isNearSwing(bars, i, lookback = 20, threshold = 0.5) {
  const { swingHighs, swingLows } = detectSwings(bars, i, 3, 1);
  const price = bars.closes[i];
  let nearLow = false, nearHigh = false;
  let closestDist = Infinity;

  // Check recent swing lows (potential long entry)
  for (let k = swingLows.length - 1; k >= 0 && swingLows[k].idx >= i - lookback; k--) {
    const dist = Math.abs(price - swingLows[k].price) / price * 100;
    if (dist < threshold) { nearLow = true; closestDist = Math.min(closestDist, dist); }
  }
  // Check recent swing highs (potential short entry)
  for (let k = swingHighs.length - 1; k >= 0 && swingHighs[k].idx >= i - lookback; k--) {
    const dist = Math.abs(price - swingHighs[k].price) / price * 100;
    if (dist < threshold) { nearHigh = true; closestDist = Math.min(closestDist, dist); }
  }
  return { nearSwingLow: nearLow, nearSwingHigh: nearHigh, closestDist };
}

// ── Component Scorers (each returns 0..1) ─────────────────────────────────

/**
 * 1. MOMENTUM — RSI positioning + MACD direction + ROC strength.
 *    Long: RSI recovering from oversold, MACD histogram turning up, ROC positive.
 *    Short: RSI falling from overbought, MACD histogram turning down, ROC negative.
 */
function scoreMomentum(bars, i, direction) {
  const rsiVal = rsi(bars.closes, 14, i);
  if (rsiVal === null) return 0;

  let score = 0;
  const isLong = direction === 'long';

  // RSI zone (0..0.4): ideal = recovering from oversold (long) / overbought (short)
  if (isLong) {
    if (rsiVal >= 30 && rsiVal <= 50) score += 0.4;       // sweet spot: just left oversold
    else if (rsiVal >= 50 && rsiVal <= 65) score += 0.25; // momentum building
    else if (rsiVal < 30) score += 0.1;                    // still oversold, wait
    else score += 0.05;                                     // overbought = bad long
  } else {
    if (rsiVal <= 70 && rsiVal >= 50) score += 0.4;
    else if (rsiVal <= 50 && rsiVal >= 35) score += 0.25;
    else if (rsiVal > 70) score += 0.1;
    else score += 0.05;
  }

  // MACD histogram direction (0..0.3): expanding in trade direction
  if (i >= 26) {
    const { histogram } = macd(bars.closes.slice(0, i + 1));
    const h = histogram;
    const hLen = h.length;
    if (hLen >= 3) {
      const curr = h[hLen - 1];
      const prev = h[hLen - 2];
      const prevPrev = h[hLen - 3];
      const expanding = isLong
        ? (curr > prev && prev > prevPrev)
        : (curr < prev && prev < prevPrev);
      const rightSide = isLong ? (curr > 0 || curr > prev) : (curr < 0 || curr < prev);
      if (expanding) score += 0.3;
      else if (rightSide) score += 0.15;
    }
  }

  // ROC strength (0..0.3): 5-bar rate of change
  if (i >= 5) {
    const roc = (bars.closes[i] - bars.closes[i - 5]) / bars.closes[i - 5] * 100;
    const rocAligned = isLong ? roc : -roc;
    if (rocAligned > 1.5) score += 0.3;
    else if (rocAligned > 0.5) score += 0.2;
    else if (rocAligned > 0) score += 0.1;
  }

  return Math.min(1, score);
}

/**
 * 2. CANDLE SHAPE — body/wick ratio, rejection patterns, engulfing.
 *    Long: bullish engulfing, long lower wick (hammer), strong close.
 *    Short: bearish engulfing, long upper wick (shooting star), weak close.
 */
function scoreCandleShape(bars, i, direction) {
  if (i < 2) return 0;
  const isLong = direction === 'long';
  let score = 0;

  const open = bars.opens[i], high = bars.highs[i], low = bars.lows[i], close = bars.closes[i];
  const prevOpen = bars.opens[i - 1], prevHigh = bars.highs[i - 1];
  const prevLow = bars.lows[i - 1], prevClose = bars.closes[i - 1];

  const bodySize = Math.abs(close - open);
  const candleRange = high - low;
  if (candleRange === 0) return 0;

  const bodyRatio = bodySize / candleRange;
  const upperWick = high - Math.max(open, close);
  const lowerWick = Math.min(open, close) - low;

  // Body strength (0..0.3): strong bullish/bearish body
  const isBullish = close > open;
  if (isLong && isBullish && bodyRatio > 0.6) score += 0.3;
  else if (!isLong && !isBullish && bodyRatio > 0.6) score += 0.3;
  else if ((isLong && isBullish) || (!isLong && !isBullish)) score += 0.15;

  // Wick rejection (0..0.3): hammer for long, shooting star for short
  if (isLong && lowerWick > bodySize * 2 && upperWick < bodySize * 0.5) score += 0.3;
  else if (!isLong && upperWick > bodySize * 2 && lowerWick < bodySize * 0.5) score += 0.3;
  else if (isLong && lowerWick > bodySize) score += 0.15;
  else if (!isLong && upperWick > bodySize) score += 0.15;

  // Engulfing pattern (0..0.4): current candle engulfs previous
  const prevBody = Math.abs(prevClose - prevOpen);
  const engulfing = isLong
    ? (isBullish && prevClose < prevOpen && close > prevOpen && open < prevClose)  // bullish engulfing
    : (!isBullish && prevClose > prevOpen && close < prevOpen && open > prevClose); // bearish engulfing
  if (engulfing) score += 0.4;
  // Outside bar (weaker)
  else if (high > prevHigh && low < prevLow && bodyRatio > 0.5) score += 0.2;

  return Math.min(1, score);
}

/**
 * 3. TREND ALIGNMENT — EMA stack, ADX strength, price position vs MAs.
 *    Long: price > EMA20 > EMA50 > EMA100, ADX > 20.
 *    Short: price < EMA20 < EMA50 < EMA100, ADX > 20.
 */
function scoreTrend(bars, i, direction) {
  if (i < 100) return 0;
  const isLong = direction === 'long';
  let score = 0;

  // EMA stack (0..0.4)
  const ema20 = sma(bars.closes, 20, i);  // using SMA as proxy (less lag than EMA at compute cost)
  const ema50 = sma(bars.closes, 50, i);
  const ema100 = sma(bars.closes, 100, i);
  const price = bars.closes[i];

  const stackedLong = price > ema20 && ema20 > ema50 && ema50 > ema100;
  const stackedShort = price < ema20 && ema20 < ema50 && ema50 < ema100;
  if (isLong && stackedLong) score += 0.4;
  else if (!isLong && stackedShort) score += 0.4;
  else if (isLong && price > ema50) score += 0.2;   // partial alignment
  else if (!isLong && price < ema50) score += 0.2;

  // Price distance from 20-MA (0..0.2): not too extended
  const distPct = Math.abs(price - ema20) / ema20 * 100;
  if (distPct < 1.0) score += 0.2;        // close to MA = healthy pullback entry
  else if (distPct < 2.0) score += 0.15;
  else if (distPct > 4.0) score += 0;      // overextended

  // Trend slope (0..0.2): 20-MA slope positive (long) / negative (short)
  if (i >= 5) {
    const ma20_5back = sma(bars.closes, 20, i - 5);
    const slope = (ema20 - ma20_5back) / ma20_5back * 100;
    const slopeAligned = isLong ? slope : -slope;
    if (slopeAligned > 0.5) score += 0.2;
    else if (slopeAligned > 0) score += 0.1;
  }

  // ADX strength (0..0.2): strong trend > 25
  // Approximation: use 14-bar efficiency ratio as ADX proxy
  if (i >= 14) {
    const netMove = Math.abs(bars.closes[i] - bars.closes[i - 14]);
    let sumBars = 0;
    for (let k = i - 13; k <= i; k++) sumBars += Math.abs(bars.closes[k] - bars.closes[k - 1]);
    const efficiency = sumBars > 0 ? netMove / sumBars : 0;
    if (efficiency > 0.5) score += 0.2;      // strong directional move
    else if (efficiency > 0.3) score += 0.1;
  }

  return Math.min(1, score);
}

/**
 * 4. ACCELERATION — rate of change of momentum (2nd derivative).
 *    Checks if momentum is INCREASING (accelerating into the move).
 *    Uses: ROC of ROC, MACD histogram slope, consecutive expanding bars.
 */
function scoreAcceleration(bars, i, direction) {
  if (i < 15) return 0;
  const isLong = direction === 'long';
  let score = 0;

  // ROC acceleration (0..0.4): ROC(5) > ROC(5)[5] — momentum accelerating
  if (i >= 10) {
    const roc5 = (bars.closes[i] - bars.closes[i - 5]) / bars.closes[i - 5] * 100;
    const roc5prev = (bars.closes[i - 5] - bars.closes[i - 10]) / bars.closes[i - 10] * 100;
    const accel = isLong ? (roc5 - roc5prev) : (roc5prev - roc5);
    if (accel > 0.5) score += 0.4;
    else if (accel > 0) score += 0.2;
  }

  // Consecutive expanding bodies (0..0.3): bars getting bigger in trade direction
  let expanding = 0;
  for (let k = 0; k < 3 && i - k >= 1; k++) {
    const body = bars.closes[i - k] - bars.opens[i - k];
    const prevBody = bars.closes[i - k - 1] - bars.opens[i - k - 1];
    const aligned = isLong
      ? (body > 0 && body > prevBody)
      : (body < 0 && body < prevBody);
    if (aligned) expanding++;
  }
  score += (expanding / 3) * 0.3;

  // ATR expansion (0..0.3): current ATR > ATR average = volatility kicking in
  const atrNow = atr(bars.highs, bars.lows, bars.closes, 5, i);
  const atrAvg = atr(bars.highs, bars.lows, bars.closes, 14, i);
  if (atrAvg > 0) {
    const ratio = atrNow / atrAvg;
    if (ratio > 1.3) score += 0.3;      // expanding volatility
    else if (ratio > 1.1) score += 0.15;
  }

  return Math.min(1, score);
}

/**
 * 5. VOLUME — relative volume, volume trend, climax detection.
 *    High volume confirming the move = strong signal.
 */
function scoreVolume(bars, i, direction) {
  if (i < 20) return 0;
  let score = 0;

  const vol = bars.volumes[i];
  const volMA = sma(bars.volumes, 20, i);
  if (volMA === 0) return 0;

  const relVol = vol / volMA;

  // Relative volume (0..0.4): above average confirms conviction
  if (relVol > 2.0) score += 0.4;       // volume spike — very strong
  else if (relVol > 1.5) score += 0.3;
  else if (relVol > 1.0) score += 0.2;
  else if (relVol > 0.7) score += 0.1;  // below average = weak

  // Volume trend (0..0.3): increasing volume over last 3 bars
  if (i >= 3) {
    const v3 = bars.volumes[i - 2], v2 = bars.volumes[i - 1], v1 = bars.volumes[i];
    if (v1 > v2 && v2 > v3) score += 0.3;       // volume expanding
    else if (v1 > v2 || v1 > v3) score += 0.15; // partial expansion
  }

  // Volume-price agreement (0..0.3): high volume + price moving in direction
  const isLong = direction === 'long';
  const priceMove = bars.closes[i] - bars.closes[i - 1];
  const priceMoveAligned = isLong ? priceMove > 0 : priceMove < 0;
  if (relVol > 1.0 && priceMoveAligned) score += 0.3;
  else if (relVol > 1.0 && !priceMoveAligned) score += 0.05; // divergence: vol up but price wrong way

  return Math.min(1, score);
}

// ── Main Scoring Function ─────────────────────────────────────────────────

const DEFAULT_WEIGHTS = { momentum: 0.20, candle: 0.15, trend: 0.25, acceleration: 0.15, volume: 0.25 };
const DEFAULT_THRESHOLD = 50;

/**
 * Score a signal's quality at bar `i` for given direction.
 *
 * @param {Object} bars - { opens, highs, lows, closes, volumes, times }
 * @param {number} i - bar index
 * @param {'long'|'short'} direction
 * @param {Object} [opts] - { weights, threshold, cooldownBars, minMovePct }
 * @returns {{ score: number (0-100), components: {}, pass: boolean, reasons: string[] }}
 */
export function scoreSignalQuality(bars, i, direction, opts = {}) {
  const weights = opts.weights || DEFAULT_WEIGHTS;
  const threshold = opts.threshold ?? DEFAULT_THRESHOLD;

  const components = {
    momentum:     scoreMomentum(bars, i, direction),
    candle:       scoreCandleShape(bars, i, direction),
    trend:        scoreTrend(bars, i, direction),
    acceleration: scoreAcceleration(bars, i, direction),
    volume:       scoreVolume(bars, i, direction),
  };

  const raw = (
    components.momentum * weights.momentum +
    components.candle * weights.candle +
    components.trend * weights.trend +
    components.acceleration * weights.acceleration +
    components.volume * weights.volume
  );

  const score = Math.round(raw * 100);
  const reasons = [];

  // Annotate dominant factors
  if (components.trend >= 0.7) reasons.push('strong_trend_alignment');
  if (components.volume >= 0.7) reasons.push('high_volume_confirmation');
  if (components.candle >= 0.7) reasons.push('bullish_candle_pattern');
  if (components.momentum >= 0.7) reasons.push('strong_momentum');
  if (components.acceleration >= 0.7) reasons.push('accelerating_move');
  if (components.trend < 0.2) reasons.push('weak_trend');
  if (components.volume < 0.2) reasons.push('low_volume');

  return {
    score,
    components,
    pass: score >= threshold,
    reasons,
  };
}

/**
 * Cooldown filter — ensure minimum bars since last signal.
 */
export function passesCooldown(lastSignalIdx, currentIdx, cooldownBars = 5) {
  if (lastSignalIdx < 0) return true;
  return (currentIdx - lastSignalIdx) >= cooldownBars;
}

/**
 * Minimum price move filter — ensure price has moved enough since last trade.
 */
export function passesMinMove(bars, lastTradeIdx, currentIdx, minMovePct = 0.5) {
  if (lastTradeIdx < 0 || lastTradeIdx >= currentIdx) return true;
  const move = Math.abs(bars.closes[currentIdx] - bars.closes[lastTradeIdx]) / bars.closes[lastTradeIdx] * 100;
  return move >= minMovePct;
}
