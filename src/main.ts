import { buildApp } from './app/build.js';
import { createPool, migrate } from './store/postgres/pool.js';
import { createPostgresStores } from './store/postgres/stores.js';
import { PostgresEventBus } from './realtime/postgres-bus.js';
import { buildServer } from './http/server.js';

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new Error(`${name} must be set.`);
  }
  return value;
}

async function start(): Promise<void> {
  const databaseUrl = required('DATABASE_URL');
  const port = Number(process.env['PORT'] ?? 3000);
  const host = process.env['HOST'] ?? '0.0.0.0';

  const pool = createPool(databaseUrl);
  await migrate(pool);

  const stores = createPostgresStores(pool);
  const bus = await PostgresEventBus.start(pool, databaseUrl);
  const app = buildApp({ stores, bus, scheduler: { intervalMs: 1_000 } });

  const server = await buildServer({
    stores,
    bus,
    clock: app.clock,
    auctions: app.auctions,
    sales: app.sales,
    logger: true,
  });

  app.scheduler.start();
  await server.listen({ port, host });

  const shutdown = async (signal: string): Promise<void> => {
    server.log.info({ signal }, 'shutting down');
    app.scheduler.stop();
    await server.close();
    await bus.close();
    await pool.end();
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

start().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
