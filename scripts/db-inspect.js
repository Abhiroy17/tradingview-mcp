// Quick DB introspection — run with `node scripts/db-inspect.js`
import { query, shutdown } from '../src/db/client.js';

(async () => {
  try {
    const tables = await query(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' ORDER BY table_name`,
    );
    console.log(`\nTables (${tables.rows.length}):`);
    tables.rows.forEach(t => console.log('  - ' + t.table_name));

    const views = await query(
      `SELECT viewname FROM pg_views WHERE schemaname = 'public' ORDER BY viewname`,
    );
    console.log(`\nViews (${views.rows.length}):`);
    views.rows.forEach(t => console.log('  - ' + t.viewname));

    const mig = await query(`SELECT version, applied_at FROM schema_migrations ORDER BY applied_at`);
    console.log(`\nMigrations (${mig.rows.length}):`);
    mig.rows.forEach(m => console.log('  - ' + m.version + ' @ ' + m.applied_at.toISOString()));

    const counts = await Promise.all([
      query('SELECT COUNT(*) AS n FROM symbols'),
      query('SELECT COUNT(*) AS n FROM strategies'),
      query('SELECT COUNT(*) AS n FROM timeframes'),
      query('SELECT COUNT(*) AS n FROM regimes'),
      query('SELECT COUNT(*) AS n FROM backtest_runs'),
      query('SELECT COUNT(*) AS n FROM backtest_metrics'),
    ]);
    console.log('\nRow counts:');
    console.log('  symbols:           ' + counts[0].rows[0].n);
    console.log('  strategies:        ' + counts[1].rows[0].n);
    console.log('  timeframes:        ' + counts[2].rows[0].n);
    console.log('  regimes:           ' + counts[3].rows[0].n);
    console.log('  backtest_runs:     ' + counts[4].rows[0].n);
    console.log('  backtest_metrics:  ' + counts[5].rows[0].n);
  } catch (err) {
    console.error('FAIL:', err.message);
    process.exitCode = 1;
  } finally {
    await shutdown();
  }
})();
