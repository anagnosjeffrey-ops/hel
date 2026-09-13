import type { Dealer } from '../domain/dealer.js';
import type { Listing } from '../domain/listing.js';
import type { Sale } from '../domain/fulfillment.js';

/**
 * What a mutation hands back: the state to persist, plus whatever the caller
 * wants to see. Keeping them together means a caller cannot accidentally
 * return a result without persisting the state that produced it.
 */
export interface Mutation<T, R> {
  readonly next: T;
  readonly result: R;
}

export class NotFoundError extends Error {
  constructor(kind: string, id: string) {
    super(`${kind} ${id} was not found.`);
    this.name = 'NotFoundError';
  }
}

/**
 * Storage for auctions.
 *
 * `mutate` is the only write path for an existing listing, and it holds an
 * exclusive lock for the duration of the callback. Two dealers bidding in the
 * same millisecond is the normal case here, not the edge case — read, validate,
 * and append have to be one atomic step or the second bid validates against a
 * price that is already stale.
 */
export interface ListingStore {
  insert(listing: Listing): Promise<void>;
  get(id: string): Promise<Listing | null>;
  /** Every listing currently taking bids. */
  listOpen(): Promise<Listing[]>;
  /** Listings the clock has work for: due to open, or due to close. */
  findDue(now: Date, limit?: number): Promise<Listing[]>;
  /**
   * Awarded listings, for the reconciler. A tick that closes a lane and then
   * dies before writing the sale row leaves one of these behind; it is how the
   * platform recovers instead of losing a deal.
   */
  findAwarded(limit?: number): Promise<Listing[]>;
  mutate<R>(id: string, fn: (listing: Listing) => Mutation<Listing, R>): Promise<R>;
}

export interface SaleStore {
  insert(sale: Sale): Promise<void>;
  get(id: string): Promise<Sale | null>;
  findByListing(listingId: string): Promise<Sale | null>;
  findByGatePass(token: string): Promise<Sale | null>;
  /** Sales whose inspection window has run out. */
  findDue(now: Date, limit?: number): Promise<Sale[]>;
  mutate<R>(id: string, fn: (sale: Sale) => Mutation<Sale, R>): Promise<R>;
}

export interface DealerStore {
  upsert(dealer: Dealer, apiKeyHash: string | null): Promise<void>;
  get(id: string): Promise<Dealer | null>;
  findByApiKeyHash(hash: string): Promise<Dealer | null>;
}

export interface Stores {
  readonly listings: ListingStore;
  readonly sales: SaleStore;
  readonly dealers: DealerStore;
}
