/**
 * v2 API — symbol-aware engine endpoints.
 *
 * Mounted into dashboard.js with a single line:
 *
 *   if (pathname.startsWith('/api/v2/')) {
 *     if (await v2Router(req, res, pathname)) return;
 *   }
 *
 * Routes:
 *   GET  /api/v2/strategies               → list registry (with filtering)
 *   GET  /api/v2/strategies/:code         → single strategy meta
 *   POST /api/v2/analyze                  → run one strategy on one symbol
 *   POST /api/v2/scan                     → run scanner (batch jobs)
 *   POST /api/v2/scan/symbol-all          → all 20 strategies × 1 symbol
 *   POST /api/v2/scan/strategy-all        → 1 strategy × N symbols
 *   POST /api/v2/rank                     → rank scan results (or scan+rank in one call)
 *   GET  /api/v2/symbols/search?q=...     → symbol search via data router
 *   GET  /api/v2/data/ohlcv?symbol=...    → fetch historical bars
 *   GET  /api/v2/health                   → quick health check
 */

import {
  STRATEGY_REGISTRY,
  STRATEGY_CODES,
  STRATEGY_FAMILIES,
  getStrategy,
  listStrategies,
  runStrategy,
  scanMatrix,
  scanSymbolAllStrategies,
  scanStrategyAllSymbols,
  groupBySymbol,
  groupByStrategy,
  actionableOnly,
  rankSignals,
  topNPerSymbol,
  actionableRanked,
} from '../engine/index.js';
import { runTvBacktest } from '../engine/tv-runner.js';
import { runMatrix, runMultiWindow, runWithCostStress, TIME_WINDOWS, COST_PROFILES, runMatrixModes, INTRADAY_MATRIX, SWING_MATRIX } from '../engine/matrix-runner.js';
import { rankSignalsV2, topNPerSymbolV2, highConfidenceOnly, rankCellsByMode, topNPerSymbolByMode, buildGenAIPayload, MODE_PROFILES } from '../engine/ranker-v2.js';
import { checkConfluence, checkConfluenceBatch, DEFAULT_CONFLUENCE_TIMEFRAMES } from '../engine/confluence.js';
import { searchSymbol, getHistorical, TIMEFRAMES, describeRouting } from '../data/index.js';
import { persistResult, persistMatrixCell, persistMatrixBatch, persistEnabled, persistMatrixModesBatch } from '../db/persist.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', chunk => { raw += chunk; if (raw.length > 1e7) reject(new Error('body too large')); });
    req.on('end', () => {
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch (e) { reject(new Error('invalid JSON: ' + e.message)); }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(payload));
}

function sendError(res, err, status = 500) {
  const msg = err?.message || String(err);
  console.error(`[v2 API] ${status} error:`, msg, err?.stack ? `\n${err.stack}` : '');
  sendJson(res, status, { success: false, error: msg });
}

// ─────────────────────────────────────────────────────────────────────
// TV Strategy Tester serial queue.
//
// The TradingView chart is shared global state — only ONE backtest can
// drive it at a time. We expose `enqueueTvJob` so HTTP handlers (analyze /
// scan SSE) can push jobs without worrying about concurrency.
// ─────────────────────────────────────────────────────────────────────
const tvQueue = {
  current: null,        // { id, code, symbol, timeframe, startedAt }
  pending: [],          // [{ id, args, resolve, reject }, ...]
  recent: [],           // last 10 finished jobs (success or failure)
};
let tvJobIdCounter = 0;

function _drainTvQueue() {
  if (tvQueue.current) return;
  const job = tvQueue.pending.shift();
  if (!job) return;
  tvQueue.current = {
    id: job.id,
    code: job.args.code,
    symbol: job.args.symbol,
    timeframe: job.args.timeframe,
    startedAt: Date.now(),
  };
  runTvBacktest(job.args).then(
    (result) => {
      tvQueue.recent.unshift({
        id: job.id, ok: true, code: job.args.code, symbol: job.args.symbol,
        timeframe: job.args.timeframe, finishedAt: Date.now(),
        durationMs: Date.now() - tvQueue.current.startedAt,
      });
      tvQueue.recent = tvQueue.recent.slice(0, 10);
      tvQueue.current = null;
      job.resolve(result);
      _drainTvQueue();
    },
    (err) => {
      tvQueue.recent.unshift({
        id: job.id, ok: false, code: job.args.code, symbol: job.args.symbol,
        timeframe: job.args.timeframe, finishedAt: Date.now(),
        durationMs: Date.now() - tvQueue.current.startedAt,
        error: err?.message || String(err),
      });
      tvQueue.recent = tvQueue.recent.slice(0, 10);
      tvQueue.current = null;
      job.reject(err);
      _drainTvQueue();
    },
  );
}

function enqueueTvJob(args) {
  return new Promise((resolve, reject) => {
    const id = ++tvJobIdCounter;
    tvQueue.pending.push({ id, args, resolve, reject });
    _drainTvQueue();
  });
}

/**
 * @returns {Promise<boolean>} true if route was handled, false to fall through.
 */
export async function v2Router(req, res, pathname) {
  const url = new URL(req.url, 'http://x');

  // GET /api/v2/health
  if (pathname === '/api/v2/health' && req.method === 'GET') {
    sendJson(res, 200, {
      success: true,
      strategies: STRATEGY_CODES.length,
      families: STRATEGY_FAMILIES,
      timeframes: TIMEFRAMES,
      version: 'v2.0',
    });
    return true;
  }

  // GET /api/v2/strategies?family=...&style=...&backtestableOnly=true
  if (pathname === '/api/v2/strategies' && req.method === 'GET') {
    const family = url.searchParams.get('family') || undefined;
    const style = url.searchParams.get('style') || undefined;
    const source = url.searchParams.get('source') || undefined;
    const backtestableOnly = url.searchParams.get('backtestableOnly') !== 'false';
    const list = listStrategies({ family, style, source, backtestableOnly });
    sendJson(res, 200, {
      success: true,
      total: list.length,
      strategies: list,
      families: STRATEGY_FAMILIES,
    });
    return true;
  }

  // GET /api/v2/strategies/:code/pine  → raw Pine source from pdf/{source}/{code}.pine
  if (/^\/api\/v2\/strategies\/[^/]+\/pine$/.test(pathname) && req.method === 'GET') {
    const code = pathname.slice('/api/v2/strategies/'.length, -'/pine'.length);
    const meta = getStrategy(code);
    if (!meta) {
      sendJson(res, 404, { success: false, error: `Unknown strategy '${code}'` });
      return true;
    }
    const pinePath = path.join(REPO_ROOT, 'pdf', meta.source || 'community', `${code}.pine`);
    if (!fs.existsSync(pinePath)) {
      sendJson(res, 404, {
        success: false,
        error: `No Pine source on disk for '${code}'`,
        expectedPath: path.relative(REPO_ROOT, pinePath),
      });
      return true;
    }
    try {
      const source = fs.readFileSync(pinePath, 'utf8');
      sendJson(res, 200, { success: true, code, source, sourceFolder: meta.source, path: path.relative(REPO_ROOT, pinePath) });
    } catch (err) { sendError(res, err, 500); }
    return true;
  }

  // GET /api/v2/strategies/:code
  if (pathname.startsWith('/api/v2/strategies/') && req.method === 'GET') {
    const code = pathname.slice('/api/v2/strategies/'.length);
    const meta = getStrategy(code);
    if (!meta) {
      sendJson(res, 404, { success: false, error: `Unknown strategy '${code}'` });
      return true;
    }
    sendJson(res, 200, { success: true, strategy: meta });
    return true;
  }

  // POST /api/v2/analyze
  // Body: { code, symbol, timeframe, params?, mode?, lookbackDays? }
  if (pathname === '/api/v2/analyze' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const { code, symbol, timeframe = '1D', params, mode = 'backtest', lookbackDays } = body;
      if (!code) throw new Error('code required');
      if (!symbol) throw new Error('symbol required');
      const result = await runStrategy({ code, symbol, timeframe, params, mode, lookbackDays });
      sendJson(res, 200, { success: true, result });
      // Fire-and-forget DB persistence (backtest mode only)
      if (mode !== 'live' && persistEnabled()) {
        persistResult({
          symbol, code, name: result?.name, timeframe, params,
          result, provider: 'yahoo', windowLabel: 'all',
        }).catch(err => console.warn('[v2/analyze] persist failed:', err.message));
      }
    } catch (err) { sendError(res, err, 400); }
    return true;
  }

  // POST /api/v2/scan
  // Body: { jobs: [{code, symbol, timeframe, params?}], mode?, concurrency? }
  if (pathname === '/api/v2/scan' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const { jobs, mode = 'live', concurrency = 8 } = body;
      if (!Array.isArray(jobs) || !jobs.length) throw new Error('jobs[] required');
      if (jobs.length > 200) throw new Error('max 200 jobs per request');
      const results = await scanMatrix({ jobs, mode, concurrency });
      const actionable = actionableOnly(results);
      sendJson(res, 200, {
        success: true,
        total: results.length,
        actionable: actionable.length,
        results,
        bySymbol: groupBySymbol(results),
        byStrategy: groupByStrategy(results),
      });
      // Fire-and-forget DB persistence for backtest-mode jobs
      if (mode !== 'live' && persistEnabled()) {
        const persistJobs = results
          .filter(r => r.ok && r.result)
          .map(r => persistResult({
            symbol: r.symbol, code: r.code, name: r.result.name,
            timeframe: r.timeframe, params: r.params, result: r.result,
            provider: 'yahoo', windowLabel: 'all',
          }).catch(() => null));
        Promise.all(persistJobs).catch(err => console.warn('[v2/scan] persist batch failed:', err.message));
      }
    } catch (err) { sendError(res, err, 400); }
    return true;
  }

  // POST /api/v2/scan/symbol-all  — every strategy on one symbol
  if (pathname === '/api/v2/scan/symbol-all' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const { symbol, timeframe = '1D', mode = 'live' } = body;
      if (!symbol) throw new Error('symbol required');
      const results = await scanSymbolAllStrategies(symbol, timeframe, {
        mode,
        filter: meta => meta.backtestable !== false && (!meta.timeframes || meta.timeframes.includes(timeframe)),
      });
      sendJson(res, 200, {
        success: true,
        symbol, timeframe, mode,
        total: results.length,
        actionable: actionableOnly(results).length,
        results,
      });
    } catch (err) { sendError(res, err, 400); }
    return true;
  }

  // POST /api/v2/scan/strategy-all  — one strategy on many symbols
  if (pathname === '/api/v2/scan/strategy-all' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const { code, symbols, timeframe = '1D', mode = 'live' } = body;
      if (!code) throw new Error('code required');
      if (!Array.isArray(symbols) || !symbols.length) throw new Error('symbols[] required');
      if (symbols.length > 200) throw new Error('max 200 symbols per request');
      const results = await scanStrategyAllSymbols(code, symbols, timeframe, { mode });
      sendJson(res, 200, {
        success: true,
        code, timeframe, mode,
        total: results.length,
        actionable: actionableOnly(results).length,
        results,
      });
    } catch (err) { sendError(res, err, 400); }
    return true;
  }

  // GET /api/v2/symbols/search?q=...&limit=10
  if (pathname === '/api/v2/symbols/search' && req.method === 'GET') {
    try {
      const q = url.searchParams.get('q') || '';
      const limit = Math.min(50, parseInt(url.searchParams.get('limit') || '10', 10));
      if (!q.trim()) throw new Error('q required');
      const all = await searchSymbol(q.trim());
      sendJson(res, 200, { success: true, query: q, matches: all.slice(0, limit) });
    } catch (err) { sendError(res, err, 400); }
    return true;
  }

  // GET /api/v2/data/ohlcv?symbol=AAPL&timeframe=1D&days=365
  if (pathname === '/api/v2/data/ohlcv' && req.method === 'GET') {
    try {
      const symbol = url.searchParams.get('symbol');
      const timeframe = url.searchParams.get('timeframe') || '1D';
      const days = parseInt(url.searchParams.get('days') || '365', 10);
      if (!symbol) throw new Error('symbol required');
      const to = Math.floor(Date.now() / 1000);
      const from = to - days * 86400;
      const result = await getHistorical({ symbol, timeframe, from, to });
      sendJson(res, 200, {
        success: true,
        symbol, timeframe,
        bars: result.bars,
        count: result.bars?.length || 0,
        provider: result.provider,
        routing: describeRouting(symbol),
      });
    } catch (err) { sendError(res, err, 400); }
    return true;
  }

  // POST /api/v2/rank
  // Body: { results: <scanResults>, opts?: {...}, actionableOnly?: bool, topNPerSymbol?: number }
  // Convenience: { jobs, mode } — runs scan, then ranks (one round-trip)
  if (pathname === '/api/v2/rank' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      let results = body.results;
      const opts = body.opts || {};

      // Convenience: if `jobs` provided, run a scan first
      if (!results && Array.isArray(body.jobs)) {
        if (body.jobs.length > 200) throw new Error('Too many jobs (max 200)');
        const scanned = await scanMatrix({
          jobs: body.jobs,
          mode: body.mode || 'live',
          concurrency: body.concurrency || 8,
        });
        results = scanned;
      }

      if (!Array.isArray(results)) {
        throw new Error('results array required (or provide jobs + mode for inline scan)');
      }

      // Surface failed jobs (rankSignals silently drops them) so the caller
      // knows WHY totalRanked is smaller than jobs.length.
      const failed = results
        .filter(r => !r.ok)
        .map(r => ({
          code: r.code,
          symbol: r.symbol,
          timeframe: r.timeframe,
          error: r.error || 'unknown error',
        }));

      let ranked = rankSignals(results, opts);
      if (body.actionableOnly) ranked = actionableRanked(ranked);

      const payload = {
        success: true,
        totalJobs: results.length,
        totalRanked: ranked.length,
        totalFailed: failed.length,
        topRanked: ranked.slice(0, body.limit || 50),
      };
      if (failed.length > 0) {
        payload.failed = failed.slice(0, 50); // cap to avoid huge payloads
        payload.hint = `${failed.length} job(s) failed. Common cause: invalid 'code' (use full registry code like 'ibs_india_swing', not 'ibs'). See /api/v2/strategies for valid codes.`;
      }
      if (body.topNPerSymbol) {
        payload.topNPerSymbol = topNPerSymbol(ranked, body.topNPerSymbol);
      }
      sendJson(res, 200, payload);
    } catch (err) { sendError(res, err, 400); }
    return true;
  }

  // ──────────────────────────────────────────────────────────────────
  // TV Strategy Tester endpoints (provider: 'tv_strategy_tester')
  // ──────────────────────────────────────────────────────────────────

  // GET /api/v2/tv/status — current running job, queue depth, recent history
  if (pathname === '/api/v2/tv/status' && req.method === 'GET') {
    sendJson(res, 200, {
      success: true,
      current: tvQueue.current,
      pendingCount: tvQueue.pending.length,
      recent: tvQueue.recent,
    });
    return true;
  }

  // POST /api/v2/tv/analyze
  // Body: { code, symbol, timeframe, dateFrom?, dateTo? }
  // Blocking — caller waits for the TV chart to settle and metrics to populate.
  if (pathname === '/api/v2/tv/analyze' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const { code, symbol, timeframe, dateFrom, dateTo } = body;
      if (!code) throw new Error('code required');
      if (!symbol) throw new Error('symbol required');
      if (!timeframe) throw new Error('timeframe required');
      const result = await enqueueTvJob({ code, symbol, timeframe, dateFrom, dateTo });
      sendJson(res, 200, { success: true, result });
      if (persistEnabled() && result?.ok) {
        persistResult({
          symbol, code, name: result?.name, timeframe,
          result, provider: 'tv_strategy_tester', windowLabel: 'all',
          dateFrom, dateTo,
        }).catch(err => console.warn('[v2/tv/analyze] persist failed:', err.message));
      }
    } catch (err) { sendError(res, err, 400); }
    return true;
  }

  // POST /api/v2/tv/scan — bulk SSE stream
  // Body: { cells: [{code, symbol, timeframe, dateFrom?, dateTo?}, ...] }
  // Streams events:
  //   event: start    data: { total }
  //   event: progress data: { index, total, code, symbol, timeframe }
  //   event: result   data: { index, ok: true, code, symbol, timeframe, result }
  //   event: error    data: { index, ok: false, code, symbol, timeframe, error }
  //   event: done     data: { total, ok, fail, aborted }
  if (pathname === '/api/v2/tv/scan' && req.method === 'POST') {
    let body;
    try {
      body = await readBody(req);
    } catch (err) {
      sendError(res, err, 400);
      return true;
    }
    const cells = Array.isArray(body?.cells) ? body.cells : null;
    if (!cells || cells.length === 0) {
      sendError(res, new Error('cells[] required'), 400);
      return true;
    }
    if (cells.length > 100) {
      sendError(res, new Error('max 100 cells per scan'), 400);
      return true;
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    const send = (event, data) => {
      res.write(`event: ${event}\n`);
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    let aborted = false;
    req.on('close', () => { aborted = true; });

    send('start', { total: cells.length });
    let ok = 0, fail = 0;
    for (let i = 0; i < cells.length; i++) {
      if (aborted) break;
      const cell = cells[i] || {};
      const meta = { index: i, total: cells.length, code: cell.code, symbol: cell.symbol, timeframe: cell.timeframe };
      send('progress', meta);
      try {
        if (!cell.code || !cell.symbol || !cell.timeframe) {
          throw new Error('cell missing code/symbol/timeframe');
        }
        const result = await enqueueTvJob({
          code: cell.code,
          symbol: cell.symbol,
          timeframe: cell.timeframe,
          dateFrom: cell.dateFrom,
          dateTo: cell.dateTo,
        });
        ok++;
        send('result', { ...meta, ok: true, result });
      } catch (err) {
        fail++;
        send('error', { ...meta, ok: false, error: err?.message || String(err) });
      }
    }

    send('done', { total: cells.length, ok, fail, aborted });
    res.end();
    return true;
  }

  // ──────────────────────────────────────────────────────────────────
  // Multi-window matrix endpoints (Phase 8)
  // ──────────────────────────────────────────────────────────────────

  // POST /api/v2/matrix/scan
  // Body: { cells, provider?, windows?, costProfile?, concurrency? }
  //   - cells:       [{code, symbol, timeframe}]  (max 50 to keep response sane)
  //   - provider:    'js' (default) | 'tv'
  //   - windows:     [{label, days}] override (default 1y/6m/3m/1m)
  //   - costProfile: 'base' (default) | 'stress'
  //   - concurrency: ignored when provider='tv' (forced to 1)
  if (pathname === '/api/v2/matrix/scan' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const cells = Array.isArray(body.cells) ? body.cells : null;
      if (!cells || cells.length === 0) throw new Error('cells[] required');
      if (cells.length > 50) throw new Error('max 50 cells per matrix scan');
      const provider = body.provider === 'tv' ? 'tv' : 'js';
      const matrix = await runMatrix({
        cells,
        provider,
        windows: Array.isArray(body.windows) ? body.windows : TIME_WINDOWS,
        costProfile: body.costProfile === 'stress' ? 'stress' : 'base',
        concurrency: Number(body.concurrency) || 4,
      });
      sendJson(res, 200, { success: true, provider, count: matrix.length, matrix });
      // Fire-and-forget DB persistence per window per cell
      if (persistEnabled()) {
        persistMatrixBatch(matrix, provider === 'tv' ? 'tv_strategy_tester' : 'yahoo', 4)
          .then(r => console.log(`[v2/matrix/scan] persisted ${r.persisted} window-rows (failed: ${r.failed})`))
          .catch(err => console.warn('[v2/matrix/scan] persist batch failed:', err.message));
      }
    } catch (err) { sendError(res, err, 400); }
    return true;
  }

  // POST /api/v2/matrix/rank
  // Body: { matrix } | { cells, provider, windows?, costProfile?, concurrency? }
  //       + optional { opts, topN, highConfidenceOnly: bool }
  // Pre-computed matrix can be passed directly to avoid re-running.
  if (pathname === '/api/v2/matrix/rank' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      let matrix = Array.isArray(body.matrix) ? body.matrix : null;
      let ranInline = false;
      let providerUsed = 'js';

      if (!matrix && Array.isArray(body.cells)) {
        if (body.cells.length > 50) throw new Error('max 50 cells per inline scan');
        const provider = body.provider === 'tv' ? 'tv' : 'js';
        providerUsed = provider;
        matrix = await runMatrix({
          cells: body.cells,
          provider,
          windows: Array.isArray(body.windows) ? body.windows : TIME_WINDOWS,
          costProfile: body.costProfile === 'stress' ? 'stress' : 'base',
          concurrency: Number(body.concurrency) || 4,
        });
        ranInline = true;
      }
      if (!Array.isArray(matrix)) {
        throw new Error('matrix[] or cells[] required');
      }

      let ranked = rankSignalsV2(matrix, body.opts || {});
      if (body.highConfidenceOnly) ranked = highConfidenceOnly(ranked);

      const payload = {
        success: true,
        totalRanked: ranked.length,
        ranked: ranked.slice(0, Number(body.limit) || 100),
      };
      if (body.topN) {
        payload.topNPerSymbol = topNPerSymbolV2(ranked, Number(body.topN));
      }
      sendJson(res, 200, payload);
      // Fire-and-forget DB persistence (only when we actually ran the matrix inline)
      if (ranInline && persistEnabled()) {
        persistMatrixBatch(matrix, providerUsed === 'tv' ? 'tv_strategy_tester' : 'yahoo', 4)
          .then(r => console.log(`[v2/matrix/rank] persisted ${r.persisted} window-rows (failed: ${r.failed})`))
          .catch(err => console.warn('[v2/matrix/rank] persist batch failed:', err.message));
      }
    } catch (err) { sendError(res, err, 400); }
    return true;
  }

  // POST /api/v2/matrix/cost-stress
  // Body: { code, symbol, timeframe, windows? }
  // Runs the cell under base + stress profiles, returns both + fragility verdict.
  if (pathname === '/api/v2/matrix/cost-stress' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const { code, symbol, timeframe } = body;
      if (!code) throw new Error('code required');
      if (!symbol) throw new Error('symbol required');
      if (!timeframe) throw new Error('timeframe required');
      const result = await runWithCostStress({
        code, symbol, timeframe,
        windows: Array.isArray(body.windows) ? body.windows : TIME_WINDOWS,
      });
      sendJson(res, 200, { success: true, result });
    } catch (err) { sendError(res, err, 400); }
    return true;
  }

  // ──────────────────────────────────────────────────────────────────
  // Phase 8.7 — HFT mode-aware matrix (Intraday / Swing / Both)
  // ──────────────────────────────────────────────────────────────────

  // GET /api/v2/matrix/modes/profiles
  // Returns the active TF/window matrices and MODE_PROFILES so the UI can
  // render the correct toggles + labels without hard-coding them.
  if (pathname === '/api/v2/matrix/modes/profiles' && req.method === 'GET') {
    try {
      sendJson(res, 200, {
        success: true,
        intradayMatrix: INTRADAY_MATRIX,
        swingMatrix: SWING_MATRIX,
        profiles: MODE_PROFILES,
      });
    } catch (err) { sendError(res, err, 500); }
    return true;
  }

  // POST /api/v2/matrix/modes/rank
  // Body:
  //   {
  //     cells: [{ code, symbol }, ...],   // required, max 50
  //     mode: 'intraday' | 'swing' | 'both',  // default 'both'
  //     sortBy: 'intraday' | 'swing',     // default = mode (or 'intraday' when 'both')
  //     provider: 'js',                   // 'tv' rejected
  //     costProfile: 'base' | 'stress',
  //     concurrency: 6,
  //     genai: false,                     // include GenAI payload per cell
  //     topN: number,                     // top N per symbol
  //     highConfidenceOnly: bool,
  //     limit: 100
  //   }
  if (pathname === '/api/v2/matrix/modes/rank' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      if (!Array.isArray(body.cells) || body.cells.length === 0) {
        throw new Error('cells[] required');
      }
      if (body.cells.length > 50) throw new Error('max 50 cells per call');
      const mode = ['intraday', 'swing', 'both'].includes(body.mode) ? body.mode : 'both';
      const sortBy = body.sortBy === 'swing' ? 'swing' : 'intraday';

      const matrix = await runMatrixModes({
        cells: body.cells,
        mode,
        provider: 'js',
        costProfile: body.costProfile === 'stress' ? 'stress' : 'base',
        concurrency: Number(body.concurrency) || 6,
      });

      let ranked = rankCellsByMode(matrix, sortBy, body.opts || {});
      if (body.highConfidenceOnly) {
        ranked = ranked.filter(c => {
          const tier = c.rankingV2?.[sortBy]?.confidence;
          return tier === 'high' || tier === 'medium';
        });
      }

      const payload = {
        success: true,
        mode,
        sortBy,
        totalRanked: ranked.length,
        ranked: ranked.slice(0, Number(body.limit) || 100),
      };
      if (body.topN) {
        payload.topNPerSymbol = topNPerSymbolByMode(ranked, sortBy, Number(body.topN));
      }
      if (body.genai) {
        payload.genai = ranked.slice(0, Number(body.limit) || 100).map(buildGenAIPayload);
      }

      sendJson(res, 200, payload);

      // Fire-and-forget DB persistence — one row per (cell, tf, window)
      if (persistEnabled()) {
        persistMatrixModesBatch(matrix, 'js_engine_modes', 4)
          .then(r => console.log(`[v2/matrix/modes/rank] persisted ${r.persisted} rows (failed: ${r.failed})`))
          .catch(err => console.warn('[v2/matrix/modes/rank] persist failed:', err.message));
      }
    } catch (err) { sendError(res, err, 400); }
    return true;
  }

  // POST /api/v2/matrix/modes/genai/:codeSymbol
  // Lighter alternative — returns ONLY the GenAI payload for a single
  // (code, symbol) cell. Used by upstream LLM pipelines.
  if (pathname === '/api/v2/matrix/modes/genai' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const { code, symbol } = body;
      if (!code || !symbol) throw new Error('code and symbol required');
      const mode = ['intraday', 'swing', 'both'].includes(body.mode) ? body.mode : 'both';

      const matrix = await runMatrixModes({
        cells: [{ code, symbol }],
        mode,
        provider: 'js',
        costProfile: body.costProfile === 'stress' ? 'stress' : 'base',
        concurrency: 6,
      });
      const ranked = rankCellsByMode(matrix, mode === 'swing' ? 'swing' : 'intraday', body.opts || {});
      const payload = ranked[0] ? buildGenAIPayload(ranked[0]) : null;
      sendJson(res, 200, { success: true, payload });

      if (persistEnabled()) {
        persistMatrixModesBatch(matrix, 'js_engine_modes', 1)
          .catch(err => console.warn('[v2/matrix/modes/genai] persist failed:', err.message));
      }
    } catch (err) { sendError(res, err, 400); }
    return true;
  }

  // ──────────────────────────────────────────────────────────────────
  // Multi-timeframe confluence
  // ──────────────────────────────────────────────────────────────────

  // POST /api/v2/confluence — single (code, symbol)
  // Body: { code, symbol, timeframes? }
  if (pathname === '/api/v2/confluence' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const { code, symbol } = body;
      if (!code) throw new Error('code required');
      if (!symbol) throw new Error('symbol required');
      const result = await checkConfluence({
        code, symbol,
        timeframes: Array.isArray(body.timeframes) && body.timeframes.length
          ? body.timeframes
          : DEFAULT_CONFLUENCE_TIMEFRAMES,
        params: body.params,
      });
      sendJson(res, 200, { success: true, result });
    } catch (err) { sendError(res, err, 400); }
    return true;
  }

  // POST /api/v2/confluence/batch
  // Body: { pairs: [{code, symbol, params?}], timeframes? }
  if (pathname === '/api/v2/confluence/batch' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const pairs = Array.isArray(body.pairs) ? body.pairs : null;
      if (!pairs || pairs.length === 0) throw new Error('pairs[] required');
      if (pairs.length > 50) throw new Error('max 50 pairs');
      const results = await checkConfluenceBatch({
        pairs,
        timeframes: Array.isArray(body.timeframes) && body.timeframes.length
          ? body.timeframes
          : DEFAULT_CONFLUENCE_TIMEFRAMES,
        params: body.params,
        concurrency: Number(body.concurrency) || 4,
      });
      sendJson(res, 200, { success: true, count: results.length, results });
    } catch (err) { sendError(res, err, 400); }
    return true;
  }

  // ──────────────────────────────────────────────────────────────────
  // Database read endpoints (Phase 2 persistence layer)
  // ──────────────────────────────────────────────────────────────────

  // GET /api/v2/db/health — DB connection status + table counts
  if (pathname === '/api/v2/db/health' && req.method === 'GET') {
    try {
      const { healthCheck, isDbConfigured, query } = await import('../db/client.js');
      if (!isDbConfigured()) {
        sendJson(res, 200, { success: true, configured: false, message: 'DATABASE_URL not set' });
        return true;
      }
      const health = await healthCheck();
      let counts = null;
      if (health.ok) {
        const r = await query(
          `SELECT
             (SELECT COUNT(*)::int FROM symbols)          AS symbols,
             (SELECT COUNT(*)::int FROM strategies)       AS strategies,
             (SELECT COUNT(*)::int FROM backtest_runs)    AS runs,
             (SELECT COUNT(*)::int FROM backtest_metrics) AS metrics`,
        );
        counts = r.rows[0];
      }
      sendJson(res, 200, { success: true, configured: true, health, counts });
    } catch (err) { sendError(res, err, 500); }
    return true;
  }

  // GET /api/v2/db/top?symbol=AAPL&timeframe=1D&limit=5 — top strategies for symbol
  if (pathname === '/api/v2/db/top' && req.method === 'GET') {
    try {
      const { topStrategiesForSymbol } = await import('../db/matrix.js');
      const symbol = url.searchParams.get('symbol');
      const timeframe = url.searchParams.get('timeframe') || '1D';
      const limit = Number(url.searchParams.get('limit')) || 5;
      if (!symbol) throw new Error('symbol required');
      const rows = await topStrategiesForSymbol(symbol, timeframe, limit);
      sendJson(res, 200, { success: true, symbol, timeframe, count: rows.length, rows });
    } catch (err) { sendError(res, err, 400); }
    return true;
  }

  // GET /api/v2/db/strategy-top?code=rsi2_india_swing&timeframe=1D&limit=10 — top symbols for strategy
  if (pathname === '/api/v2/db/strategy-top' && req.method === 'GET') {
    try {
      const { topSymbolsForStrategy } = await import('../db/matrix.js');
      const code = url.searchParams.get('code');
      const timeframe = url.searchParams.get('timeframe') || '1D';
      const limit = Number(url.searchParams.get('limit')) || 10;
      if (!code) throw new Error('code required');
      const rows = await topSymbolsForStrategy(code, timeframe, limit);
      sendJson(res, 200, { success: true, code, timeframe, count: rows.length, rows });
    } catch (err) { sendError(res, err, 400); }
    return true;
  }

  // POST /api/v2/db/slice — bulk slice for heatmap
  // Body: { symbols, strategies, timeframe }
  if (pathname === '/api/v2/db/slice' && req.method === 'POST') {
    try {
      const { getMatrixSlice } = await import('../db/matrix.js');
      const body = await readBody(req);
      const { symbols, strategies, timeframe = '1D' } = body;
      if (!Array.isArray(symbols) || !Array.isArray(strategies)) {
        throw new Error('symbols[] and strategies[] required');
      }
      const rows = await getMatrixSlice({ symbols, strategies, timeframe });
      sendJson(res, 200, { success: true, count: rows.length, rows });
    } catch (err) { sendError(res, err, 400); }
    return true;
  }

  // GET /api/v2/db/detail?symbol=NSE:RELIANCE&code=rsi2_india_swing&timeframe=1D
  if (pathname === '/api/v2/db/detail' && req.method === 'GET') {
    try {
      const { getRunDetail } = await import('../db/matrix.js');
      const symbol = url.searchParams.get('symbol');
      const code = url.searchParams.get('code');
      const timeframe = url.searchParams.get('timeframe') || '1D';
      if (!symbol || !code) throw new Error('symbol and code required');
      const detail = await getRunDetail({ symbol, strategy: code, timeframe });
      if (!detail) {
        sendJson(res, 404, { success: false, error: 'no run found' });
        return true;
      }
      sendJson(res, 200, { success: true, ...detail });
    } catch (err) { sendError(res, err, 400); }
    return true;
  }

  // GET /api/v2/db/stale?maxAgeDays=7&limit=100
  if (pathname === '/api/v2/db/stale' && req.method === 'GET') {
    try {
      const { staleRuns } = await import('../db/matrix.js');
      const maxAgeDays = Number(url.searchParams.get('maxAgeDays')) || 7;
      const limit = Number(url.searchParams.get('limit')) || 100;
      const rows = await staleRuns(maxAgeDays, limit);
      sendJson(res, 200, { success: true, maxAgeDays, count: rows.length, rows });
    } catch (err) { sendError(res, err, 400); }
    return true;
  }

  // ──────────────────────────────────────────────────────────────────
  // Background scheduler control
  // ──────────────────────────────────────────────────────────────────

  // GET /api/v2/scheduler/status
  if (pathname === '/api/v2/scheduler/status' && req.method === 'GET') {
    try {
      const { getSchedulerStatus } = await import('../engine/scheduler.js');
      sendJson(res, 200, { success: true, status: getSchedulerStatus() });
    } catch (err) { sendError(res, err, 500); }
    return true;
  }

  // POST /api/v2/scheduler/run-now — trigger one immediate refresh cycle
  if (pathname === '/api/v2/scheduler/run-now' && req.method === 'POST') {
    try {
      const { runSchedulerCycle } = await import('../engine/scheduler.js');
      const body = await readBody(req).catch(() => ({}));
      const result = await runSchedulerCycle({
        maxAgeDays: body.maxAgeDays != null ? Number(body.maxAgeDays) : undefined,
        batch:      body.batch      != null ? Number(body.batch)      : undefined,
      });
      sendJson(res, 200, { success: true, result });
    } catch (err) { sendError(res, err, 500); }
    return true;
  }

  // POST /api/v2/scheduler/seed — pre-fill matrix for a list of cells
  // Body: { cells: [{code, symbol, timeframe}], provider? }
  if (pathname === '/api/v2/scheduler/seed' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const cells = Array.isArray(body.cells) ? body.cells : null;
      if (!cells || !cells.length) throw new Error('cells[] required');
      if (cells.length > 100) throw new Error('max 100 cells per seed');
      const provider = body.provider === 'tv' ? 'tv' : 'js';
      const matrix = await runMatrix({
        cells, provider,
        windows: TIME_WINDOWS,
        concurrency: Number(body.concurrency) || 4,
      });
      let persisted = 0;
      if (persistEnabled()) {
        const r = await persistMatrixBatch(matrix, provider === 'tv' ? 'tv_strategy_tester' : 'yahoo', 4);
        persisted = r.persisted || 0;
      }
      sendJson(res, 200, { success: true, cells: matrix.length, persisted });
    } catch (err) { sendError(res, err, 400); }
    return true;
  }

  return false;
}
