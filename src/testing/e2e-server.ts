import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildApp } from '../app/build.js';
import { buildServer } from '../http/server.js';
import { createMemoryStores } from '../store/memory.js';
import { MemoryEventBus } from '../realtime/memory-bus.js';
import { MemoryPhotoStore } from '../photos/store.js';
import { hashApiKey } from '../http/auth.js';
import { DEFAULT_AUCTION_RULES } from '../domain/listing.js';
import type { Dealer } from '../domain/dealer.js';

/**
 * A whole AutoBank in one process, backed by memory, with the fifteen-minute
 * clock compressed to seconds.
 *
 * The browser tests drive the real capture app against the real API — the only
 * things swapped out are the database and the durations, because nobody is going
 * to wait fifteen minutes to find out whether the countdown renders.
 */
const SELLER_KEY = 'ab_e2e_seller_key';
const BUYER_KEY = 'ab_e2e_buyer_key';
const BUYER_C_KEY = 'ab_e2e_buyer_c_key';

function dealer(id: string, name: string): Dealer {
  return {
    id,
    name,
    rooftopCount: 1,
    subscription: { planId: 'dealer', status: 'active' },
    verified: true,
    bidLimit: null,
  };
}

async function start(): Promise<void> {
  const port = Number(process.env['PORT'] ?? 4100);
  const leadTimeMs = Number(process.env['E2E_LEAD_MS'] ?? 2_000);
  const runTimeMs = Number(process.env['E2E_RUN_MS'] ?? 6_000);

  const stores = createMemoryStores();
  await stores.dealers.upsert(dealer('gilroy', 'Gilroy Motors'), hashApiKey(SELLER_KEY));
  await stores.dealers.upsert(dealer('dealer-b', 'Dealer B Auto'), hashApiKey(BUYER_KEY));
  await stores.dealers.upsert(dealer('dealer-c', 'Dealer C Motors'), hashApiKey(BUYER_C_KEY));

  const bus = new MemoryEventBus();
  const app = buildApp({
    stores,
    bus,
    auctionRules: {
      ...DEFAULT_AUCTION_RULES,
      leadTimeMs,
      runTimeMs,
      softCloseWindowMs: 1_500,
      softCloseExtensionMs: 1_500,
      maxTotalExtensionMs: 3_000,
    },
    scheduler: { intervalMs: 150 },
  });

  const server = await buildServer({
    stores,
    bus,
    clock: app.clock,
    auctions: app.auctions,
    sales: app.sales,
    photos: new MemoryPhotoStore(),
    clientRoot: join(dirname(fileURLToPath(import.meta.url)), '..', 'client'),
  });

  app.scheduler.start();
  await server.listen({ port, host: '127.0.0.1' });
  console.log(`e2e server on http://127.0.0.1:${port}`);
}

start().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
