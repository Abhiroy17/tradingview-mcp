/**
 * Performance matrix data-access layer.
 *
 * All write/read operations go through here so the engine and REST endpoints
 * never touch raw SQL.
 *
 * Conventions:
 *  - Functions throw on DB errors; callers should handle.
 *  - All upserts are idempotent.
 *  - Symbol/strategy lookup tables auto-create rows on first reference.
 */

import crypto from 'node:crypto';
import { query, withTransaction } from './client.js';
import { parseSymbol } from '../data/providers/types.js';

// ─────────────────────────────────────────────────────────────────────
// Lookup-table helpers (auto-create on demand)
// ─────────────────────────────────────────────────────────────────────

/** Find or create a row in `symbols`. Returns the row id. */
export async function upsertSymbol({ canonical, assetClass = null, sector = null }) {
  const { exchange, ticker } = parseSymbol(canonical);
  const res = await query(
    `INSERT INTO symbols (canonical, exchange, ticker, asset_class, sector)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (canonical) DO UPDATE
       SET asset_class = COALESCE(EXCLUDED.asset_class, symbols.asset_class),
           sector      = COALESCE(EXCLUDED.sector,      symbols.sector)
     RETURNING id`,
    [canonical, exchange, ticker, assetClass, sector],
  );
  return res.rows[0].id;
}

/** Find or create a row in `strategies`. Returns the row id. */
export async function upsertStrategy({ code, name, family = null, style = null, backtestable = true, description = null }) {
  const res = await query(
    `INSERT INTO strategies (code, name, family, style, backtestable, description)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (code) DO UPDATE
       SET name         = EXCLUDED.name,
           family       = COALESCE(EXCLUDED.family,       strategies.family),
           style        = COALESCE(EXCLUDED.style,        strategies.style),
           backtestable = EXCLUDED.backtestable,
           description  = COALESCE(EXCLUDED.description,  strategies.description)
     RETURNING id`,
    [code, name, family, style, backtestable, description],
  );
  return res.rows[0].id;
}

async function timeframeId(code) {
  const res = await query(`SELECT id FROM timeframes WHERE code = $1`, [code]);
  if (res.rows[0]) return res.rows[0].id;
  const ins = await query(`INSERT INTO timeframes (code) VALUES ($1) RETURNING id`, [code]);
  return ins.rows[0].id;
}

async function regimeId(code) {
  if (!code) code = 'unknown';
  const res = await query(`SELECT id FROM regimes WHERE code = $1`, [code]);
  if (res.rows[0]) return res.rows[0].id;
  const ins = await query(`INSERT INTO regimes (code) VALUES ($1) RETURNING id`, [code]);
  return ins.rows[0].id;
}

// ─────────────────────────────────────────────────────────────────────
// Backtest result writer
// ─────────────────────────────────────────────────────────────────────

/**
 * Compute a stable hash for params so re-running with identical config
 * upserts the same row rather than duplicating.
 */
export function hashParams(params) {
  const canonical = JSON.stringify(params || {}, Object.keys(params || {}).sort());
  return crypto.createHash('sha1').update(canonical).digest('hex').slice(0, 16);
}

/**
 * Write a complete backtest result (run + metrics + regime + equity + trades).
 *
 * @param {Object} run
 * @param {string} run.symbol         - canonical, e.g. 'NSE:RELIANCE'
 * @param {string} run.strategy       - code, e.g. 'rsi2'
 * @param {string} run.strategyName   - human label
 * @param {string} run.timeframe      - '1D' etc.
 * @param {Object} run.params         - hashed for uniqueness
 * @param {string} run.dateFrom       - 'YYYY-MM-DD'
 * @param {string} run.dateTo         - 'YYYY-MM-DD'
 * @param {number} run.sampleSize     - bar count
 * @param {string} run.provider       - 'upstox' | 'yahoo' | 'cdp' | 'tv_strategy_tester'
 * @param {string} [run.windowLabel]  - '1y' | '6m' | '3m' | '1m' | 'oos' | 'all' (default 'all')
 * @param {Object} metrics            - matches backtest_metrics columns
 * @param {Array<{regime, trades, wins, winRate, avgPnlPct, profitFactor}>} regimeBreakdown
 * @param {Array<{t:number,e:number}>} equityPoints
 * @param {Array<{idx,entryTs,exitTs,entryPx,exitPx,pnlPct,barsHeld,exitReason,regime}>} trades
 * @returns {Promise<number>} run id
 */
export async function recordBacktestResult(run, metrics, regimeBreakdown = [], equityPoints = [], trades = []) {
  return withTransaction(async (client) => {
    const symbolId = await upsertSymbol({ canonical: run.symbol });
    const stratId = await upsertStrategy({ code: run.strategy, name: run.strategyName || run.strategy });
    const tfId = await timeframeId(run.timeframe);
    const paramsHash = hashParams(run.params);
    const windowLabel = run.windowLabel || 'all';

    // Upsert run
    const runRes = await client.query(
      `INSERT INTO backtest_runs
         (symbol_id, strategy_id, timeframe_id, params_hash, params_json,
          date_from, date_to, sample_size, provider, window_label)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9, $10)
       ON CONFLICT (symbol_id, strategy_id, timeframe_id, params_hash, date_to, window_label)
       DO UPDATE SET
         computed_at = NOW(),
         sample_size = EXCLUDED.sample_size,
         date_from   = EXCLUDED.date_from,
         provider    = EXCLUDED.provider,
         params_json = EXCLUDED.params_json
       RETURNING id`,
      [
        symbolId, stratId, tfId, paramsHash, JSON.stringify(run.params || {}),
        run.dateFrom, run.dateTo, run.sampleSize, run.provider, windowLabel,
      ],
    );
    const runId = runRes.rows[0].id;

    // Replace metrics (1:1)
    await client.query(`DELETE FROM backtest_metrics WHERE run_id = $1`, [runId]);
    await client.query(
      `INSERT INTO backtest_metrics
         (run_id, total_trades, wins, losses, win_rate, profit_factor, total_pnl_pct,
          avg_win_pct, avg_loss_pct, max_dd_pct, expectancy,
          sharpe, sortino, calmar, ulcer,
          wilson_lb, psr, deflated_sharpe,
          bootstrap_lo, bootstrap_hi,
          oos_trades, oos_win_rate, oos_pf, avg_hold_bars)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24)`,
      [
        runId,
        metrics.totalTrades || 0,
        metrics.wins || 0,
        metrics.losses || 0,
        metrics.winRate, metrics.profitFactor, metrics.totalPnlPct,
        metrics.avgWinPct, metrics.avgLossPct, metrics.maxDdPct, metrics.expectancy,
        metrics.sharpe, metrics.sortino, metrics.calmar, metrics.ulcer,
        metrics.wilsonLb, metrics.psr, metrics.deflatedSharpe,
        metrics.bootstrapLo, metrics.bootstrapHi,
        metrics.oosTrades, metrics.oosWinRate, metrics.oosPf, metrics.avgHoldBars,
      ],
    );

    // Replace regime metrics
    await client.query(`DELETE FROM regime_metrics WHERE run_id = $1`, [runId]);
    for (const r of regimeBreakdown) {
      const rid = await regimeId(r.regime);
      await client.query(
        `INSERT INTO regime_metrics
           (run_id, regime_id, trades, wins, win_rate, avg_pnl_pct, profit_factor)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [runId, rid, r.trades || 0, r.wins || 0, r.winRate, r.avgPnlPct, r.profitFactor],
      );
    }

    // Replace equity curve
    await client.query(`DELETE FROM equity_curve WHERE run_id = $1`, [runId]);
    if (equityPoints?.length) {
      await client.query(
        `INSERT INTO equity_curve (run_id, points) VALUES ($1, $2::jsonb)`,
        [runId, JSON.stringify(equityPoints)],
      );
    }

    // Replace trade log (cap at 100 most recent)
    await client.query(`DELETE FROM trade_log WHERE run_id = $1`, [runId]);
    const recent = (trades || []).slice(-100);
    for (let i = 0; i < recent.length; i++) {
      const t = recent[i];
      const tradeRegimeId = t.regime ? await regimeId(t.regime) : null;
      await client.query(
        `INSERT INTO trade_log
           (run_id, idx, entry_ts, exit_ts, entry_px, exit_px, pnl_pct, bars_held, exit_reason, regime_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [
          runId, i,
          t.entryTs, t.exitTs,
          t.entryPx, t.exitPx, t.pnlPct, t.barsHeld, t.exitReason, tradeRegimeId,
        ],
      );
    }

    return runId;
  });
}

// ─────────────────────────────────────────────────────────────────────
// Query helpers
// ─────────────────────────────────────────────────────────────────────

/**
 * Top N strategies for a symbol on a timeframe, ordered by profit factor.
 */
export async function topStrategiesForSymbol(symbol, timeframe, limit = 5) {
  const res = await query(
    `SELECT * FROM v_ranked_metrics
     WHERE symbol = $1 AND timeframe = $2
     ORDER BY profit_factor DESC NULLS LAST, psr DESC NULLS LAST
     LIMIT $3`,
    [symbol, timeframe, limit],
  );
  return res.rows;
}

/**
 * Top N symbols for a strategy on a timeframe.
 */
export async function topSymbolsForStrategy(strategy, timeframe, limit = 10) {
  const res = await query(
    `SELECT * FROM v_ranked_metrics
     WHERE strategy = $1 AND timeframe = $2
     ORDER BY profit_factor DESC NULLS LAST
     LIMIT $3`,
    [strategy, timeframe, limit],
  );
  return res.rows;
}

/**
 * Bulk slice for heatmap rendering: rows = strategies, cols = symbols.
 */
export async function getMatrixSlice({ symbols, strategies, timeframe }) {
  const res = await query(
    `SELECT * FROM v_ranked_metrics
     WHERE symbol = ANY($1::text[])
       AND strategy = ANY($2::text[])
       AND timeframe = $3`,
    [symbols, strategies, timeframe],
  );
  return res.rows;
}

/**
 * Full detail for one (symbol, strategy, timeframe) — metrics + regime + equity + trades.
 */
export async function getRunDetail({ symbol, strategy, timeframe }) {
  const runRes = await query(
    `SELECT lr.run_id FROM v_latest_runs lr
     JOIN symbols    s  ON s.id  = lr.symbol_id
     JOIN strategies st ON st.id = lr.strategy_id
     JOIN timeframes tf ON tf.id = lr.timeframe_id
     WHERE s.canonical = $1 AND st.code = $2 AND tf.code = $3`,
    [symbol, strategy, timeframe],
  );
  if (!runRes.rows[0]) return null;
  const runId = runRes.rows[0].run_id;

  const [metrics, regime, equity, trades] = await Promise.all([
    query(`SELECT * FROM backtest_metrics WHERE run_id = $1`, [runId]),
    query(
      `SELECT rg.code AS regime, rm.* FROM regime_metrics rm
       JOIN regimes rg ON rg.id = rm.regime_id WHERE rm.run_id = $1`, [runId]),
    query(`SELECT points FROM equity_curve WHERE run_id = $1`, [runId]),
    query(`SELECT * FROM trade_log WHERE run_id = $1 ORDER BY idx`, [runId]),
  ]);

  return {
    runId,
    metrics: metrics.rows[0] || null,
    regime: regime.rows,
    equity: equity.rows[0]?.points || [],
    trades: trades.rows,
  };
}

/**
 * Runs older than `maxAgeDays` — used by the scheduler to refresh stale data.
 */
export async function staleRuns(maxAgeDays = 7, limit = 100) {
  const res = await query(
    `SELECT s.canonical AS symbol, st.code AS strategy, tf.code AS timeframe, r.computed_at
     FROM backtest_runs r
     JOIN symbols    s  ON s.id  = r.symbol_id
     JOIN strategies st ON st.id = r.strategy_id
     JOIN timeframes tf ON tf.id = r.timeframe_id
     WHERE r.computed_at < NOW() - ($1 || ' days')::interval
     ORDER BY r.computed_at ASC
     LIMIT $2`,
    [String(maxAgeDays), limit],
  );
  return res.rows;
}
