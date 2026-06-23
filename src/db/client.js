/**
 * Postgres connection pool.
 *
 * Lazy-init: pool is created on first query so the dashboard can boot
 * without a database configured (database features just return errors).
 *
 * Connection string read from `DATABASE_URL`. Supports:
 *   - Local       : postgresql://postgres:postgres@localhost:5432/tvmcp
 *   - Supabase    : postgresql://postgres:[PWD]@db.[REF].supabase.co:5432/postgres?sslmode=require
 *   - Neon        : postgresql://[user]:[pwd]@ep-xxx.neon.tech/neondb?sslmode=require
 */

import 'dotenv/config';
import pg from 'pg';

const { Pool } = pg;

let _pool = null;

export function isDbConfigured() {
  return Boolean(process.env.DATABASE_URL);
}

/**
 * Get (or lazily create) the pool. Throws a clear error if no DATABASE_URL.
 */
export function getPool() {
  if (_pool) return _pool;
  if (!process.env.DATABASE_URL) {
    throw new Error(
      'DATABASE_URL is not set. Add it to .env (Supabase/Neon connection string) ' +
      'or unset DB-dependent features.',
    );
  }
  _pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    // Most hosted Postgres require SSL but provide CA implicitly.
    ssl: process.env.DATABASE_URL.includes('localhost') ||
         process.env.DATABASE_URL.includes('127.0.0.1')
      ? false
      : { rejectUnauthorized: false },
    max: Number(process.env.PG_POOL_MAX) || 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
  });

  _pool.on('error', err => {
    console.error('[db] pool error:', err.message);
  });

  return _pool;
}

/**
 * Convenience wrapper for one-shot queries.
 */
export async function query(text, params) {
  const pool = getPool();
  return pool.query(text, params);
}

/**
 * Run a function within a transaction. Auto-commits or rolls back on throw.
 */
export async function withTransaction(fn) {
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { /* ignore */ }
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Cleanup on shutdown.
 */
export async function shutdown() {
  if (_pool) {
    await _pool.end();
    _pool = null;
  }
}

/**
 * Quick health probe.
 */
export async function healthCheck() {
  if (!isDbConfigured()) return { ok: false, reason: 'DATABASE_URL not set' };
  try {
    const res = await query('SELECT NOW() AS now, version() AS version');
    return { ok: true, now: res.rows[0].now, version: res.rows[0].version };
  } catch (err) {
    return { ok: false, reason: err.message };
  }
}
