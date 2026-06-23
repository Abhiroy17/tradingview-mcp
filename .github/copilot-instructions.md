# TradingView MCP — GitHub Copilot Instructions

This workspace is a **TradingView MCP Bridge** that connects GitHub Copilot (in VS Code) to a locally running TradingView Desktop app via Chrome DevTools Protocol (CDP, port 9222).

## What This Project Does

- **80 MCP tools** for reading and controlling a live TradingView Desktop chart
- **React Dashboard UI** (http://localhost:3456) with live monitoring, alerts, multi-symbol scanner
- **CLI** (`tv` command) for quick chart interactions from terminal
- **Pine Script development** — write, compile, debug scripts with AI assistance
- **Backtesting engine** tuned for Indian (NSE/BSE) markets — walk-forward validation, multi-axis regime detection, India costs/session/slippage, futures shorting policy

## Strategy Roster (Phase H post-tuning)

**Production strategies** (2, registry: [src/engine/registry.js](src/engine/registry.js)):
- `trend_200sma_positional` — Trend follower (1D/1W, long-only). Tuned params: `fastLen=20, volMult=1.5, tp=25, sl=12`. Mid/small-cap +93-98%, large-cap +24%.
- `ema_rsi_intraday` — Triple-EMA stack + RSI exit (15m/1h, both). Tuned params: `rsiExitLong=70, volMult=1, tp=3.0, sl=1.5, maxBars=48`. Bank 9/10, IT 8/10, pharma 7/10 profitable.

**Experimental** (10): `rsi2_india_swing` (demoted Phase H), `fibonacci_india_swing` (demoted Phase H), `ibs_india_swing`, `ibs_india_intraday`, `overnight_swing`, `monday_reversal`, `ibs_mean_reversion`, `movingaverage_intraday`, `dual_movingaverage_intraday`, `supertrend_intraday`.

**Reference docs**:
- [docs/STRATEGIES.md](docs/STRATEGIES.md) — per-strategy rationale + Phase G validation
- [docs/INDIA-MARKET.md](docs/INDIA-MARKET.md) — NSE session, F&O expiry, costs, shorting

**Critical when working on strategies**:
1. **Pine is canonical**. Any param change must update both `pdf/{profitable|untested}/<code>.pine` AND `src/engine/strategies/<code>.js` AND `tunedParams` in `src/engine/registry.js`.
2. `tunedParams` are reference defaults from a single tuning run — production needs per-symbol calibration via `node scripts/tune-multi.js <code>`.
3. Trend strategies are portfolio rotation, not single-stock signals.
4. Regime gate (`execution.gateOnRegime: true`) is opt-in but recommended for mean-reversion.
5. After any strategy change, run `npm run test:engine` to verify registry consistency.

## Quick Start (for Copilot)

### 1. Launch TradingView with CDP
```bash
npm run launch:tv
```

### 2. Start the Dashboard (React UI + API)
```bash
npm run dashboard
```
Opens at http://localhost:3456 with live alerts, strategy monitoring, multi-symbol scanning.

### 3. MCP Tools (configured in `.vscode/mcp.json`)
VS Code will automatically discover the MCP server. Use the tools via Copilot chat.

## Decision Tree — Which Tool When

### "What's on my chart right now?"
1. `chart_get_state` → symbol, timeframe, chart type, all indicators with entity IDs
2. `data_get_study_values` → current numeric values from all visible indicators
3. `quote_get` → real-time price, OHLC, volume

### "What levels/lines/labels are showing?"
1. `data_get_pine_lines` → horizontal price levels from indicators (sorted high→low)
2. `data_get_pine_labels` → text annotations with prices
3. `data_get_pine_tables` → table data as rows
4. `data_get_pine_boxes` → price zones as {high, low} pairs

Use `study_filter` parameter to target a specific indicator.

### "Give me price data"
- `data_get_ohlcv` with `summary: true` → compact stats
- `data_get_ohlcv` without summary → all bars (use `count` to limit)
- `quote_get` → single latest price snapshot

### "Analyze my chart" (full workflow)
1. `quote_get` → current price
2. `data_get_study_values` → all indicator readings
3. `data_get_pine_lines` → key price levels
4. `data_get_pine_labels` → labeled levels
5. `data_get_pine_tables` → session stats
6. `data_get_ohlcv` with `summary: true` → price summary
7. `capture_screenshot` → visual confirmation

### "Change the chart"
- `chart_set_symbol` → switch ticker ("AAPL", "ES1!", "NYMEX:CL1!")
- `chart_set_timeframe` → switch resolution ("1", "5", "15", "60", "D", "W")
- `chart_set_type` → switch style (Candles, HeikinAshi, Line, Area, Renko)
- `chart_manage_indicator` → add/remove studies (use FULL name: "Relative Strength Index" not "RSI")
- `chart_scroll_to_date` → jump to date (ISO format)
- `chart_set_visible_range` → zoom to date range (unix timestamps)

### "Work on Pine Script"
1. `pine_set_source` → inject code into editor
2. `pine_smart_compile` → compile with auto-detection + error check
3. `pine_get_errors` → read compilation errors
4. `pine_get_console` → read log.info() output
5. `pine_get_source` → read current code (can be large)
6. `pine_save` → save to TradingView cloud
7. `pine_new` → create blank indicator/strategy/library
8. `pine_open` → load a saved script by name

### "Practice trading with replay"
1. `replay_start` with `date: "2025-03-01"` → enter replay mode
2. `replay_step` → advance one bar
3. `replay_autoplay` → auto-advance
4. `replay_trade` with `action: "buy"/"sell"/"close"` → execute trades
5. `replay_status` → check position, P&L, date
6. `replay_stop` → return to realtime

### "Screen multiple symbols"
- `batch_run` with `symbols: ["ES1!", "NQ1!", "YM1!"]`

### "Draw on the chart"
- `draw_shape` → horizontal_line, trend_line, rectangle, text
- `draw_list` / `draw_remove_one` / `draw_clear`

### "Manage alerts"
- `alert_create` → set price alert
- `alert_list` / `alert_delete`

### "Navigate TradingView UI"
- `ui_open_panel` → open/close panels (pine-editor, strategy-tester, watchlist, alerts)
- `ui_click` → click buttons by aria-label, text, or data-name
- `layout_switch` → load a saved layout
- `capture_screenshot` → take screenshot

### "TradingView isn't running"
- `tv_launch` → auto-detect and launch TradingView with CDP
- `tv_health_check` → verify connection

## Context Management Rules

1. **Always use `summary: true`** on `data_get_ohlcv` unless individual bars needed
2. **Always use `study_filter`** on pine tools when targeting a specific indicator
3. **Never use `verbose: true`** unless user asks for raw data with IDs/colors
4. **Avoid `pine_get_source`** on complex scripts (can be 200KB+)
5. **Use `capture_screenshot`** for visual context instead of large datasets
6. **Call `chart_get_state` once** to get entity IDs, then reference them
7. **Cap OHLCV requests** — `count: 20` quick, `count: 100` normal, `count: 500` max

## Architecture

```
GitHub Copilot ←→ MCP Server (stdio) ←→ CDP (localhost:9222) ←→ TradingView Desktop
                                     ↕
               Dashboard (React UI) ←→ REST API + SSE (port 3456)
```

## Project Structure

- `src/server.js` — MCP server entry point (80 tools)
- `src/core/` — Core logic (chart, pine, data, replay, etc.)
- `src/tools/` — MCP tool registrations
- `src/cli/` — CLI interface (`tv` command)
- `dashboard.js` — React UI API server + strategy engines
- `ui/` — React frontend source (Vite + React 18)
- `ui-dist/` — Built production UI
- `.data/` — Persistent storage (alerts, trades, watchlist)
- `pdf/` — Pine Script strategies (profitable/loss/untested)
- `scripts/` — Launch scripts, utilities

## Dashboard Features

- **Live Monitoring** — RSI(2), IBS, Fibonacci strategies analyze chart in real-time
- **Multi-Symbol Scanner** — Background scanning of watchlist symbols
- **Persistent Storage** — Alerts, trades, watchlist survive restarts (`.data/` folder)
- **Desktop Notifications** — Windows toast notifications on signals
- **Sound Alerts** — Audio tones for buy/sell signals
- **Global Exchanges** — NSE, BSE, NASDAQ, NYSE, AMEX, BINANCE, FX, LSE, etc.
- **Price Alerts** — Custom price level alerts (above/below/cross)

## Key Commands

```bash
npm run launch:tv       # Launch TradingView with CDP:9222
npm run dashboard       # Start dashboard (kills existing, serves on :3456)
npm run dashboard:dev   # Dev mode with hot reload
npm run ui:build        # Rebuild React UI
npm start               # Start MCP server (stdio)
npm test                # Run tests
```

## Windows MSIX Note

TradingView is installed as MSIX (Windows Store). Direct exe launch is required:
```
cmd /c start "" "C:\Program Files\WindowsApps\TradingView.Desktop_3.2.0.7916_x64__n534cwy3pjxzj\TradingView.exe" --remote-debugging-port=9222
```
Environment variables (ELECTRON_EXTRA_LAUNCH_ARGS) do NOT work with MSIX sandboxed apps.
