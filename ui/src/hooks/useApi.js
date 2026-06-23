import { useCallback, useMemo } from 'react';

export function useApi() {
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

  const startMonitoring = useCallback(async (config) => {
    return request('/api/start', {
      method: 'POST',
      body: JSON.stringify(config)
    });
  }, [request]);

  const symbolSearch = useCallback(async (query) => {
    if (!query || query.length < 1) return { success: true, results: [] };
    return request(`/api/symbol-search?q=${encodeURIComponent(query)}`);
  }, [request]);

  const stopMonitoring = useCallback(async () => {
    return request('/api/stop', { method: 'POST' });
  }, [request]);

  const monitorAnalyze = useCallback(async (symbol) => {
    return request('/api/monitor/analyze', {
      method: 'POST',
      body: JSON.stringify({ symbol })
    });
  }, [request]);

  const getStatus = useCallback(async () => {
    return request('/api/status');
  }, [request]);

  const getAlerts = useCallback(async () => {
    return request('/api/alerts');
  }, [request]);

  const createPriceAlert = useCallback(async (alert) => {
    return request('/api/price-alerts', {
      method: 'POST',
      body: JSON.stringify(alert)
    });
  }, [request]);

  const deletePriceAlert = useCallback(async (id) => {
    return request(`/api/price-alerts/${id}`, { method: 'DELETE' });
  }, [request]);

  const getPriceAlerts = useCallback(async () => {
    return request('/api/price-alerts');
  }, [request]);

  const getWatchlist = useCallback(async () => {
    return request('/api/watchlist');
  }, [request]);

  const addToWatchlist = useCallback(async (symbol) => {
    return request('/api/watchlist', {
      method: 'POST',
      body: JSON.stringify({ symbol })
    });
  }, [request]);

  const addManyToWatchlist = useCallback(async (symbols) => {
    return request('/api/watchlist/bulk', {
      method: 'POST',
      body: JSON.stringify({ symbols })
    });
  }, [request]);

  const removeFromWatchlist = useCallback(async (symbol) => {
    return request(`/api/watchlist/${encodeURIComponent(symbol)}`, { method: 'DELETE' });
  }, [request]);

  const getRecommendation = useCallback(async (symbol) => {
    return request(`/api/recommendation/${encodeURIComponent(symbol)}`);
  }, [request]);

  const startScanner = useCallback(async (interval = 120000, symbols = [], strategyOverrides = {}) => {
    return request('/api/scanner/start', {
      method: 'POST',
      body: JSON.stringify({ interval, symbols, strategyOverrides })
    });
  }, [request]);

  const stopScanner = useCallback(async () => {
    return request('/api/scanner/stop', { method: 'POST' });
  }, [request]);

  const getScannerStatus = useCallback(async () => {
    return request('/api/scanner/status');
  }, [request]);

  const getScannerResults = useCallback(async () => {
    return request('/api/scanner/results');
  }, [request]);

  const getStrategies = useCallback(async () => {
    return request('/api/strategies');
  }, [request]);

  const getSettings = useCallback(async () => {
    return request('/api/settings');
  }, [request]);

  const updateSettings = useCallback(async (settings) => {
    return request('/api/settings', {
      method: 'POST',
      body: JSON.stringify(settings)
    });
  }, [request]);

  const refreshTipsSource = useCallback(async () => {
    return request('/api/scanner/tips-source/refresh', { method: 'POST' });
  }, [request]);

  const getTipsSourceSymbols = useCallback(async () => {
    return request('/api/scanner/tips-source/symbols');
  }, [request]);

  const startMatrixScanner = useCallback(async (opts) => {
    return request('/api/scanner/matrix/start', {
      method: 'POST',
      body: JSON.stringify(opts)
    });
  }, [request]);

  const stopMatrixScanner = useCallback(async () => {
    return request('/api/scanner/matrix/stop', { method: 'POST' });
  }, [request]);

  const getMatrixScannerStatus = useCallback(async () => {
    return request('/api/scanner/matrix/status');
  }, [request]);

  const getMatrixScannerResults = useCallback(async () => {
    return request('/api/scanner/matrix/results');
  }, [request]);

  const clearAlerts = useCallback(async () => {
    return request('/api/alerts/clear', { method: 'POST' });
  }, [request]);

  const clearTrades = useCallback(async () => {
    return request('/api/trades/clear', { method: 'POST' });
  }, [request]);

  // STABLE object reference — safe to use whole `api` object in useEffect deps.
  return useMemo(() => ({
    startMonitoring,
    stopMonitoring,
    monitorAnalyze,
    symbolSearch,
    getStatus,
    getAlerts,
    createPriceAlert,
    deletePriceAlert,
    getPriceAlerts,
    getWatchlist,
    addToWatchlist,
    addManyToWatchlist,
    removeFromWatchlist,
    getRecommendation,
    startScanner,
    stopScanner,
    getScannerStatus,
    getScannerResults,
    getStrategies,
    getSettings,
    updateSettings,
    refreshTipsSource,
    getTipsSourceSymbols,
    startMatrixScanner,
    stopMatrixScanner,
    getMatrixScannerStatus,
    getMatrixScannerResults,
    clearAlerts,
    clearTrades
  }), [
    startMonitoring,
    stopMonitoring,
    monitorAnalyze,
    symbolSearch,
    getStatus,
    getAlerts,
    createPriceAlert,
    deletePriceAlert,
    getPriceAlerts,
    getWatchlist,
    addToWatchlist,
    addManyToWatchlist,
    removeFromWatchlist,
    getRecommendation,
    startScanner,
    stopScanner,
    getScannerStatus,
    getScannerResults,
    getStrategies,
    getSettings,
    updateSettings,
    refreshTipsSource,
    getTipsSourceSymbols,
    startMatrixScanner,
    stopMatrixScanner,
    getMatrixScannerStatus,
    getMatrixScannerResults,
    clearAlerts,
    clearTrades
  ]);
}
