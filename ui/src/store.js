import { create } from 'zustand';

// Zustand store — persists state across tab switches (component unmounts)
export const useStore = create((set, get) => ({
  // ── Control Panel ──
  cp_symbol: '',
  cp_exchange: 'NSE',
  cp_interval: 30000,
  cp_selectedStrategies: ['ibs'],

  setCpSymbol: (v) => set({ cp_symbol: v, cp_selectedStrategies: ['ibs'] }),
  setCpExchange: (v) => set({ cp_exchange: v }),
  setCpInterval: (v) => set({ cp_interval: v }),
  setCpSelectedStrategies: (v) => set({ cp_selectedStrategies: typeof v === 'function' ? v(get().cp_selectedStrategies) : v }),

  // ── Pine Lab ──
  pl_analysis: null,
  pl_selectedTemplate: null,
  pl_generatedCode: '',
  pl_backtest: null,
  pl_autoMode: false,
  pl_showAllRankings: false,
  pl_deployStatus: null,
  pl_backtestTimeframe: '', // '' = use chart's current TF

  setPlAnalysis: (v) => set({ pl_analysis: v }),
  setPlSelectedTemplate: (v) => set({ pl_selectedTemplate: v }),
  setPlGeneratedCode: (v) => set({ pl_generatedCode: v }),
  setPlBacktest: (v) => set({ pl_backtest: v }),
  setPlAutoMode: (v) => set({ pl_autoMode: v }),
  setPlShowAllRankings: (v) => set({ pl_showAllRankings: v }),
  setPlDeployStatus: (v) => set({ pl_deployStatus: v }),
  setPlBacktestTimeframe: (v) => set({ pl_backtestTimeframe: v }),

  // ── Pine Lab v2 (symbol-aware) ──
  pl_symbol: 'AAPL',
  pl_timeframe: '1D',
  pl_lookbackDays: 730,
  pl_scanMode: 'single',        // 'single' | 'symbol_all' | 'strategy_all' | 'custom'
  pl_engineMode: 'backtest',    // 'backtest' | 'live'
  pl_primaryStrategy: 'rsi2_india_swing',
  pl_multiStrategies: [],
  pl_multiSymbols: [],

  setPlSymbol: (v) => set({ pl_symbol: v }),
  setPlTimeframe: (v) => set({ pl_timeframe: v }),
  setPlLookbackDays: (v) => set({ pl_lookbackDays: v }),
  setPlScanMode: (v) => set({ pl_scanMode: v }),
  setPlEngineMode: (v) => set({ pl_engineMode: v }),
  setPlPrimaryStrategy: (v) => set({ pl_primaryStrategy: v }),
  setPlMultiStrategies: (v) => set({ pl_multiStrategies: typeof v === 'function' ? v(get().pl_multiStrategies) : v }),
  setPlMultiSymbols: (v) => set({ pl_multiSymbols: typeof v === 'function' ? v(get().pl_multiSymbols) : v }),

  // ── Watchlist / Scanner ──
  wl_watchlist: [],          // persisted symbol list [{symbol, price, change, ...}]
  wl_selectedSymbols: [],
  wl_selectAll: false,
  wl_scanResults: {},
  wl_scanning: false,
  wl_scanInterval: 120000,
  wl_strategyOverrides: {}, // { symbol: strategyId } — per-symbol strategy override ('auto' or strategy key)

  setWlWatchlist: (v) => set({ wl_watchlist: typeof v === 'function' ? v(get().wl_watchlist) : v }),
  setWlSelectedSymbols: (v) => set({ wl_selectedSymbols: typeof v === 'function' ? v(get().wl_selectedSymbols) : v }),
  setWlSelectAll: (v) => set({ wl_selectAll: v }),
  setWlScanResults: (v) => set({ wl_scanResults: typeof v === 'function' ? v(get().wl_scanResults) : v }),
  setWlScanning: (v) => set({ wl_scanning: v }),
  setWlScanInterval: (v) => set({ wl_scanInterval: v }),
  setWlStrategyOverride: (symbol, strategyId) => set({ wl_strategyOverrides: { ...get().wl_strategyOverrides, [symbol]: strategyId } }),
  clearWlStrategyOverrides: () => set({ wl_strategyOverrides: {} }),

  // ── Watchlist v2 (Quick Scan via /api/v2/rank) ──
  wl_v2Strategies: ['rsi2_india_swing', 'ibs_india_swing', 'fibonacci_india_swing'],
  wl_v2Timeframe: '1D',
  wl_v2Mode: 'backtest',
  setWlV2Strategies: (v) => set({ wl_v2Strategies: typeof v === 'function' ? v(get().wl_v2Strategies) : v }),
  setWlV2Timeframe: (v) => set({ wl_v2Timeframe: v }),
  setWlV2Mode: (v) => set({ wl_v2Mode: v }),

  // ── Live Matrix Scanner (continuous N×M) ──
  wl_matrixScanning: false,
  wl_matrixResults: [],
  wl_matrixStrategies: [],
  wl_matrixTimeframe: '1D',
  wl_matrixInterval: 120000,
  wl_matrixMode: 'backtest',
  setWlMatrixScanning: (v) => set({ wl_matrixScanning: v }),
  setWlMatrixResults: (v) => set({ wl_matrixResults: typeof v === 'function' ? v(get().wl_matrixResults) : v }),
  setWlMatrixStrategies: (v) => set({ wl_matrixStrategies: typeof v === 'function' ? v(get().wl_matrixStrategies) : v }),
  setWlMatrixTimeframe: (v) => set({ wl_matrixTimeframe: v }),
  setWlMatrixInterval: (v) => set({ wl_matrixInterval: v }),
  setWlMatrixMode: (v) => set({ wl_matrixMode: v }),

  // ── Munafa Tips dropdown state ──
  wl_munafaOptions: [],
  wl_munafaSelected: [],
  wl_munafaLastFetchAt: null,
  setWlMunafaOptions: (v) => set({ wl_munafaOptions: typeof v === 'function' ? v(get().wl_munafaOptions) : v }),
  setWlMunafaSelected: (v) => set({ wl_munafaSelected: typeof v === 'function' ? v(get().wl_munafaSelected) : v }),
  setWlMunafaLastFetchAt: (v) => set({ wl_munafaLastFetchAt: v }),

  // ── AI Agent ──
  ai_symbol: '',
  ai_briefing: null,
  ai_error: '',
  ai_feed: [],
  ai_feedCursor: 0,

  setAiSymbol: (v) => set({ ai_symbol: v }),
  setAiBriefing: (v) => set({ ai_briefing: v, ai_error: '' }),
  setAiError: (v) => set({ ai_error: v }),
  setAiFeed: (events) => set({ ai_feed: [...get().ai_feed, ...events].slice(-100) }),
  setAiFeedCursor: (v) => set({ ai_feedCursor: v }),
  clearAiFeed: () => set({ ai_feed: [], ai_feedCursor: 0 }),
}));
