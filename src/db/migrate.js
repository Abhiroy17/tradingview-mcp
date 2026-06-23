/**
 * Schema migration runner.
 *
 * The schema is idempotent (CREATE TABLE IF NOT EXISTS, etc.) so this is
 * just "apply schema.sql once per boot, log result".
 *
 * Future migrations go in `src/db/migrations/NNNN_<name>.sql` and we'll
 * track applied versions in `schema_migrations`. For now schema.sql is
 * the single source of truth.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { query, isDbConfigured, shutdown } from './client.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA_FILE = path.join(__dirname, 'schema.sql');

export async function runMigrations() {
  if (!isDbConfigured()) {
    throw new Error('DATABASE_URL not set — cannot migrate.');
  }
  const sql = await fs.readFile(SCHEMA_FILE, 'utf8');
  await query(sql);
  const r = await query(
    `SELECT COUNT(*)::int AS migrations,
            (SELECT COUNT(*)::int FROM information_schema.tables WHERE table_schema = 'public') AS tables
     FROM schema_migrations`,
  );
  return r.rows[0];
}

// CLI entry: `npm run db:migrate`
const isMain =
  import.meta.url === `file://${process.argv[1].replace(/\\/g, '/')}` ||
  import.meta.url === `file:///${process.argv[1].replace(/\\/g, '/')}`;
if (isMain) {
  (async () => {
    try {
      console.log('Applying schema.sql ...');
      const result = await runMigrations();
      console.log(`OK — ${result.migrations} migration(s) recorded, ${result.tables} tables in public schema.`);
    } catch (err) {
      console.error('Migration failed:', err.message);
      process.exitCode = 1;
    } finally {
      await shutdown();
    }
  })();
}
