import { useCallback, useMemo } from 'react';

/**
 * v2 API hook — symbol-aware engine endpoints.
 *
 * Pairs with src/api/v2.js on the server side.
 * All methods return `{ success: true, ...data }` or `{ success: false, error: string }`.
 *
 * IMPORTANT: returns a STABLE object reference (memoized) so consumers can safely
 * use the whole `api` object in useEffect deps without infinite re-renders.
 */
export function useV2Api() {
  const request = useCallback(async (url, options = {}) => {
    try {
      const res = await fetch(url, {
        headers: { 'Content-Type': 'application/json' },
        ...options
      });
      return await res.json();
    } catch (err) {
      return { success: false, error: err.message };
    }
  }, []);

  // ── Strategies ──
  const listStrategies = useCallback(async ({ family, style, source, backtestableOnly } = {}) => {
    const qs = new URLSearchParams();
    if (family) qs.set('family', family);
    if (style) qs.set('style', style);
    if (source) qs.set('source', source);
    if (backtestableOnly) qs.set('backtestableOnly', 'true');
    return request(`/api/v2/strategies${qs.toString() ? '?' + qs : ''}`);
  }, [request]);

  const getStrategy = useCallback(async (code) => {
    return request(`/api/v2/strategies/${encodeURIComponent(code)}`);
  }, [request]);

  const getStrategyPine = useCallback(async (code) => {
    return request(`/api/v2/strategies/${encodeURIComponent(code)}/pine`);
  }, [request]);

  // ── Analyze (single strategy × single symbol) ──
  const analyze = useCallback(async ({ code, symbol, timeframe = '1D', mode = 'backtest', params, lookbackDays }) => {
    return request('/api/v2/analyze', {
      method: 'POST',
      body: JSON.stringify({ code, symbol, timeframe, mode, params, lookbackDays })
    });
  }, [request]);

  // ── Scan (matrix) ──
  const scan = useCallback(async ({ jobs, mode = 'live', concurrency = 8 }) => {
    return request('/api/v2/scan', {
      method: 'POST',
      body: JSON.stringify({ jobs, mode, concurrency })
    });
  }, [request]);

  const scanSymbolAll = useCallback(async ({ symbol, timeframe = '1D', mode = 'live', concurrency = 8 }) => {
    return request('/api/v2/scan/symbol-all', {
      method: 'POST',
      body: JSON.stringify({ symbol, timeframe, mode, concurrency })
    });
  }, [request]);

  const scanStrategyAll = useCallback(async ({ code, symbols, timeframe = '1D', mode = 'live', concurrency = 8 }) => {
    return request('/api/v2/scan/strategy-all', {
      method: 'POST',
      body: JSON.stringify({ code, symbols, timeframe, mode, concurrency })
    });
  }, [request]);

  // ── Rank (AI Meta-Layer) ──
  // Accepts either:
  //   { results: [...], opts?, actionableOnly?, topNPerSymbol?, limit? }   — rank pre-fetched results
  //   { jobs: [...], mode?, concurrency?, opts?, ... }                     — inline scan + rank
  const rank = useCallback(async (payload) => {
    return request('/api/v2/rank', {
      method: 'POST',
      body: JSON.stringify(payload)
    });
  }, [request]);

  // ── Symbols & data ──
  const searchSymbols = useCallback(async (q, limit = 10) => {
    if (!q?.trim()) return { success: true, matches: [] };
    return request(`/api/v2/symbols/search?q=${encodeURIComponent(q)}&limit=${limit}`);
  }, [request]);

  const getOhlcv = useCallback(async ({ symbol, timeframe = '1D', days = 365 }) => {
    return request(`/api/v2/data/ohlcv?symbol=${encodeURIComponent(symbol)}&timeframe=${encodeURIComponent(timeframe)}&days=${days}`);
  }, [request]);

  // ── Health ──
  const health = useCallback(async () => request('/api/v2/health'), [request]);

  // ── TV Strategy Tester (Phase 7) ──
  const tvAnalyze = useCallback(async ({ code, symbol, timeframe, dateFrom, dateTo }) => {
    return request('/api/v2/tv/analyze', {
      method: 'POST',
      body: JSON.stringify({ code, symbol, timeframe, dateFrom, dateTo }),
    });
  }, [request]);

  const tvStatus = useCallback(async () => request('/api/v2/tv/status'), [request]);

  /**
   * Stream a TV bulk-scan via SSE. Returns an EventSource-like controller.
   *   onEvent({ event, data })  — fired for start/progress/result/error/done
   *   returns { close() } so callers can abort.
   *
   * Cells must already be primitive objects (code, symbol, timeframe, dateFrom?, dateTo?).
   */
  const tvScanStream = useCallback((cells, onEvent) => {
    const controller = new AbortController();
    (async () => {
      try {
        const res = await fetch('/api/v2/tv/scan', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ cells }),
          signal: controller.signal,
        });
        if (!res.body) throw new Error('tv/scan: no response body');
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = '';
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          // Split on SSE event delimiter
          let idx;
          while ((idx = buf.indexOf('\n\n')) !== -1) {
            const chunk = buf.slice(0, idx);
            buf = buf.slice(idx + 2);
            let eventName = 'message';
            let dataStr = '';
            for (const line of chunk.split('\n')) {
              if (line.startsWith('event:')) eventName = line.slice(6).trim();
              else if (line.startsWith('data:')) dataStr += line.slice(5).trim();
            }
            if (dataStr) {
              let parsed = null;
              try { parsed = JSON.parse(dataStr); } catch { /* ignore parse error */ }
              if (parsed) onEvent?.({ event: eventName, data: parsed });
            }
          }
        }
      } catch (err) {
        if (err.name !== 'AbortError') onEvent?.({ event: 'error', data: { error: err.message } });
      }
    })();
    return { close: () => controller.abort() };
  }, []);

  // ── Multi-window matrix (Phase 8) ──
  const matrixScan = useCallback(async ({ cells, provider = 'js', windows, costProfile, concurrency } = {}) => {
    return request('/api/v2/matrix/scan', {
      method: 'POST',
      body: JSON.stringify({ cells, provider, windows, costProfile, concurrency }),
    });
  }, [request]);

  const matrixRank = useCallback(async (payload) => {
    return request('/api/v2/matrix/rank', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  }, [request]);

  const matrixCostStress = useCallback(async ({ code, symbol, timeframe, windows }) => {
    return request('/api/v2/matrix/cost-stress', {
      method: 'POST',
      body: JSON.stringify({ code, symbol, timeframe, windows }),
    });
  }, [request]);

  // ── Phase 8.7 — HFT mode-aware matrix ──
  const matrixModesRank = useCallback(async (payload) => {
    return request('/api/v2/matrix/modes/rank', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  }, [request]);

  const matrixModesProfiles = useCallback(async () => {
    return request('/api/v2/matrix/modes/profiles');
  }, [request]);

  const matrixModesGenai = useCallback(async (payload) => {
    return request('/api/v2/matrix/modes/genai', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  }, [request]);

  // ── Multi-timeframe confluence ──
  const confluence = useCallback(async ({ code, symbol, timeframes, params }) => {
    return request('/api/v2/confluence', {
      method: 'POST',
      body: JSON.stringify({ code, symbol, timeframes, params }),
    });
  }, [request]);

  const confluenceBatch = useCallback(async ({ pairs, timeframes, params, concurrency }) => {
    return request('/api/v2/confluence/batch', {
      method: 'POST',
      body: JSON.stringify({ pairs, timeframes, params, concurrency }),
    });
  }, [request]);

  // STABLE object reference — only changes if any underlying callback changes (they don't,
  // since `request` is memoized with empty deps).
  return useMemo(() => ({
    listStrategies,
    getStrategy,
    getStrategyPine,
    analyze,
    scan,
    scanSymbolAll,
    scanStrategyAll,
    rank,
    searchSymbols,
    getOhlcv,
    health,
    // Phase 7 — TV runner
    tvAnalyze,
    tvStatus,
    tvScanStream,
    // Phase 8 — multi-window matrix + confluence
    matrixScan,
    matrixRank,
    matrixCostStress,
    matrixModesRank,
    matrixModesProfiles,
    matrixModesGenai,
    confluence,
    confluenceBatch,
  }), [
    listStrategies,
    getStrategy,
    getStrategyPine,
    analyze,
    scan,
    scanSymbolAll,
    scanStrategyAll,
    rank,
    searchSymbols,
    getOhlcv,
    health,
    tvAnalyze,
    tvStatus,
    tvScanStream,
    matrixScan,
    matrixRank,
    matrixCostStress,
    matrixModesRank,
    matrixModesProfiles,
    matrixModesGenai,
    confluence,
    confluenceBatch,
  ]);
}
