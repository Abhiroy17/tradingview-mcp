-- TradingView MCP — Performance Matrix Schema
-- Idempotent: safe to run multiple times.
--
-- Compatible with Postgres 14+ (Supabase, Neon, local).

-- ─────────────────────────────────────────────────────────────────────
-- Lookup tables (small, mostly-static)
-- ─────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS symbols (
  id            SERIAL PRIMARY KEY,
  canonical     TEXT NOT NULL UNIQUE,       -- e.g. 'NSE:RELIANCE', 'AAPL'
  exchange      TEXT,                       -- 'NSE', 'BSE', 'NASDAQ', 'NYSE', ...
  ticker        TEXT NOT NULL,
  asset_class   TEXT,                       -- 'equity', 'etf', 'futures', 'crypto', ...
  sector        TEXT,
  industry      TEXT,
  name          TEXT,
  market_cap    NUMERIC(20,2),             -- raw value in INR
  price         NUMERIC(18,6),
  active        BOOLEAN NOT NULL DEFAULT TRUE,
  updated_at    TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_symbols_exchange ON symbols(exchange);
CREATE INDEX IF NOT EXISTS idx_symbols_active   ON symbols(active);
CREATE INDEX IF NOT EXISTS idx_symbols_sector   ON symbols(sector);
CREATE INDEX IF NOT EXISTS idx_symbols_sector_active ON symbols(sector, active) WHERE active = TRUE;

CREATE TABLE IF NOT EXISTS strategies (
  id            SERIAL PRIMARY KEY,
  code          TEXT NOT NULL UNIQUE,       -- e.g. 'rsi2', 'ibs_india_tuned'
  name          TEXT NOT NULL,
  family        TEXT,                       -- 'mean_reversion', 'trend_following', 'breakout', ...
  style         TEXT,                       -- 'intraday', 'swing', 'positional'
  backtestable  BOOLEAN NOT NULL DEFAULT TRUE,
  description   TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS timeframes (
  id   SERIAL PRIMARY KEY,
  code TEXT NOT NULL UNIQUE              -- '1m', '5m', '15m', '30m', '1h', '4h', '1D', '1W', '1M'
);

CREATE TABLE IF NOT EXISTS regimes (
  id   SERIAL PRIMARY KEY,
  code TEXT NOT NULL UNIQUE              -- 'trending_up', 'trending_down', 'ranging', 'squeeze', 'volatile'
);

-- Seed lookups
INSERT INTO timeframes (code) VALUES
  ('1m'),('5m'),('15m'),('30m'),('1h'),('4h'),('1D'),('1W'),('1M')
ON CONFLICT (code) DO NOTHING;

INSERT INTO regimes (code) VALUES
  ('trending_up'),('trending_down'),('ranging'),('squeeze'),('volatile'),('unknown')
ON CONFLICT (code) DO NOTHING;

-- ─────────────────────────────────────────────────────────────────────
-- Backtest runs — one row per (symbol, strategy, timeframe, params, window)
-- ─────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS backtest_runs (
  id               BIGSERIAL PRIMARY KEY,
  symbol_id        INTEGER NOT NULL REFERENCES symbols(id) ON DELETE CASCADE,
  strategy_id      INTEGER NOT NULL REFERENCES strategies(id) ON DELETE CASCADE,
  timeframe_id     INTEGER NOT NULL REFERENCES timeframes(id),
  params_hash      TEXT NOT NULL,          -- sha1 of JSON-canonical params
  params_json      JSONB NOT NULL,
  date_from        DATE NOT NULL,
  date_to          DATE NOT NULL,
  sample_size      INTEGER NOT NULL,       -- number of bars used
  provider         TEXT NOT NULL,          -- 'upstox' | 'yahoo' | 'cdp' | 'tv_strategy_tester'
  window_label     TEXT NOT NULL DEFAULT 'all',  -- '1y' | '6m' | '3m' | '1m' | 'oos' | 'all' (Phase 8 multi-window)
  computed_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (symbol_id, strategy_id, timeframe_id, params_hash, date_to, window_label)
);
CREATE INDEX IF NOT EXISTS idx_runs_symbol_strat   ON backtest_runs(symbol_id, strategy_id);
CREATE INDEX IF NOT EXISTS idx_runs_computed_at    ON backtest_runs(computed_at DESC);
CREATE INDEX IF NOT EXISTS idx_runs_tf_strat       ON backtest_runs(timeframe_id, strategy_id);
CREATE INDEX IF NOT EXISTS idx_runs_window         ON backtest_runs(window_label);

-- ─────────────────────────────────────────────────────────────────────
-- Migration: add window_label to existing databases (Phase 8 multi-window)
-- Idempotent: ALTER...IF NOT EXISTS + dynamic constraint swap.
-- ─────────────────────────────────────────────────────────────────────
ALTER TABLE backtest_runs ADD COLUMN IF NOT EXISTS window_label TEXT;
UPDATE backtest_runs SET window_label = 'all' WHERE window_label IS NULL;
ALTER TABLE backtest_runs ALTER COLUMN window_label SET NOT NULL;
ALTER TABLE backtest_runs ALTER COLUMN window_label SET DEFAULT 'all';

DO $$
DECLARE c_name TEXT;
BEGIN
  -- Drop the legacy 5-column unique constraint if present, regardless of name.
  SELECT con.conname INTO c_name
    FROM pg_constraint con
    JOIN pg_class rel ON rel.oid = con.conrelid
   WHERE rel.relname = 'backtest_runs'
     AND con.contype = 'u'
     AND array_length(con.conkey, 1) = 5
   LIMIT 1;
  IF c_name IS NOT NULL THEN
    EXECUTE 'ALTER TABLE backtest_runs DROP CONSTRAINT ' || quote_ident(c_name);
  END IF;

  -- Ensure the new 6-column unique exists with a stable name.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'backtest_runs_unique_window'
       AND conrelid = 'backtest_runs'::regclass
  ) THEN
    ALTER TABLE backtest_runs
      ADD CONSTRAINT backtest_runs_unique_window
      UNIQUE (symbol_id, strategy_id, timeframe_id, params_hash, date_to, window_label);
  END IF;
END $$;

-- ─────────────────────────────────────────────────────────────────────
-- Aggregate metrics — 1:1 with backtest_runs
-- ─────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS backtest_metrics (
  run_id            BIGINT PRIMARY KEY REFERENCES backtest_runs(id) ON DELETE CASCADE,
  total_trades      INTEGER NOT NULL,
  wins              INTEGER NOT NULL,
  losses            INTEGER NOT NULL,
  win_rate          NUMERIC(8,4),         -- %, e.g. 64.5000
  profit_factor     NUMERIC(10,4),        -- sum(wins)/sum(losses)
  total_pnl_pct     NUMERIC(12,4),        -- cumulative %
  avg_win_pct       NUMERIC(10,4),
  avg_loss_pct      NUMERIC(10,4),
  max_dd_pct        NUMERIC(10,4),
  expectancy        NUMERIC(10,4),
  sharpe            NUMERIC(10,4),
  sortino           NUMERIC(10,4),
  calmar            NUMERIC(10,4),
  ulcer             NUMERIC(10,4),
  wilson_lb         NUMERIC(8,4),         -- 95% lower bound of win-rate
  psr               NUMERIC(8,4),         -- probabilistic Sharpe ratio
  deflated_sharpe   NUMERIC(10,4),        -- corrected for selection bias
  bootstrap_lo      NUMERIC(10,4),        -- 95% lower bound of total_pnl_pct
  bootstrap_hi      NUMERIC(10,4),
  oos_trades        INTEGER,              -- out-of-sample (last 30% of window)
  oos_win_rate      NUMERIC(8,4),
  oos_pf            NUMERIC(10,4),
  avg_hold_bars     NUMERIC(8,2)
);

-- ─────────────────────────────────────────────────────────────────────
-- Per-regime breakdown — many rows per run
-- ─────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS regime_metrics (
  run_id        BIGINT NOT NULL REFERENCES backtest_runs(id) ON DELETE CASCADE,
  regime_id     INTEGER NOT NULL REFERENCES regimes(id),
  trades        INTEGER NOT NULL,
  wins          INTEGER NOT NULL,
  win_rate      NUMERIC(8,4),
  avg_pnl_pct   NUMERIC(10,4),
  profit_factor NUMERIC(10,4),
  PRIMARY KEY (run_id, regime_id)
);

-- ─────────────────────────────────────────────────────────────────────
-- Equity curve — compacted to ~200 points per run
-- ─────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS equity_curve (
  run_id     BIGINT PRIMARY KEY REFERENCES backtest_runs(id) ON DELETE CASCADE,
  points     JSONB NOT NULL              -- [{ t: <unix_sec>, e: <equity_%> }, ...]
);

-- ─────────────────────────────────────────────────────────────────────
-- Trade log — last 100 trades per run (cap to keep DB lean)
-- ─────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS trade_log (
  run_id        BIGINT NOT NULL REFERENCES backtest_runs(id) ON DELETE CASCADE,
  idx           INTEGER NOT NULL,
  entry_ts      TIMESTAMPTZ NOT NULL,
  exit_ts       TIMESTAMPTZ NOT NULL,
  entry_px      NUMERIC(18,6),
  exit_px       NUMERIC(18,6),
  pnl_pct       NUMERIC(10,4),
  bars_held     INTEGER,
  exit_reason   TEXT,
  regime_id     INTEGER REFERENCES regimes(id),
  PRIMARY KEY (run_id, idx)
);
CREATE INDEX IF NOT EXISTS idx_trades_run ON trade_log(run_id);

-- ─────────────────────────────────────────────────────────────────────
-- Migration tracking — used by migrate.js to record applied scripts.
-- The runner uses this to make the very-first-time bootstrap idempotent.
-- ─────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS schema_migrations (
  version    TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
INSERT INTO schema_migrations (version) VALUES ('2026_06_17_initial')
ON CONFLICT (version) DO NOTHING;
INSERT INTO schema_migrations (version) VALUES ('2026_07_window_label')
ON CONFLICT (version) DO NOTHING;

-- ─────────────────────────────────────────────────────────────────────
-- Migration: symbols enrichment (sector screening performance)
-- ─────────────────────────────────────────────────────────────────────
ALTER TABLE symbols ADD COLUMN IF NOT EXISTS industry TEXT;
ALTER TABLE symbols ADD COLUMN IF NOT EXISTS name TEXT;
ALTER TABLE symbols ADD COLUMN IF NOT EXISTS market_cap NUMERIC(20,2);
ALTER TABLE symbols ADD COLUMN IF NOT EXISTS price NUMERIC(18,6);
ALTER TABLE symbols ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_symbols_sector ON symbols(sector);
CREATE INDEX IF NOT EXISTS idx_symbols_sector_active ON symbols(sector, active) WHERE active = TRUE;

INSERT INTO schema_migrations (version) VALUES ('2026_07_symbols_enrich')
ON CONFLICT (version) DO NOTHING;

-- ─────────────────────────────────────────────────────────────────────
-- Migration: symbols fundamentals columns (pre-filter without Yahoo API)
-- Stores key screening metrics so the screener can eliminate stocks early
-- via a single DB query, avoiding expensive Yahoo calls for ineligible symbols.
-- ─────────────────────────────────────────────────────────────────────

-- Valuation
ALTER TABLE symbols ADD COLUMN IF NOT EXISTS pe NUMERIC(10,2);
ALTER TABLE symbols ADD COLUMN IF NOT EXISTS pb NUMERIC(10,2);
ALTER TABLE symbols ADD COLUMN IF NOT EXISTS peg NUMERIC(10,2);
ALTER TABLE symbols ADD COLUMN IF NOT EXISTS ev_to_ebitda NUMERIC(10,2);

-- Profitability
ALTER TABLE symbols ADD COLUMN IF NOT EXISTS roe NUMERIC(8,2);
ALTER TABLE symbols ADD COLUMN IF NOT EXISTS roce NUMERIC(8,2);
ALTER TABLE symbols ADD COLUMN IF NOT EXISTS operating_margin NUMERIC(8,2);
ALTER TABLE symbols ADD COLUMN IF NOT EXISTS net_margin NUMERIC(8,2);

-- Growth
ALTER TABLE symbols ADD COLUMN IF NOT EXISTS revenue_cagr_3y NUMERIC(8,2);
ALTER TABLE symbols ADD COLUMN IF NOT EXISTS eps_cagr_3y NUMERIC(8,2);
ALTER TABLE symbols ADD COLUMN IF NOT EXISTS revenue_growth_qoq NUMERIC(8,2);
ALTER TABLE symbols ADD COLUMN IF NOT EXISTS eps_growth_yoy NUMERIC(8,2);

-- Balance sheet
ALTER TABLE symbols ADD COLUMN IF NOT EXISTS debt_to_equity NUMERIC(8,2);
ALTER TABLE symbols ADD COLUMN IF NOT EXISTS current_ratio NUMERIC(8,2);
ALTER TABLE symbols ADD COLUMN IF NOT EXISTS interest_coverage NUMERIC(10,2);

-- Ownership
ALTER TABLE symbols ADD COLUMN IF NOT EXISTS promoter_holding NUMERIC(7,2);
ALTER TABLE symbols ADD COLUMN IF NOT EXISTS fii_holding NUMERIC(7,2);
ALTER TABLE symbols ADD COLUMN IF NOT EXISTS dii_holding NUMERIC(7,2);

-- Misc
ALTER TABLE symbols ADD COLUMN IF NOT EXISTS fifty_two_week_high NUMERIC(18,6);
ALTER TABLE symbols ADD COLUMN IF NOT EXISTS fifty_two_week_low NUMERIC(18,6);
ALTER TABLE symbols ADD COLUMN IF NOT EXISTS free_cashflow NUMERIC(20,2);
ALTER TABLE symbols ADD COLUMN IF NOT EXISTS data_refreshed_at TIMESTAMPTZ;

-- Indexes for common filter queries
CREATE INDEX IF NOT EXISTS idx_symbols_market_cap ON symbols(market_cap DESC) WHERE active = TRUE;
CREATE INDEX IF NOT EXISTS idx_symbols_industry ON symbols(industry) WHERE active = TRUE;
CREATE INDEX IF NOT EXISTS idx_symbols_roe ON symbols(roe DESC NULLS LAST) WHERE active = TRUE;
CREATE INDEX IF NOT EXISTS idx_symbols_de ON symbols(debt_to_equity) WHERE active = TRUE AND debt_to_equity IS NOT NULL;

INSERT INTO schema_migrations (version) VALUES ('2026_07_symbols_fundamentals')
ON CONFLICT (version) DO NOTHING;

-- ─────────────────────────────────────────────────────────────────────
-- Watchlist — user-curated symbols, unique per symbol
-- ─────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS watchlist (
  id            SERIAL PRIMARY KEY,
  symbol        TEXT NOT NULL UNIQUE,       -- 'NSE:RELIANCE'
  source        TEXT DEFAULT 'manual',      -- 'manual' | 'munafasutra' | 'multibagger'
  price         NUMERIC(18,6),
  change_pct    NUMERIC(10,4),
  signal        TEXT,                       -- last signal type
  optimal_strategy TEXT,
  multibagger_score NUMERIC(8,2),
  added_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_watchlist_source ON watchlist(source);

-- ─────────────────────────────────────────────────────────────────────
-- Munafa scan results — daily tips, purged before each new scan
-- ─────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS munafa_scans (
  id            SERIAL PRIMARY KEY,
  symbol        TEXT NOT NULL,
  scan_date     DATE NOT NULL DEFAULT CURRENT_DATE,
  endpoint_url  TEXT,                       -- which munafa URL produced this
  price         NUMERIC(18,6),
  multibagger_score NUMERIC(8,2),           -- scored after scan
  auto_watchlisted BOOLEAN DEFAULT FALSE,   -- true if auto-added to watchlist
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (symbol, scan_date)
);
CREATE INDEX IF NOT EXISTS idx_munafa_scan_date ON munafa_scans(scan_date);
CREATE INDEX IF NOT EXISTS idx_munafa_symbol ON munafa_scans(symbol);

INSERT INTO schema_migrations (version) VALUES ('2026_07_watchlist_munafa')
ON CONFLICT (version) DO NOTHING;

-- ─────────────────────────────────────────────────────────────────────
-- Convenience views for ranking queries
-- ─────────────────────────────────────────────────────────────────────

-- Latest run per (symbol, strategy, timeframe, window_label)
CREATE OR REPLACE VIEW v_latest_runs AS
SELECT DISTINCT ON (r.symbol_id, r.strategy_id, r.timeframe_id, r.window_label)
  r.id AS run_id,
  r.symbol_id, r.strategy_id, r.timeframe_id, r.window_label,
  r.computed_at, r.date_from, r.date_to, r.sample_size, r.provider, r.params_hash
FROM backtest_runs r
ORDER BY r.symbol_id, r.strategy_id, r.timeframe_id, r.window_label, r.computed_at DESC;

-- Ranked metrics — latest run only, with joined codes for easy reading
CREATE OR REPLACE VIEW v_ranked_metrics AS
SELECT
  sym.canonical                       AS symbol,
  strat.code                          AS strategy,
  tf.code                             AS timeframe,
  lr.window_label                     AS window_label,
  m.profit_factor,
  m.win_rate,
  m.sharpe,
  m.psr,
  m.max_dd_pct,
  m.total_trades,
  m.deflated_sharpe,
  lr.computed_at,
  lr.run_id
FROM v_latest_runs lr
JOIN backtest_metrics m ON m.run_id = lr.run_id
JOIN symbols      sym   ON sym.id   = lr.symbol_id
JOIN strategies   strat ON strat.id = lr.strategy_id
JOIN timeframes   tf    ON tf.id    = lr.timeframe_id;

-- ─────────────────────────────────────────────────────────────────────
-- Ownership / shareholding pattern — one row per (symbol, quarter)
-- Sources: NSE corporate shareholding pattern (official) + optional
-- Trendlyne enrichment (HNI). Percentages are of total equity.
-- ─────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS stock_shareholding (
  id                SERIAL PRIMARY KEY,
  symbol            TEXT NOT NULL,               -- canonical 'NSE:TICKER'
  quarter           DATE NOT NULL,               -- period-end date (e.g. 2026-06-30)
  -- Holding percentages
  promoter          NUMERIC(7,4),
  fii               NUMERIC(7,4),                -- foreign institutional / FPI
  dii               NUMERIC(7,4),                -- domestic institutional
  mutual_fund       NUMERIC(7,4),
  insurance         NUMERIC(7,4),
  hni               NUMERIC(7,4),                -- high net-worth individuals
  retail            NUMERIC(7,4),                -- small/public shareholders
  govt              NUMERIC(7,4),
  foreign_individual NUMERIC(7,4),
  others            NUMERIC(7,4),
  pledged_pct       NUMERIC(7,4),                -- promoter pledge %
  -- Quarter-over-quarter changes (percentage points)
  promoter_change   NUMERIC(7,4),
  fii_change        NUMERIC(7,4),
  dii_change        NUMERIC(7,4),
  mf_change         NUMERIC(7,4),
  insurance_change  NUMERIC(7,4),
  hni_change        NUMERIC(7,4),
  retail_change     NUMERIC(7,4),
  -- Derived ownership scores (0-100)
  smart_money_score            NUMERIC(6,2),
  institutional_accum_score    NUMERIC(6,2),
  promoter_confidence_score    NUMERIC(6,2),
  -- Top holders + fund churn (JSONB)
  top_buyers        JSONB,                       -- [{name, pct, changePct}]
  top_sellers       JSONB,
  funds_entered     JSONB,                       -- [name] new MFs this quarter
  funds_exited      JSONB,                       -- [name] MFs that exited
  source            TEXT,                        -- 'nse' | 'trendlyne' | 'merged'
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (symbol, quarter)
);
CREATE INDEX IF NOT EXISTS idx_shareholding_symbol  ON stock_shareholding(symbol);
CREATE INDEX IF NOT EXISTS idx_shareholding_quarter ON stock_shareholding(quarter DESC);

-- ─────────────────────────────────────────────────────────────────────
-- AMFI mutual-fund portfolio holdings — reverse index (symbol -> funds)
-- Parsed from AMFI monthly portfolio disclosures once, queried by symbol.
-- ─────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS mf_portfolio_holdings (
  id                SERIAL PRIMARY KEY,
  symbol            TEXT NOT NULL,               -- canonical 'NSE:TICKER'
  period            DATE NOT NULL,               -- disclosure month-end
  fund_house        TEXT,                        -- AMC name
  scheme_name       TEXT NOT NULL,
  holding_value_cr  NUMERIC(18,4),               -- market value held (₹ Cr)
  pct_of_portfolio  NUMERIC(7,4),                -- % of that scheme's AUM
  pct_of_company    NUMERIC(7,4),                -- % of company's equity (if derivable)
  source            TEXT DEFAULT 'amfi',
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (symbol, period, scheme_name)
);
CREATE INDEX IF NOT EXISTS idx_mfholdings_symbol ON mf_portfolio_holdings(symbol);
CREATE INDEX IF NOT EXISTS idx_mfholdings_period ON mf_portfolio_holdings(period DESC);
CREATE INDEX IF NOT EXISTS idx_mfholdings_symbol_period ON mf_portfolio_holdings(symbol, period DESC);

-- ─────────────────────────────────────────────────────────────────────
-- News cache — stock-specific + sector news (Google News RSS)
-- ─────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS news_cache (
  id            SERIAL PRIMARY KEY,
  symbol        TEXT,                            -- canonical symbol, or NULL for sector-level
  sector        TEXT,                            -- populated for sector news
  scope         TEXT NOT NULL DEFAULT 'stock',   -- 'stock' | 'sector'
  title         TEXT NOT NULL,
  link          TEXT NOT NULL,
  source_name   TEXT,
  published_at  TIMESTAMPTZ,
  guid          TEXT NOT NULL,                   -- dedupe key (link hash)
  fetched_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (guid)
);
CREATE INDEX IF NOT EXISTS idx_news_symbol    ON news_cache(symbol, published_at DESC);
CREATE INDEX IF NOT EXISTS idx_news_sector    ON news_cache(sector, published_at DESC);
CREATE INDEX IF NOT EXISTS idx_news_published ON news_cache(published_at DESC);

INSERT INTO schema_migrations (version) VALUES ('2026_07_ownership_news')
ON CONFLICT (version) DO NOTHING;
