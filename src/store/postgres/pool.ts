import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Pool, type PoolConfig } from 'pg';

export function createPool(connectionString: string, overrides: PoolConfig = {}): Pool {
  return new Pool({
    connectionString,
    // A fifteen-minute lane is bursty: many short transactions around the
    // close, nothing between runs.
    max: 10,
    idleTimeoutMillis: 30_000,
    ...overrides,
  });
}

const SCHEMA_PATH = join(dirname(fileURLToPath(import.meta.url)), 'schema.sql');

/** Idempotent: every statement in schema.sql is IF NOT EXISTS. */
export async function migrate(pool: Pool): Promise<void> {
  const sql = await readFile(SCHEMA_PATH, 'utf8');
  await pool.query(sql);
}

/** Drop all rows. Test helper — never call this against a real database. */
export async function truncateAll(pool: Pool): Promise<void> {
  await pool.query('TRUNCATE sales, listings, dealers CASCADE');
}
