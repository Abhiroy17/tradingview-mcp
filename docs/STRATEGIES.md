# Strategies Reference

Per-strategy documentation for the post-Phase-I roster. Generated from `src/engine/registry.js` and Phase H/I validation runs.

> **Production-deployment caveat**: All `tunedParams` in the registry are *universal reference defaults* derived from cross-basket sweeps (10 stocks × 3 cap tiers, 7 sectors). Deploy with the locked params; per-symbol recalibration is optional but not required for the production strategies.

---

## Production Tier (3)

### `trend_200sma_positional`

Long-only trend follower with multi-tier exit logic. The most consistently profitable strategy in the roster.

| Field | Value |
| --- | --- |
| Family | `trend_following` |
| Style | `positional` |
| Direction | `long` |
| Timeframes | `1D`, `1W` |
| Pine | [pdf/untested/trend_200sma_positional.pine](pdf/untested/trend_200sma_positional.pine) |
| JS | [src/engine/strategies/trend_200sma_positional.js](src/engine/strategies/trend_200sma_positional.js) |

**Entry**: Price > 200-SMA, fast SMA(20) cross-up, volume > 1.5× SMA(20).
**Exit**: TP +25% / SL -12% / exitSignal on close < 200-SMA (regime break) / maxBars 250.
**Phase I additions** (opt-in OFF, no regression): `useMacdExit` (MACD hist negative 2+ bars) and `useRsiExit` (RSI < 40). Both HURT performance on daily trend strategies — keep OFF.

**Tuned params** (Phase H, cap-tier basket × 4y):
```js
{ trendLen: 200, fastLen: 20, volMult: 1.5, tp: 25, sl: 12, maxBars: 250 }
```

**Cross-basket validation** (india_delivery costs, 4y lookback):

| Basket | Profitable | Total PnL | Avg PnL/sym | Best Sym | Worst Sym |
| --- | --- | --- | --- | --- | --- |
| large_cap | 3/10 | +23.8% | +2.4% | +63.4% | -10.1% |
| mid_cap | **6/10** | **+92.9%** | +9.3% | +40.8% | -16.3% |
| small_cap | **6/10** | **+98.3%** | +9.8% | +41.7% | -16.5% |

**Key insight**: Exceptional on mid/small-cap (higher beta, cleaner trends). Large-cap weaker but still net profitable. Deploy as portfolio rotation across multiple names — low WR (20-32%), fat right-tail winners. MACD/RSI early exits don't help — trend strategies need to ride the full move.

**Regime affinity**: trending_up / mixed.

---

### `ema_rsi_intraday`

Triple-EMA trend stack (10/20/100) with RSI exit gate and volume confirmation. **Newly promoted in Phase H** after cross-basket validation on 15m proved consistent profitability.

| Field | Value |
| --- | --- |
| Family | `trend_following` |
| Style | `intraday` |
| Direction | `both` |
| Timeframes | `15m`, `1h` |
| Pine | [pdf/profitable/ema_rsi_intraday.pine](pdf/profitable/ema_rsi_intraday.pine) |
| JS | [src/engine/strategies/ema_rsi_intraday.js](src/engine/strategies/ema_rsi_intraday.js) |

**Entry (long)**: EMA(10) > EMA(20) > EMA(100) stack alignment + volume > 1× SMA(20).
**Entry (short)**: EMA(10) < EMA(20) < EMA(100) inverse stack + volume confirmation.
**Exit**: RSI(14) > 70 (long exit), RSI < 30 (short exit), OR TP +3% / SL -1.5% / maxBars 48.

**Tuned params** (Phase H, cross-basket 15m × 55d):
```js
{ emaA: 10, emaB: 20, emaC: 100, rsiLen: 14, rsiExitLong: 70, rsiExitShort: 30, volLen: 20, volMult: 1, tp: 3.0, sl: 1.5, maxBars: 48 }
```

**Cross-basket validation** (india_intraday costs, 15m, 55d):

| Basket | Profitable | Total PnL | Avg PnL/sym |
| --- | --- | --- | --- |
| **bank** | **9/10** | **+13.3%** | +1.3% |
| **IT** | **8/10** | **+7.1%** | +0.7% |
| **pharma** | **7/10** | **+8.8%** | +0.9% |
| large_cap | 7/10 | +5.9% | +0.6% |
| mid_cap | 7/10 | +0.2% | +0.0% |
| small_cap | 7/10 | -1.3% | -0.1% |
| fmcg | 6/10 | -0.8% | -0.1% |
| auto | 4/10 | -6.3% | -0.6% |
| metal | 4/10 | -12.4% | -1.2% |
| energy | 6/10 | -6.6% | -0.7% |

**Key insight**: Strongest on high-volume institutional sectors (bank, IT, pharma). These sectors have clean intraday trends driven by institutional order flow. Weak on volatile cyclicals (auto, metal) and low-volume defensive (energy). **Deploy on bank/IT/pharma for best edge.**

**Regime affinity**: trending_up / trending_down / mixed (all non-crisis vol).

---

## Experimental Tier (10)

These are kept available for research and per-symbol calibration but are **hidden by default in production lists** (`listProduction()`).

### `fibonacci_india_swing` *(demoted in Phase H, enriched Phase I)*

Fibonacci retracement entries (0.382/0.5/0.618) with RSI + MACD confirmation (Phase I).

- **Phase H**: Large-cap 4y sweep — -86.4% baseline.
- **Phase I**: Added useMacd + useRsi filters. Best combo: useRsi=true, useMacd=true → +6.0% (6/10 prof). Major improvement from -86% to +6%.
- **Tuned**: `{ lookback: 50, tp: 4, sl: 3, maxBars: 20, useRsi: true, rsiLong: 45, useMacd: true }`

### `ibs_india_swing` *(enriched Phase I)*

IBS < 0.20 entry with MACD histogram-rising confirmation.

- **Phase I**: Added useMacd filter. Best: ibsEntry=0.20, useMacd=true → -4.3% (7/10 prof). From -210% to near breakeven.
- **Tuned**: `{ ibsEntry: 0.20, useMacd: true, useRsi: false, tp: 2.5, sl: 1.5, maxBars: 3 }`

### `ibs_india_intraday` *(enriched Phase I)*

IBS < 0.25 + VWAP + MACD intraday mean reversion.

- **Phase I**: Added useMacd. Best: ibsEntry=0.25, useMacd=true → -5.6% (4/10 prof). From -16.4%.
- **Tuned**: `{ ibsEntry: 0.25, useMacd: true, useRsi: false, rsiMax: 40, tp: 0.7, sl: 0.5, maxBars: 12 }`

### `movingaverage_intraday` *(enriched Phase I)*

SMA crossover + MACD entry confirm + RSI exit override.

- **Phase I**: MACD lifts from -6.1% to -1.7% (5/10 prof, 80 trades, WR 36%). Near breakeven.
- **Tuned**: `{ shortPeriod: 5, longPeriod: 50, volMult: 1.0, tp: 2.5, sl: 1.5, maxBars: 30, useMacd: true, useRsiExit: false }`

### `dual_movingaverage_intraday` *(enriched Phase I)*

SMA angle-gated crossover + MACD confirm.

- **Phase I**: MACD + vol + angleThresh=10 → -17.7% (93 trades, WR 38%, 4/10 prof). Still negative.
- **Tuned**: `{ angleThresh: 10, crossWindow: 10, volMult: 1.0, tp: 1.0, sl: 1.5, maxBars: 30, useMacd: true, useRsiExit: false }`

### `supertrend_intraday` *(enriched Phase I — strong candidate for promotion)*

ATR Supertrend flip + MACD confirm. **Net positive after Phase I.**

- **Phase I**: MACD + multiplier=3 → **+4.2%** (83 trades, WR 40%, 7/10 profitable). Only experimental strategy that is NET POSITIVE.
- **Tuned**: `{ atrPeriod: 14, multiplier: 3, volMult: 1.0, tp: 2.5, sl: 1.5, maxBars: 30, useMacd: true, useRsiEntry: false, useRsiExit: false }`
- **Status**: Strong candidate for promotion to production after multi-sector validation.

### `overnight_swing`

Strong-close continuation: enter at close, exit at next open.

- **Phase I**: Added useRsi/useMacd (opt-in OFF). Filters don't help — strategy is fundamentally weak on Indian equities.
- Best: -9.3% on mid_cap, -55% on large_cap. Not deployable.

### `monday_reversal` *(ported Phase I)*

Calendar reversal: Monday gap-up → short, Monday gap-down → long.

- **Phase I**: Ported from Pine to JS. Best: -8.2% (29 trades, WR 28%, 4/10 prof). Too few trades, seasonal only.
- **Tuned**: `{ rsiThresh: 30, volMult: 1.5, tp: 2.0, sl: 0.8, maxBars: 3, useSma: false, useMacd: false }`

### `ibs_mean_reversion` *(ported Phase I)*

Research baseline: IBS < 0.15 with SMA trend + MACD confirmation.

- **Phase I**: Ported from Pine to JS. SMA+MACD dominate → -9.8%.
- **Tuned**: `{ ibsThresh: 0.15, useSma: true, useMacd: true, useRsi: false, tp: 2.0, sl: 1.0, maxBars: 5 }`

### `phoenix_force_india_intraday` *(ported Phase I)*

4-factor confluence: PSAR + EMA(50) + MACD + RSI, gated by Choppiness Index + volume + ATR floor.

- **Phase I**: Ported from Pine to JS. Large_cap 15m: -8.0% (116 trades, 41% WR, 6/10 prof). Designed for volatile mid-caps — per-stock presets recommended.
- **Tuned**: `{ ciThresh: 42, rsiLongTh: 55, volMult: 1.0, atrFloor: 0.25, tp: 1.5, sl: 0.8, maxBars: 30 }`

---

## How to use `tunedParams`

```js
import { STRATEGY_REGISTRY } from './src/engine/registry.js';
import { runStrategy } from './src/engine/contract.js';

const meta = STRATEGY_REGISTRY['ema_rsi_intraday'];
const result = await runStrategy({
  code: meta.code,
  symbol: 'NSE:HDFCBANK',
  timeframe: '15m',
  lookbackDays: 55,
  params: meta.tunedParams,                  // <-- locked Phase H defaults
  execution: { costsPreset: 'india_intraday' },
});
```

If `tunedParams` is absent, the strategy module's `defaultParams` is used.

---

## Re-tuning Workflow

When markets shift or new data shows degradation:

1. **Single-symbol walk-forward** (good for: parameter discovery, OOS Sharpe verification):
   ```bash
   node scripts/tune-strategy.js rsi2_india_swing --symbol NSE:RELIANCE --years 4 --k 5
   ```
2. **Cross-symbol basket sweep** (good for: production param locking, avoiding single-symbol overfit):
   ```bash
   node scripts/tune-multi.js rsi2_india_swing --years 4 --top 10
   ```
3. **Update both Pine and JS** in the same commit (Pine is canonical):
   - `pdf/{profitable|untested}/<code>.pine` — input defaults
   - `src/engine/strategies/<code>.js` — `defaultParams`
   - `src/engine/registry.js` — `tunedParams` field
4. **Run regression**:
   ```bash
   npm test
   ```
