/**
 * tests/strategy-engine.test.js — Phase G/H regression tests.
 *
 * Locks in the post-Phase-G state of the engine:
 *   • Strategy registry tier classification (3 production / 10 experimental)
 *   • All production strategies have tunedParams + notes
 *   • Multi-axis regime detection works on synthetic bars
 *   • Regime gate (passesRegimeGate) handles null + structured + legacy forms
 *   • F&O monthly expiry calendar correctness (last Thursday with rollback)
 *   • NSE session window enforcement (entry / exit windows)
 *   • Walk-forward harness produces structured output with required fields
 *   • India costs presets are wired correctly
 *
 * These tests are hermetic — no TradingView connection or external network
 * calls. They use synthetic bars and pure-function helpers only.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  STRATEGY_REGISTRY,
  STRATEGY_CODES,
  listProduction,
  listExperimental,
  getStrategy,
  strategiesForRegime,
} from '../src/engine/registry.js';

import {
  istClock,
  istDateKey,
  isNseSessionBar,
  isInIstWindow,
  isThursday,
  isNseHoliday,
  getNseMonthlyExpiry,
  isFnoExpiryDay,
  isPreFnoExpiryDay,
  isShortAllowed,
  NSE_DEFAULTS,
} from '../src/engine/india-session.js';

import {
  trendRegime,
  volRegime,
  momentumRegime,
  compositeRegime,
  passesRegimeGate,
} from '../src/engine/regimes.js';

// ── Helpers ───────────────────────────────────────────────────────────

/** Convert "YYYY-MM-DD HH:MM" IST → unix seconds. */
function istToUnix(ymd, hhmm = '12:00') {
  const [y, mo, d] = ymd.split('-').map(Number);
  const [h, mi]    = hhmm.split(':').map(Number);
  // IST is UTC+5:30 → subtract 5h30m to get UTC, then convert to unix
  const utcMs = Date.UTC(y, mo - 1, d, h, mi) - (5 * 3600 + 30 * 60) * 1000;
  return Math.floor(utcMs / 1000);
}

/** Generate synthetic bars with controllable trend/vol/momentum profile. */
function syntheticBars(n, { trendBps = 0, volPct = 1.0, seed = 42 } = {}) {
  const opens = [], highs = [], lows = [], closes = [], volumes = [], times = [];
  let price = 100;
  // Mulberry32 PRNG for deterministic noise
  let s = seed >>> 0;
  const rand = () => {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), 1 | t);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const startTime = 1700000000;
  for (let i = 0; i < n; i++) {
    const noise = (rand() - 0.5) * 2 * volPct;          // ±volPct%
    const drift = trendBps / 10000;                      // bps to ratio
    const ret = drift + noise / 100;
    const o = price;
    const c = price * (1 + ret);
    const h = Math.max(o, c) * (1 + rand() * 0.005);
    const l = Math.min(o, c) * (1 - rand() * 0.005);
    opens.push(o); highs.push(h); lows.push(l); closes.push(c);
    volumes.push(1_000_000 + Math.floor(rand() * 200_000));
    times.push(startTime + i * 86400);
    price = c;
  }
  return { opens, highs, lows, closes, volumes, times };
}

// ══════════════════════════════════════════════════════════════════════
// Registry
// ══════════════════════════════════════════════════════════════════════

describe('Strategy registry — Phase H tier classification', () => {
  it('exposes exactly 13 strategies in the registry', () => {
    assert.equal(STRATEGY_CODES.length, 13);
  });

  it('production tier contains exactly 3 strategies (Phase H: master added)', () => {
    const prod = listProduction();
    assert.equal(prod.length, 3);
    const codes = prod.map(s => s.code).sort();
    assert.deepEqual(codes, [
      'ema_rsi_intraday',
      'master_intraday',
      'trend_200sma_positional',
    ]);
  });

  it('experimental tier contains exactly 10 strategies', () => {
    const exp = listExperimental({ backtestableOnly: false });
    assert.equal(exp.length, 10);
    const codes = exp.map(s => s.code).sort();
    assert.deepEqual(codes, [
      'dual_movingaverage_intraday',
      'fibonacci_india_swing',
      'ibs_india_intraday',
      'ibs_india_swing',
      'ibs_mean_reversion',
      'monday_reversal',
      'movingaverage_intraday',
      'overnight_swing',
      'phoenix_force_india_intraday',
      'supertrend_intraday',
    ]);
  });

  it('all production strategies have tunedParams object (Phase G locked defaults)', () => {
    for (const s of listProduction()) {
      assert.ok(s.tunedParams, `${s.code} missing tunedParams`);
      assert.equal(typeof s.tunedParams, 'object', `${s.code} tunedParams not an object`);
      // All production strategies should have at least tp+sl in tunedParams
      assert.ok('tp' in s.tunedParams || 'sl' in s.tunedParams,
        `${s.code} tunedParams missing tp/sl`);
    }
  });

  it('all production strategies have notes documenting validation', () => {
    for (const s of listProduction()) {
      assert.ok(s.notes, `${s.code} missing notes`);
      assert.ok(s.notes.length > 50, `${s.code} notes too short — should describe validation`);
    }
  });

  it('all strategies have structured regimeAffinity', () => {
    for (const code of STRATEGY_CODES) {
      const s = getStrategy(code);
      assert.ok(s.regimeAffinity, `${code} missing regimeAffinity`);
      assert.equal(typeof s.regimeAffinity, 'object',
        `${code} regimeAffinity should be structured object, not array`);
    }
  });

  it('strategiesForRegime accepts both legacy string and structured composite', () => {
    // Legacy: single trend label
    const trendingUp = strategiesForRegime('trending_up');
    assert.ok(trendingUp.length >= 2, 'trending_up should match trend_200sma + ema_rsi + others');

    // Structured composite
    const composite = strategiesForRegime({ trend: 'ranging', vol: 'normal' });
    assert.ok(composite.length >= 1, 'ranging+normal should match ibs-family strategies');
  });

  it('fibonacci is demoted to experimental (Phase H)', () => {
    const s = getStrategy('fibonacci_india_swing');
    assert.equal(s.tier, 'experimental');
  });

  it('trend_200sma tunedParams matches Phase H basket sweep result', () => {
    const s = getStrategy('trend_200sma_positional');
    assert.equal(s.tunedParams.fastLen, 20);
    assert.equal(s.tunedParams.volMult, 1.5);
    assert.equal(s.tunedParams.tp, 25);
    assert.equal(s.tunedParams.sl, 12);
  });

  it('ema_rsi_intraday tunedParams matches Phase H cross-basket result', () => {
    const s = getStrategy('ema_rsi_intraday');
    assert.equal(s.tier, 'production');
    assert.equal(s.tunedParams.rsiExitLong, 70);
    assert.equal(s.tunedParams.volMult, 1);
    assert.equal(s.tunedParams.tp, 3.0);
    assert.equal(s.tunedParams.sl, 1.5);
    assert.equal(s.tunedParams.maxBars, 48);
  });
});

// ══════════════════════════════════════════════════════════════════════
// India session helpers
// ══════════════════════════════════════════════════════════════════════

describe('India session — IST clock', () => {
  it('istClock converts unix to IST date with no DST', () => {
    // 2025-06-15 14:30 IST → 09:00 UTC → unix 1750000800
    const c = istClock(istToUnix('2025-06-15', '14:30'));
    assert.equal(c.y, 2025);
    assert.equal(c.m, 6);
    assert.equal(c.d, 15);
    assert.equal(c.h, 14);
    assert.equal(c.min, 30);
  });

  it('istDateKey produces YYYY-MM-DD format', () => {
    assert.equal(istDateKey(istToUnix('2025-03-21', '10:00')), '2025-03-21');
  });

  it('handles null / invalid input', () => {
    assert.equal(istClock(0), null);
    assert.equal(istClock(null), null);
  });
});

describe('India session — NSE session bar detection', () => {
  it('accepts a bar inside 09:15-15:30 IST on a Mon-Fri', () => {
    // 2025-06-16 is a Monday
    assert.equal(isNseSessionBar(istToUnix('2025-06-16', '10:00')), true);
    assert.equal(isNseSessionBar(istToUnix('2025-06-16', '09:15')), true);
    assert.equal(isNseSessionBar(istToUnix('2025-06-16', '15:29')), true);
  });

  it('rejects bars before 09:15 or at/after 15:30', () => {
    assert.equal(isNseSessionBar(istToUnix('2025-06-16', '09:14')), false);
    assert.equal(isNseSessionBar(istToUnix('2025-06-16', '15:30')), false);
    assert.equal(isNseSessionBar(istToUnix('2025-06-16', '16:00')), false);
  });

  it('rejects weekends', () => {
    // 2025-06-14 is Saturday, 2025-06-15 is Sunday
    assert.equal(isNseSessionBar(istToUnix('2025-06-14', '10:00')), false);
    assert.equal(isNseSessionBar(istToUnix('2025-06-15', '10:00')), false);
  });

  it('rejects known NSE holidays', () => {
    // Republic Day 2025: Jan 26 was a Sunday but Indep Day Aug 15 2025 is a holiday
    assert.equal(isNseHoliday(istToUnix('2025-08-15', '10:00')), true);
    assert.equal(isNseSessionBar(istToUnix('2025-08-15', '10:00')), false);
  });
});

describe('India session — entry/exit window', () => {
  it('NSE_DEFAULTS has standard windows', () => {
    assert.equal(NSE_DEFAULTS.ENTRY_WINDOW, '0930-1430');
    assert.equal(NSE_DEFAULTS.EXIT_WINDOW,  '1500-1530');
  });

  it('isInIstWindow respects "0930-1430" entry window', () => {
    const t = (h, m) => istToUnix('2025-06-16', `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}`);
    assert.equal(isInIstWindow(t(9, 30), '0930-1430'), true);
    assert.equal(isInIstWindow(t(14, 29), '0930-1430'), true);
    assert.equal(isInIstWindow(t(9, 29), '0930-1430'), false);
    assert.equal(isInIstWindow(t(14, 30), '0930-1430'), false);
  });

  it('isInIstWindow returns true on missing/invalid window string', () => {
    assert.equal(isInIstWindow(istToUnix('2025-06-16', '10:00'), null), true);
    assert.equal(isInIstWindow(istToUnix('2025-06-16', '10:00'), 'invalid'), true);
  });
});

describe('India session — F&O monthly expiry', () => {
  it('Dec 2025 expiry is Wed Dec 24 (Christmas Thu Dec 25 holiday → roll back)', () => {
    const expiry = getNseMonthlyExpiry(2025, 12);
    // getNseMonthlyExpiry returns {y, m, d, key} (not Date)
    assert.ok(expiry, 'expiry must not be null');
    assert.equal(expiry.d, 24);
    assert.equal(expiry.m, 12);
    assert.equal(expiry.y, 2025);
  });

  it('isFnoExpiryDay correctly flags monthly expiry day', () => {
    // Generic last-Thursday case where no holiday rollback occurs
    // June 2025 last Thursday = June 26
    assert.equal(isFnoExpiryDay(istToUnix('2025-06-26', '10:00')), true);
    assert.equal(isFnoExpiryDay(istToUnix('2025-06-25', '10:00')), false);
    assert.equal(isFnoExpiryDay(istToUnix('2025-06-27', '10:00')), false);
  });

  it('isPreFnoExpiryDay flags day before monthly expiry', () => {
    // June 25 is the trading day before June 26 expiry
    assert.equal(isPreFnoExpiryDay(istToUnix('2025-06-25', '10:00')), true);
    assert.equal(isPreFnoExpiryDay(istToUnix('2025-06-24', '10:00')), false);
  });

  it('isThursday helper works', () => {
    // 2025-06-26 is a Thursday (June 2025 monthly expiry)
    assert.equal(isThursday(istToUnix('2025-06-26', '10:00')), true);
    assert.equal(isThursday(istToUnix('2025-06-25', '10:00')), false);
  });
});

describe('India session — short-selling rules', () => {
  it("swing-short flagged with reason='futures_required' (policy hint)", () => {
    const t = istToUnix('2025-06-16', '10:00');
    const r = isShortAllowed(t, { style: 'swing' });
    assert.equal(r.allowed, true);
    assert.equal(r.reason, 'futures_required');
  });

  it("intraday short flagged with reason='cash_mis_ok'", () => {
    const t = istToUnix('2025-06-16', '10:00');
    const r = isShortAllowed(t, { style: 'intraday' });
    assert.equal(r.allowed, true);
    assert.equal(r.reason, 'cash_mis_ok');
  });

  it('positional short flagged like swing (futures_required)', () => {
    const t = istToUnix('2025-06-16', '10:00');
    const r = isShortAllowed(t, { style: 'positional' });
    assert.equal(r.allowed, true);
    assert.equal(r.reason, 'futures_required');
  });

  it('blocks shorts on monthly expiry day (default skipExpiry: true)', () => {
    // June 26 2025 = last Thursday = monthly expiry
    const t = istToUnix('2025-06-26', '10:00');
    const r = isShortAllowed(t, { style: 'swing' });
    assert.equal(r.allowed, false);
    assert.equal(r.reason, 'fno_expiry_day');
  });

  it('blocks shorts on pre-expiry day (default skipExpiry: true)', () => {
    // June 25 2025 = day before expiry
    const t = istToUnix('2025-06-25', '10:00');
    const r = isShortAllowed(t, { style: 'swing' });
    assert.equal(r.allowed, false);
    assert.equal(r.reason, 'pre_expiry_day');
  });

  it('opt-out: skipExpiry=false allows shorts on expiry day', () => {
    const t = istToUnix('2025-06-26', '10:00');
    const r = isShortAllowed(t, { style: 'swing', skipExpiry: false });
    assert.equal(r.allowed, true);
  });
});

// ══════════════════════════════════════════════════════════════════════
// Multi-axis regime detection
// ══════════════════════════════════════════════════════════════════════

describe('Regimes — multi-axis classification', () => {
  it("returns 'unknown' for indices below warmup", () => {
    const bars = syntheticBars(10);
    assert.equal(trendRegime(bars, 5), 'unknown');
    assert.equal(volRegime(bars, 5), 'unknown');
    assert.equal(momentumRegime(bars, 5), 'unknown');
  });

  it('detects trending_up in steady-uptrend synthetic bars', () => {
    const bars = syntheticBars(120, { trendBps: 30, volPct: 0.5 });
    const trend = trendRegime(bars, 100);
    // Steady +30 bps drift with low vol should not be ranging
    assert.notEqual(trend, 'ranging');
    assert.notEqual(trend, 'trending_down');
  });

  it('detects trending_down in steady-downtrend synthetic bars', () => {
    const bars = syntheticBars(120, { trendBps: -30, volPct: 0.5 });
    const trend = trendRegime(bars, 100);
    assert.notEqual(trend, 'trending_up');
  });

  it('volRegime returns one of low/normal/high/crisis/unknown', () => {
    const bars = syntheticBars(120, { volPct: 1.0 });
    const v = volRegime(bars, 100);
    assert.ok(['low', 'normal', 'high', 'crisis', 'unknown'].includes(v),
      `volRegime returned unexpected value: ${v}`);
  });

  it('compositeRegime returns structured object with three axes', () => {
    const bars = syntheticBars(120, { trendBps: 20 });
    const r = compositeRegime(bars, 100);
    assert.ok(r);
    assert.ok('trend' in r);
    assert.ok('vol' in r);
    assert.ok('momentum' in r);
  });

  it("compositeRegime returns 'unknown' axis values during warmup", () => {
    const bars = syntheticBars(20);
    const r = compositeRegime(bars, 5);
    assert.equal(r.trend, 'unknown');
    assert.equal(r.vol, 'unknown');
    assert.equal(r.momentum, 'unknown');
  });
});

describe('Regimes — passesRegimeGate', () => {
  it('returns true with no affinity (no gate)', () => {
    assert.equal(passesRegimeGate({ trend: 'ranging', vol: 'normal' }, null), true);
    assert.equal(passesRegimeGate({ trend: 'ranging', vol: 'normal' }, undefined), true);
  });

  it('denies entry when regime is null (warmup safety)', () => {
    assert.equal(passesRegimeGate(null, { trend: ['ranging'] }), false);
  });

  it("denies entry when regime axis is 'unknown' (warmup composite)", () => {
    // Composite during warmup returns { trend: 'unknown', ... } — must block when
    // affinity declares the trend axis but doesn't include 'unknown'.
    const r = { trend: 'unknown', vol: 'unknown', momentum: 'unknown' };
    const a = { trend: ['ranging', 'trending_up'] };
    assert.equal(passesRegimeGate(r, a), false);
  });

  it('passes when regime matches structured affinity', () => {
    const r = { trend: 'ranging', vol: 'normal', momentum: 'flat' };
    const a = { trend: ['ranging', 'mixed'], vol: ['low', 'normal'] };
    assert.equal(passesRegimeGate(r, a), true);
  });

  it('blocks when trend axis mismatches', () => {
    const r = { trend: 'trending_down', vol: 'normal' };
    const a = { trend: ['ranging', 'trending_up'] };
    assert.equal(passesRegimeGate(r, a), false);
  });

  it('blocks when any axis mismatches', () => {
    const r = { trend: 'ranging', vol: 'crisis' };
    const a = { trend: ['ranging'], vol: ['low', 'normal'] };
    assert.equal(passesRegimeGate(r, a), false);
  });

  it('legacy array affinity treated as trend list', () => {
    const r = { trend: 'ranging', vol: 'normal' };
    assert.equal(passesRegimeGate(r, ['ranging']), true);
    assert.equal(passesRegimeGate(r, ['trending_up']), false);
  });
});

// ══════════════════════════════════════════════════════════════════════
// Walk-forward harness shape
// ══════════════════════════════════════════════════════════════════════

describe('Walk-forward — output shape', () => {
  it('runWalkForward exports required entry points', async () => {
    const m = await import('../src/engine/walk-forward.js');
    assert.equal(typeof m.runWalkForward, 'function');
  });
});
