import { FixedClock } from '../domain/clock.js';
import type { Dealer } from '../domain/dealer.js';
import { createMemoryStores } from '../store/memory.js';
import { MemoryEventBus } from '../realtime/memory-bus.js';
import type { AuctionEvent } from '../realtime/events.js';
import { ALL_LANES } from '../realtime/events.js';
import { buildApp, type App } from '../app/build.js';
import { generateApiKey, hashApiKey } from '../http/auth.js';
import { MemoryPhotoStore } from '../photos/store.js';
import { dealer } from './fixtures.js';

export interface Harness extends App {
  readonly clock: FixedClock;
  readonly photos: MemoryPhotoStore;
  /** Every event published since the harness was created, in order. */
  readonly events: AuctionEvent[];
  readonly keys: Map<string, string>;
  register(id: string, overrides?: Partial<Dealer>): Promise<{ dealer: Dealer; apiKey: string }>;
}

export async function createHarness(start: Date): Promise<Harness> {
  const clock = new FixedClock(start);
  const stores = createMemoryStores();
  const bus = new MemoryEventBus();
  const app = buildApp({ stores, bus, clock });

  const events: AuctionEvent[] = [];
  bus.subscribe(ALL_LANES, (event) => events.push(event));

  const keys = new Map<string, string>();

  return {
    ...app,
    clock,
    photos: new MemoryPhotoStore(),
    events,
    keys,
    async register(id, overrides = {}) {
      const record = dealer(id, overrides);
      const apiKey = generateApiKey();
      await stores.dealers.upsert(record, hashApiKey(apiKey));
      keys.set(id, apiKey);
      return { dealer: record, apiKey };
    },
  };
}
