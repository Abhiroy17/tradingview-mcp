# Indian Market (NSE/BSE) Reference

Operational reference for backtesting and live deployment on Indian equities. All helpers in [src/engine/india-session.js](src/engine/india-session.js).

---

## Trading Calendar

### Session Hours (NSE & BSE)

| Phase | IST | Notes |
| --- | --- | --- |
| Pre-open | 09:00 – 09:15 | Order matching, no continuous trading |
| **Continuous** | **09:15 – 15:30** | **Main session** — used by all strategies |
| Closing | 15:30 – 16:00 | Block deals only (ignored by engine) |

**Default windows used by intraday strategies** (override per-strategy via `execution`):
```js
ENTRY_WINDOW: '0930-1430'   // skip volatile open + last hour
EXIT_WINDOW:  '1500-1530'   // force-flat by close
SESSION_OPEN: '0915'
SESSION_CLOSE:'1530'
```

### Timezone

IST is fixed UTC+5:30 — India does **not** observe DST. The engine uses a fixed offset (no Intl APIs) for exact, portable conversion.

### Holiday Calendar (2024-2026)

Hard-coded in `NSE_HOLIDAYS_2024_2026` set. ~17 holidays per year (Republic Day, Holi, Good Friday, Independence Day, Diwali variants, Christmas, etc.).

Helper: `isNseHoliday(unixSec)` returns `true` if the IST date is a known holiday.

### F&O Monthly Expiry

NSE monthly index F&O (NIFTY, BANKNIFTY) and stock futures expire on the **last Thursday** of each month. If that Thursday is a holiday, expiry rolls **backwards** to the previous trading day (typically Wednesday).

Helpers (in `india-session.js`):
- `getNseMonthlyExpiry(year, month)` → Date of expiry (1-indexed month)
- `isFnoExpiryDay(unixSec)` → true if the bar is on monthly expiry
- `isPreFnoExpiryDay(unixSec)` → true if the bar is the trading day before expiry

> **Apr 2025+ change**: NSE migrated weekly expiries — Nifty weekly is now Tuesday, Bank Nifty weekly retired. Monthly contracts still expire on last Thursday. We currently model **monthly** only; weekly logic can be added if intraday F&O strategies are deployed.

---

## Costs Presets

Defined in `src/engine/india-costs.js` and selectable via `execution.costsPreset`:

| Preset | Brokerage + cost (bps) | Slippage (bps) | Use case |
| --- | --- | --- | --- |
| `india_delivery` | 18 | 8 | Cash equity held overnight |
| `india_intraday` | 11 | 5 | MIS intraday (square-off by 15:30) |
| `india_futures` | 12 | 6 | F&O futures (long or short) |
| `us_equity` | 5 | 3 | US-market reference (legacy) |

> Costs include STT, exchange tx fees, GST, SEBI fees, and stamp duty. Slippage is base-case for liquid Nifty100 stocks. Use the slippage profile system for symbol-specific tuning.

### Cost-stress profiles

Apply `slippageProfile: 'base' | 'stress' | 'crisis'` in execution to multiply slippage:
- `base` — normal liquid market (1.0×)
- `stress` — high-vol regime (2.0×)
- `crisis` — circuit-breaker / gap-through (4.0×)

---

## Short Selling Rules

`isShortAllowed(unixSec, options)` returns `{ allowed, reason }` and enforces the following:

| Rule | Cash equity | F&O futures |
| --- | --- | --- |
| Swing short (overnight hold) | ❌ Blocked | ✅ Allowed |
| Intraday MIS short | ✅ Allowed | ✅ Allowed |
| Pre-expiry day | ⚠️ Pre-FnO discouraged for intraday | ⚠️ Avoid |
| Expiry day | ❌ Blocked | ❌ Blocked |

**Cash-segment swing shorts are blocked by Indian regulations** (SLB exists but is niche/illiquid for retail). All overnight short positions must be in F&O futures.

The engine enforces this via the `isShortAllowed` helper:
```js
const { allowed, reason } = isShortAllowed(barTime, {
  segment: 'cash',         // or 'futures'
  hold:    'swing',        // or 'intraday'
});
if (!allowed) { /* skip short signal, log reason */ }
```

---

## Walk-Forward Validation

Defined in [src/engine/walk-forward.js](src/engine/walk-forward.js).

```js
import { runWalkForward } from './src/engine/walk-forward.js';

const result = await runWalkForward({
  code: 'rsi2_india_swing',
  symbol: 'NSE:RELIANCE',
  timeframe: '1D',
  bars: barsCache,                   // optional pre-cached
  k: 5,                              // 5-fold (rolling or expanding)
  anchor: 'rolling',                 // or 'expanding'
  execution: { costsPreset: 'india_delivery' },
  params: { rsiOversold: 10, tp: 1.0, sl: 1.0 },
});

console.log(result.aggregateOOS);     // pooled out-of-sample metrics
console.log(result.avgTrainSharpe);   // mean train-fold Sharpe
console.log(result.avgTestSharpe);    // mean test-fold Sharpe
console.log(result.isOosGap);         // train - test (overfit signal)
console.log(result.overfitFlag);      // 'none' | 'mild' | 'moderate' | 'severe'
console.log(result.stabilityFlag);    // 'stable' | 'unstable' (PF CoV > 0.6)
console.log(result.dsr);              // Deflated Sharpe Ratio
```

**Caveat (Phase G finding)**: walk-forward is **not appropriate for trend strategies** with infrequent signals. With `k=5` and 30% test windows, each fold has ~100 daily bars — too few for trend signals to play out. For trend strategies use `scripts/tune-multi.js` cross-symbol basket sweep instead.

---

## Multi-Axis Regime Detection

Defined in [src/engine/regimes.js](src/engine/regimes.js).

```js
import { compositeRegime, passesRegimeGate } from './src/engine/regimes.js';

const regime = compositeRegime(bars, idx);
// → { trend: 'trending_up' | 'trending_down' | 'ranging' | 'mixed',
//     vol:   'low' | 'normal' | 'high' | 'crisis',
//     momentum: 'down_strong' | 'down' | 'flat' | 'up' | 'up_strong' }

const allowed = passesRegimeGate(regime, {
  trend: ['ranging', 'trending_up'],
  vol:   ['low', 'normal'],
});
```

**Trend axis**: ADX(14) + EMA(9) vs EMA(21) cross.
**Volatility axis**: ATR(14)% percentile vs trailing 60 bars.
**Momentum axis**: Z-score of ROC(20).

`passesRegimeGate` denies entry conservatively when regime is `null` (i.e., during warmup).

### Enabling the gate

```js
const result = await runStrategy({
  code: 'rsi2_india_swing',
  symbol: 'NSE:RELIANCE',
  timeframe: '1D',
  lookbackDays: 365,
  execution: { costsPreset: 'india_delivery', gateOnRegime: true },  // <-- opt in
});
console.log(result.regimeBlocked);   // count of entries denied by regime
```

The gate is **off by default** for backwards compatibility. Production deployment of mean-reversion strategies should enable it (Phase G fibonacci basket: -17.7% → -8.0% with gate on).

---

## Strategies Registry — India-Specific Fields

Each entry in `src/engine/registry.js` may include:

```js
{
  // Per-strategy regime affinity (Phase F)
  regimeAffinity: {
    trend: ['ranging', 'trending_up'],
    vol:   ['low', 'normal', 'high'],
  },

  // Phase G basket-validated reference defaults
  tunedParams: { rsiOversold: 10, tp: 1.0, sl: 1.0, ... },

  // Freeform research notes (Phase G findings)
  notes: 'walk-forward tuned on RELIANCE 4y; basket fails — recalibrate per-symbol',
}
```

---

## Operational Tools

```bash
# Single-symbol walk-forward parameter tuning (López de Prado k-fold)
node scripts/tune-strategy.js rsi2_india_swing --symbol NSE:RELIANCE --years 4 --k 5

# Cross-symbol basket sweep (better for production param locking)
node scripts/tune-multi.js rsi2_india_swing --years 4 --top 10

# Smoke-test all production strategies
node scripts/test-modes.js NSE:RELIANCE rsi2_india_swing intraday
```

---

## Known Limitations

1. **No tick-level data** — Upstox v3 and Yahoo provide bar-level OHLCV only. Within-bar slippage is approximated via heuristic path-sim (close-direction-aware).
2. **No SLB (cash-segment short borrow)** — niche/illiquid for retail; engine blocks cash-segment swing shorts.
3. **No options modeling** — F&O is futures-only in v1; options gamma/vega complexity deferred.
4. **Static holiday calendar** — `NSE_HOLIDAYS_2024_2026` is committed; needs annual refresh.
5. **Static F&O lot sizes** — not yet wired in v1; live deployment needs `.data/fno-lotsizes-2026.json`.
6. **Mean-reversion strategies are symbol-specific** — Phase G showed `rsi2` and `fibonacci` only have walk-forward edge on RELIANCE in the tested 7-stock basket. Per-symbol calibration is required for production.
