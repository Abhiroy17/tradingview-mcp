// Quick: list everything in backtest_runs + backtest_metrics
import 'dotenv/config';
import { query, isDbConfigured, shutdown } from '../src/db/client.js';

if (!isDbConfigured()) {
  console.error('DATABASE_URL not set');
  process.exit(1);
}

const runs = await query(`
  SELECT r.id, s.canonical AS symbol, st.code AS strategy, t.code AS timeframe,
         r.window_label, r.date_to, r.params_hash,
         m.total_trades, m.win_rate, m.profit_factor, m.sharpe
  FROM backtest_runs r
  LEFT JOIN symbols s     ON s.id  = r.symbol_id
  LEFT JOIN strategies st ON st.id = r.strategy_id
  LEFT JOIN timeframes t  ON t.id  = r.timeframe_id
  LEFT JOIN backtest_metrics m ON m.run_id = r.id
  ORDER BY r.id DESC
  LIMIT 50;
`);

console.log(`\n=== ${runs.rows.length} runs ===`);
for (const r of runs.rows) {
  console.log(
    `#${r.id} ${r.symbol}/${r.strategy}/${r.timeframe} ` +
    `window=${r.window_label} date_to=${r.date_to?.toISOString?.()?.slice(0,10) || r.date_to} ` +
    `hash=${String(r.params_hash || '').slice(0,8)} ` +
    `trades=${r.total_trades} wr=${r.win_rate} pf=${r.profit_factor} sharpe=${r.sharpe}`
  );
}

await shutdown();
