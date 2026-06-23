#!/usr/bin/env node
/**
 * Thin wrapper so `npm run db:migrate` works from package.json.
 * (Reuses the runner exported from src/db/migrate.js.)
 */
import { runMigrations } from '../src/db/migrate.js';
import { shutdown } from '../src/db/client.js';

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
