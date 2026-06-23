import 'dotenv/config';
import { query, shutdown } from '../src/db/client.js';

for (const days of [0, 1, 7, 365]) {
  const r = await query(
    `SELECT COUNT(*)::int AS n FROM backtest_runs WHERE computed_at < NOW() - ($1 || ' days')::interval`,
    [String(days)],
  );
  console.log(`maxAgeDays=${days} → ${r.rows[0].n} stale rows`);
}

const all = await query(`SELECT NOW() AS now, MIN(computed_at) AS oldest, MAX(computed_at) AS newest, COUNT(*)::int AS n FROM backtest_runs`);
console.log('\nnow=' + all.rows[0].now.toISOString());
console.log('oldest=' + all.rows[0].oldest?.toISOString?.());
console.log('newest=' + all.rows[0].newest?.toISOString?.());
console.log('total=' + all.rows[0].n);

await shutdown();
