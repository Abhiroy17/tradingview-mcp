# Strategies Reference

Per-strategy documentation for the post-Phase-H roster. Generated from `src/engine/registry.js` and Phase H validation runs.

> **Production-deployment caveat**: All `tunedParams` in the registry are *universal reference defaults* derived from cross-basket sweeps (10 stocks × 3 cap tiers, 7 sectors). Deploy with the locked params; per-symbol recalibration is optional but not required for the production strategies.

---

## Production Tier (2)

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

**Key insight**: Exceptional on mid/small-cap (higher beta, cleaner trends). Large-cap weaker but still net profitable. Deploy as portfolio rotation across multiple names — low WR (20-32%), fat right-tail winners.

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

### `rsi2_india_swing` *(demoted in Phase H)*

Connors-style RSI(2) mean-reversion tuned for Indian large-caps.

- **Phase H finding**: 4y cross-basket sweep across all cap tiers — large_cap 1/10 (-130%), mid_cap 3/10 (-105%), small_cap 2/10 (-155%). No universal edge at any param combo.
- **Status**: Per-symbol calibration may work (RELIANCE PF 1.77) but not deployable as a basket strategy.

### `fibonacci_india_swing` *(demoted in Phase H)*

Fibonacci retracement entries (0.382/0.5/0.618) with IBS pre-confirmation.

- **Phase H finding**: Large-cap 4y sweep — best combo 6/10 profitable but net -86.4%. Per-symbol works (RELIANCE PF 3.44) but basket deployment loses.
- **Status**: Needs redesign for basket edge.

### `ibs_india_swing` *(demoted in Phase G, redesigned Phase H)*

Internal Bar Strength swing with regime gate.

- **Phase H finding**: With very strict entry (ibsEntry=0.1) + regime gate → +2.2% (5/10 profitable, 61 trades over 4y on 10 symbols). Marginal edge, insufficient trade count for statistical confidence.
- **Status**: Regime gate required. Too few trades for production confidence.

### `ibs_india_intraday` *(demoted in Phase G)*

Strict IBS < 0.25 + session VWAP intraday mean reversion.

- **Phase G finding**: WR 13-16%, PF 0.12-0.18. Same fundamental issue as `ibs_india_swing`.

### `movingaverage_intraday`

SMA crossover with volume filter. Phase 1 risk-managed template.

- **Phase H finding**: Large-cap 15m — 5/10 profitable at best (-20.5%). Near breakeven with tp=1.5, sl=1.0 but not profitable universally.

### `dual_movingaverage_intraday`

SMA + angle filter. Phase 1 risk-managed template.

- **Phase H finding**: Large-cap 15m — 4/10 profitable at best (-33.3%). Failed.

### `supertrend_intraday`

ATR Supertrend flip entries.

- **Phase H finding**: Large-cap 15m — 7/10 profitable at best (-0.1% i.e. breakeven). Close but not net profitable. `multiplier=4, tp=2.5, sl=1.5` shows +0.6% on 79 trades (5/10).

### `overnight_swing`

Strong-close continuation: enter at close, exit at next open.

- Status: Untested at scale. Calendar logic in place.

### `monday_reversal`

Calendar reversal: Monday gap-up → short, Monday gap-down → long.

- Status: Pine canonical exists, JS port pending.

### `ibs_mean_reversion`

Research baseline for IBS.

- Status: Pine only, no JS implementation.

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
