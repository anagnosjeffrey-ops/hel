import type { Dealer } from '../domain/dealer.js';
import type { Listing } from '../domain/listing.js';
import type { Sale } from '../domain/fulfillment.js';
import { decodeListing, decodeSale, encodeListing, encodeSale } from './codec.js';
import {
  NotFoundError,
  type DealerStore,
  type ListingStore,
  type Mutation,
  type SaleStore,
  type Stores,
} from './types.js';

/**
 * Serializes work per key. Concurrent bids on the same vehicle queue behind one
 * another instead of racing; bids on different vehicles never wait.
 */
class KeyedMutex {
  readonly #tails = new Map<string, Promise<unknown>>();

  async run<R>(key: string, fn: () => Promise<R>): Promise<R> {
    const previous = this.#tails.get(key) ?? Promise.resolve();
    // Run on settle either way: one caller's failure must not strand the queue
    // behind it.
    const turn = previous.then(fn, fn);
    // The tail never rejects, so a failed turn cannot reject its successor.
    const tail = turn.catch(() => undefined);
    this.#tails.set(key, tail);

    try {
      return await turn;
    } finally {
      // Only the last turn in the queue clears the entry, so the map does not
      // grow without bound across a long-running process.
      if (this.#tails.get(key) === tail) {
        this.#tails.delete(key);
      }
    }
  }
}

/** Round trip through the codec so stored state is immune to caller mutation. */
function cloneListing(listing: Listing): Listing {
  return decodeListing(JSON.parse(JSON.stringify(encodeListing(listing))));
}

function cloneSale(sale: Sale): Sale {
  return decodeSale(JSON.parse(JSON.stringify(encodeSale(sale))));
}

export class MemoryListingStore implements ListingStore {
  readonly #rows = new Map<string, Listing>();
  readonly #locks = new KeyedMutex();

  async insert(listing: Listing): Promise<void> {
    if (this.#rows.has(listing.id)) {
      throw new Error(`Listing ${listing.id} already exists.`);
    }
    this.#rows.set(listing.id, cloneListing(listing));
  }

  async get(id: string): Promise<Listing | null> {
    const row = this.#rows.get(id);
    return row === undefined ? null : cloneListing(row);
  }

  async listOpen(): Promise<Listing[]> {
    return [...this.#rows.values()]
      .filter((listing) => listing.status === 'live' || listing.status === 'scheduled')
      .sort((a, b) => (a.closesAt?.getTime() ?? 0) - (b.closesAt?.getTime() ?? 0))
      .map(cloneListing);
  }

  async findDue(now: Date, limit = 100): Promise<Listing[]> {
    return [...this.#rows.values()]
      .filter((listing) => {
        if (listing.status === 'scheduled')
          return listing.opensAt !== null && now >= listing.opensAt;
        if (listing.status === 'live') return listing.closesAt !== null && now >= listing.closesAt;
        return false;
      })
      .slice(0, limit)
      .map(cloneListing);
  }

  async findAwarded(limit = 100): Promise<Listing[]> {
    return [...this.#rows.values()]
      .filter((listing) => listing.status === 'awarded')
      .slice(0, limit)
      .map(cloneListing);
  }

  async mutate<R>(id: string, fn: (listing: Listing) => Mutation<Listing, R>): Promise<R> {
    return this.#locks.run(id, async () => {
      const row = this.#rows.get(id);
      if (row === undefined) throw new NotFoundError('Listing', id);
      const { next, result } = fn(cloneListing(row));
      this.#rows.set(id, cloneListing(next));
      return result;
    });
  }
}

export class MemorySaleStore implements SaleStore {
  readonly #rows = new Map<string, Sale>();
  readonly #locks = new KeyedMutex();

  async insert(sale: Sale): Promise<void> {
    if (this.#rows.has(sale.id)) {
      throw new Error(`Sale ${sale.id} already exists.`);
    }
    this.#rows.set(sale.id, cloneSale(sale));
  }

  async get(id: string): Promise<Sale | null> {
    const row = this.#rows.get(id);
    return row === undefined ? null : cloneSale(row);
  }

  async findByListing(listingId: string): Promise<Sale | null> {
    const row = [...this.#rows.values()].find((sale) => sale.listingId === listingId);
    return row === undefined ? null : cloneSale(row);
  }

  async findByGatePass(token: string): Promise<Sale | null> {
    const row = [...this.#rows.values()].find((sale) => sale.transport.gatePassToken === token);
    return row === undefined ? null : cloneSale(row);
  }

  async findDue(now: Date, limit = 100): Promise<Sale[]> {
    return [...this.#rows.values()]
      .filter(
        (sale) =>
          sale.status === 'delivered' &&
          sale.inspectionDeadline !== null &&
          now > sale.inspectionDeadline,
      )
      .slice(0, limit)
      .map(cloneSale);
  }

  async mutate<R>(id: string, fn: (sale: Sale) => Mutation<Sale, R>): Promise<R> {
    return this.#locks.run(id, async () => {
      const row = this.#rows.get(id);
      if (row === undefined) throw new NotFoundError('Sale', id);
      const { next, result } = fn(cloneSale(row));
      this.#rows.set(id, cloneSale(next));
      return result;
    });
  }
}

export class MemoryDealerStore implements DealerStore {
  readonly #rows = new Map<string, { dealer: Dealer; apiKeyHash: string | null }>();

  async upsert(dealer: Dealer, apiKeyHash: string | null): Promise<void> {
    this.#rows.set(dealer.id, { dealer: { ...dealer }, apiKeyHash });
  }

  async get(id: string): Promise<Dealer | null> {
    const row = this.#rows.get(id);
    return row === undefined ? null : { ...row.dealer };
  }

  async findByApiKeyHash(hash: string): Promise<Dealer | null> {
    for (const row of this.#rows.values()) {
      if (row.apiKeyHash !== null && row.apiKeyHash === hash) return { ...row.dealer };
    }
    return null;
  }
}

export function createMemoryStores(): Stores {
  return {
    listings: new MemoryListingStore(),
    sales: new MemorySaleStore(),
    dealers: new MemoryDealerStore(),
  };
}
