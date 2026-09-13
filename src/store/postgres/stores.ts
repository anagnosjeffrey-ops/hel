import type { Pool, PoolClient } from 'pg';
import type { Dealer } from '../../domain/dealer.js';
import type { Listing } from '../../domain/listing.js';
import type { Sale } from '../../domain/fulfillment.js';
import { decodeListing, decodeSale, encodeListing, encodeSale } from '../codec.js';
import {
  NotFoundError,
  type DealerStore,
  type ListingStore,
  type Mutation,
  type SaleStore,
  type Stores,
} from '../types.js';

/** Run `fn` in a transaction, rolling back on any throw. */
async function inTransaction<R>(pool: Pool, fn: (client: PoolClient) => Promise<R>): Promise<R> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export class PostgresListingStore implements ListingStore {
  readonly #pool: Pool;

  constructor(pool: Pool) {
    this.#pool = pool;
  }

  async insert(listing: Listing): Promise<void> {
    await this.#pool.query(
      `INSERT INTO listings (id, seller_dealer_id, status, opens_at, closes_at, data, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        listing.id,
        listing.sellerDealerId,
        listing.status,
        listing.opensAt,
        listing.closesAt,
        encodeListing(listing),
        listing.createdAt,
      ],
    );
  }

  async get(id: string): Promise<Listing | null> {
    const { rows } = await this.#pool.query<{ data: Record<string, unknown> }>(
      'SELECT data FROM listings WHERE id = $1',
      [id],
    );
    const row = rows[0];
    return row === undefined ? null : decodeListing(row.data);
  }

  async listOpen(): Promise<Listing[]> {
    const { rows } = await this.#pool.query<{ data: Record<string, unknown> }>(
      `SELECT data FROM listings
       WHERE status IN ('scheduled', 'live')
       ORDER BY closes_at ASC NULLS LAST`,
    );
    return rows.map((row) => decodeListing(row.data));
  }

  async findDue(now: Date, limit = 100): Promise<Listing[]> {
    const { rows } = await this.#pool.query<{ data: Record<string, unknown> }>(
      `SELECT data FROM listings
       WHERE (status = 'scheduled' AND opens_at <= $1)
          OR (status = 'live' AND closes_at <= $1)
       ORDER BY COALESCE(closes_at, opens_at) ASC
       LIMIT $2`,
      [now, limit],
    );
    return rows.map((row) => decodeListing(row.data));
  }

  async findAwarded(limit = 100): Promise<Listing[]> {
    const { rows } = await this.#pool.query<{ data: Record<string, unknown> }>(
      `SELECT data FROM listings
       WHERE status = 'awarded'
       ORDER BY closes_at ASC
       LIMIT $1`,
      [limit],
    );
    return rows.map((row) => decodeListing(row.data));
  }

  /**
   * SELECT ... FOR UPDATE holds a row lock for the whole transaction, so two
   * dealers bidding in the same millisecond are serialized by the database.
   * The second one re-reads the winning price and is rejected or accepted
   * against the truth rather than against a stale snapshot.
   */
  async mutate<R>(id: string, fn: (listing: Listing) => Mutation<Listing, R>): Promise<R> {
    return inTransaction(this.#pool, async (client) => {
      const { rows } = await client.query<{ data: Record<string, unknown> }>(
        'SELECT data FROM listings WHERE id = $1 FOR UPDATE',
        [id],
      );
      const row = rows[0];
      if (row === undefined) throw new NotFoundError('Listing', id);

      const { next, result } = fn(decodeListing(row.data));

      await client.query(
        `UPDATE listings
         SET status = $2, opens_at = $3, closes_at = $4, data = $5, updated_at = now()
         WHERE id = $1`,
        [id, next.status, next.opensAt, next.closesAt, encodeListing(next)],
      );
      return result;
    });
  }
}

export class PostgresSaleStore implements SaleStore {
  readonly #pool: Pool;

  constructor(pool: Pool) {
    this.#pool = pool;
  }

  async insert(sale: Sale): Promise<void> {
    await this.#pool.query(
      `INSERT INTO sales (id, listing_id, seller_dealer_id, buyer_dealer_id, status,
                          gate_pass_token, inspection_deadline, data, awarded_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        sale.id,
        sale.listingId,
        sale.sellerDealerId,
        sale.buyerDealerId,
        sale.status,
        sale.transport.gatePassToken,
        sale.inspectionDeadline,
        encodeSale(sale),
        sale.awardedAt,
      ],
    );
  }

  async get(id: string): Promise<Sale | null> {
    return this.#one('SELECT data FROM sales WHERE id = $1', [id]);
  }

  async findByListing(listingId: string): Promise<Sale | null> {
    return this.#one('SELECT data FROM sales WHERE listing_id = $1', [listingId]);
  }

  async findByGatePass(token: string): Promise<Sale | null> {
    return this.#one('SELECT data FROM sales WHERE gate_pass_token = $1', [token]);
  }

  async findDue(now: Date, limit = 100): Promise<Sale[]> {
    const { rows } = await this.#pool.query<{ data: Record<string, unknown> }>(
      `SELECT data FROM sales
       WHERE status = 'delivered' AND inspection_deadline < $1
       ORDER BY inspection_deadline ASC
       LIMIT $2`,
      [now, limit],
    );
    return rows.map((row) => decodeSale(row.data));
  }

  async mutate<R>(id: string, fn: (sale: Sale) => Mutation<Sale, R>): Promise<R> {
    return inTransaction(this.#pool, async (client) => {
      const { rows } = await client.query<{ data: Record<string, unknown> }>(
        'SELECT data FROM sales WHERE id = $1 FOR UPDATE',
        [id],
      );
      const row = rows[0];
      if (row === undefined) throw new NotFoundError('Sale', id);

      const { next, result } = fn(decodeSale(row.data));

      await client.query(
        `UPDATE sales
         SET status = $2, inspection_deadline = $3, data = $4, updated_at = now()
         WHERE id = $1`,
        [id, next.status, next.inspectionDeadline, encodeSale(next)],
      );
      return result;
    });
  }

  async #one(sql: string, params: unknown[]): Promise<Sale | null> {
    const { rows } = await this.#pool.query<{ data: Record<string, unknown> }>(sql, params);
    const row = rows[0];
    return row === undefined ? null : decodeSale(row.data);
  }
}

export class PostgresDealerStore implements DealerStore {
  readonly #pool: Pool;

  constructor(pool: Pool) {
    this.#pool = pool;
  }

  async upsert(dealer: Dealer, apiKeyHash: string | null): Promise<void> {
    await this.#pool.query(
      `INSERT INTO dealers (id, api_key_hash, data)
       VALUES ($1, $2, $3)
       ON CONFLICT (id) DO UPDATE
         SET api_key_hash = EXCLUDED.api_key_hash,
             data = EXCLUDED.data,
             updated_at = now()`,
      [dealer.id, apiKeyHash, dealer],
    );
  }

  async get(id: string): Promise<Dealer | null> {
    const { rows } = await this.#pool.query<{ data: Dealer }>(
      'SELECT data FROM dealers WHERE id = $1',
      [id],
    );
    return rows[0]?.data ?? null;
  }

  async findByApiKeyHash(hash: string): Promise<Dealer | null> {
    const { rows } = await this.#pool.query<{ data: Dealer }>(
      'SELECT data FROM dealers WHERE api_key_hash = $1',
      [hash],
    );
    return rows[0]?.data ?? null;
  }
}

export function createPostgresStores(pool: Pool): Stores {
  return {
    listings: new PostgresListingStore(pool),
    sales: new PostgresSaleStore(pool),
    dealers: new PostgresDealerStore(pool),
  };
}
