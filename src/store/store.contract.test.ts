import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { createMemoryStores } from './memory.js';
import { createPostgresStores } from './postgres/stores.js';
import { createPool, migrate, truncateAll } from './postgres/pool.js';
import { NotFoundError, type Stores } from './types.js';
import { advance, createListing, placeBid, schedule } from '../domain/listing.js';
import { assignCarrier, awardSale, confirmDelivery, confirmPickup } from '../domain/fulfillment.js';
import { T0, dealer, usd, vehicle } from '../testing/fixtures.js';
import type { Listing } from '../domain/listing.js';

const MINUTE = 60_000;
const SELLER = dealer('gilroy');
const BUYER_B = dealer('dealer-b');
const BUYER_C = dealer('dealer-c');
const OPENS_AT = 15 * MINUTE;
const CLOSES_AT = 30 * MINUTE;

const at = (ms: number) => new Date(T0.getTime() + ms);

const DATABASE_URL =
  process.env['TEST_DATABASE_URL'] ?? 'postgres://autobank:autobank@127.0.0.1:5432/autobank_test';

let pool: Pool | null = null;

async function postgresStores(): Promise<Stores> {
  pool ??= createPool(DATABASE_URL);
  await migrate(pool);
  await truncateAll(pool);
  return createPostgresStores(pool);
}

afterAll(async () => {
  await pool?.end();
});

function draft(): Listing {
  return createListing({
    seller: SELLER,
    vehicle: vehicle(),
    startingBid: usd(8_000),
    reserve: usd(9_000),
    now: T0,
  });
}

function liveListing(): Listing {
  return advance(schedule(draft(), T0), at(OPENS_AT));
}

/**
 * One suite, both implementations. The in-memory store is only trustworthy as a
 * test double if it behaves exactly like the database the product runs on.
 */
const implementations: readonly [string, () => Promise<Stores>][] = [
  ['memory', async () => createMemoryStores()],
  ['postgres', postgresStores],
];

describe.each(implementations)('%s store', (_name, makeStores) => {
  let stores: Stores;

  beforeEach(async () => {
    stores = await makeStores();
  });

  describe('listings', () => {
    it('round trips a listing through storage without losing money or timestamps', async () => {
      const original = liveListing();
      await stores.listings.insert(original);

      const loaded = await stores.listings.get(original.id);
      expect(loaded).not.toBeNull();
      expect(loaded).toEqual(original);
      expect(loaded!.opensAt).toBeInstanceOf(Date);
      expect(loaded!.vehicle.photos[0]!.takenAt).toBeInstanceOf(Date);
      expect(loaded!.startingBid).toBe(usd(8_000));
      expect(loaded!.reserve).toBe(usd(9_000));
    });

    it('round trips bids, including their timestamps', async () => {
      const withBid = placeBid(liveListing(), {
        bidder: BUYER_B,
        amount: usd(8_000),
        now: at(OPENS_AT + MINUTE),
      }).listing;
      await stores.listings.insert(withBid);

      const loaded = await stores.listings.get(withBid.id);
      expect(loaded!.bids).toHaveLength(1);
      expect(loaded!.bids[0]!.amount).toBe(usd(8_000));
      expect(loaded!.bids[0]!.placedAt).toEqual(at(OPENS_AT + MINUTE));
    });

    it('returns null for an unknown id', async () => {
      expect(await stores.listings.get('lst_nope')).toBeNull();
    });

    it('persists what a mutation returns', async () => {
      const listing = liveListing();
      await stores.listings.insert(listing);

      const bidId = await stores.listings.mutate(listing.id, (current) => {
        const result = placeBid(current, {
          bidder: BUYER_B,
          amount: usd(8_500),
          now: at(OPENS_AT + MINUTE),
        });
        return { next: result.listing, result: result.bid.id };
      });

      const loaded = await stores.listings.get(listing.id);
      expect(loaded!.bids).toHaveLength(1);
      expect(loaded!.bids[0]!.id).toBe(bidId);
    });

    it('leaves state untouched when a mutation throws', async () => {
      const listing = liveListing();
      await stores.listings.insert(listing);

      await expect(
        stores.listings.mutate(listing.id, () => {
          throw new Error('validation failed');
        }),
      ).rejects.toThrow('validation failed');

      const loaded = await stores.listings.get(listing.id);
      expect(loaded!.bids).toEqual([]);
      expect(loaded!.status).toBe('live');
    });

    it('reports a missing listing on mutate', async () => {
      await expect(
        stores.listings.mutate('lst_nope', (l) => ({ next: l, result: null })),
      ).rejects.toThrow(NotFoundError);
    });

    it('does not let a caller mutate stored state by holding a reference', async () => {
      const listing = liveListing();
      await stores.listings.insert(listing);

      const escaped = await stores.listings.get(listing.id);
      (escaped as { status: string }).status = 'cancelled';

      expect((await stores.listings.get(listing.id))!.status).toBe('live');
    });

    it('lists open lanes soonest-closing first', async () => {
      const early = liveListing();
      const late = { ...liveListing(), closesAt: at(CLOSES_AT + 10 * MINUTE) };
      await stores.listings.insert(late);
      await stores.listings.insert(early);

      const open = await stores.listings.listOpen();
      expect(open.map((l) => l.id)).toEqual([early.id, late.id]);
    });

    it('excludes closed lanes from the open list', async () => {
      await stores.listings.insert(advance(liveListing(), at(CLOSES_AT)));
      expect(await stores.listings.listOpen()).toEqual([]);
    });

    it('finds a scheduled listing once its open time arrives', async () => {
      const scheduled = schedule(draft(), T0);
      await stores.listings.insert(scheduled);

      expect(await stores.listings.findDue(at(OPENS_AT - 1_000))).toEqual([]);
      expect((await stores.listings.findDue(at(OPENS_AT))).map((l) => l.id)).toEqual([
        scheduled.id,
      ]);
    });

    it('finds a live listing once its close time arrives', async () => {
      const live = liveListing();
      await stores.listings.insert(live);

      expect(await stores.listings.findDue(at(CLOSES_AT - 1_000))).toEqual([]);
      expect((await stores.listings.findDue(at(CLOSES_AT))).map((l) => l.id)).toEqual([live.id]);
    });

    it('respects the due limit', async () => {
      await stores.listings.insert(liveListing());
      await stores.listings.insert(liveListing());
      expect(await stores.listings.findDue(at(CLOSES_AT), 1)).toHaveLength(1);
    });
  });

  describe('concurrent bidding', () => {
    /**
     * The race this whole layer exists to handle. Two dealers bid the same
     * amount at the same instant on the same vehicle. Exactly one may win, and
     * the loser must be rejected for bidding below the new price — not silently
     * overwrite the winner.
     */
    it('serializes simultaneous bids so only one can take the same price', async () => {
      const listing = liveListing();
      await stores.listings.insert(listing);

      const bid = (bidder: typeof BUYER_B) =>
        stores.listings.mutate(listing.id, (current) => {
          const result = placeBid(current, {
            bidder,
            amount: usd(8_000),
            now: at(OPENS_AT + MINUTE),
          });
          return { next: result.listing, result: result.bid.id };
        });

      const outcomes = await Promise.allSettled([bid(BUYER_B), bid(BUYER_C)]);
      const fulfilled = outcomes.filter((o) => o.status === 'fulfilled');
      const rejected = outcomes.filter((o) => o.status === 'rejected');

      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({ code: 'BID_TOO_LOW' });

      const loaded = await stores.listings.get(listing.id);
      expect(loaded!.bids).toHaveLength(1);
    });

    it('accepts a queued bid that clears the price the winner set', async () => {
      const listing = liveListing();
      await stores.listings.insert(listing);

      const bid = (bidder: typeof BUYER_B, amount: number) =>
        stores.listings.mutate(listing.id, (current) => {
          const result = placeBid(current, {
            bidder,
            amount: usd(amount),
            now: at(OPENS_AT + MINUTE),
          });
          return { next: result.listing, result: result.bid.id };
        });

      const outcomes = await Promise.allSettled([bid(BUYER_B, 8_000), bid(BUYER_C, 8_100)]);
      expect(outcomes.every((o) => o.status === 'fulfilled')).toBe(true);

      const loaded = await stores.listings.get(listing.id);
      expect(loaded!.bids.map((b) => b.amount)).toEqual([usd(8_000), usd(8_100)]);
    });

    it('keeps every bid in a burst of ten, with a strictly rising price', async () => {
      const listing = liveListing();
      await stores.listings.insert(listing);
      const bidders = [BUYER_B, BUYER_C];

      const attempts = Array.from({ length: 10 }, (_, index) =>
        stores.listings
          .mutate(listing.id, (current) => {
            const result = placeBid(current, {
              bidder: bidders[index % 2]!,
              amount: usd(8_000 + index * 100),
              now: at(OPENS_AT + MINUTE),
            });
            return { next: result.listing, result: result.bid.amount };
          })
          .catch(() => null),
      );
      await Promise.all(attempts);

      const loaded = await stores.listings.get(listing.id);
      const amounts = loaded!.bids.map((b) => b.amount);
      expect(amounts.length).toBeGreaterThan(0);
      for (let i = 1; i < amounts.length; i += 1) {
        expect(amounts[i]!).toBeGreaterThan(amounts[i - 1]!);
      }
    });
  });

  describe('sales', () => {
    async function storedSale() {
      const won = advance(
        placeBid(liveListing(), {
          bidder: BUYER_B,
          amount: usd(12_500),
          now: at(OPENS_AT + MINUTE),
        }).listing,
        at(CLOSES_AT),
      );
      await stores.listings.insert(won);
      const sale = awardSale(won, at(CLOSES_AT));
      await stores.sales.insert(sale);
      return sale;
    }

    it('round trips a sale, its fees, and its gate pass', async () => {
      const sale = await storedSale();
      const loaded = await stores.sales.get(sale.id);
      expect(loaded).toEqual(sale);
      expect(loaded!.fees.buyerTotal).toBe(usd(12_849));
      expect(loaded!.awardedAt).toBeInstanceOf(Date);
    });

    it('finds a sale by its listing', async () => {
      const sale = await storedSale();
      expect((await stores.sales.findByListing(sale.listingId))!.id).toBe(sale.id);
    });

    it('finds a sale by gate pass, which is how a scanned QR resolves', async () => {
      const sale = await storedSale();
      const found = await stores.sales.findByGatePass(sale.transport.gatePassToken);
      expect(found!.id).toBe(sale.id);
      expect(await stores.sales.findByGatePass('not-a-token')).toBeNull();
    });

    it('persists the transport chain of custody', async () => {
      const sale = await storedSale();

      await stores.sales.mutate(sale.id, (current) => ({
        next: assignCarrier(current, 'carrier-1', at(CLOSES_AT + MINUTE)),
        result: null,
      }));
      await stores.sales.mutate(sale.id, (current) => ({
        next: confirmPickup(current, current.transport.gatePassToken, at(CLOSES_AT + 60 * MINUTE)),
        result: null,
      }));
      await stores.sales.mutate(sale.id, (current) => ({
        next: confirmDelivery(
          current,
          current.transport.gatePassToken,
          at(CLOSES_AT + 180 * MINUTE),
        ),
        result: null,
      }));

      const loaded = await stores.sales.get(sale.id);
      expect(loaded!.status).toBe('delivered');
      expect(loaded!.transport.carrierId).toBe('carrier-1');
      expect(loaded!.transport.pickedUpAt).toEqual(at(CLOSES_AT + 60 * MINUTE));
      expect(loaded!.inspectionDeadline).toEqual(at(CLOSES_AT + 180 * MINUTE + 24 * 60 * MINUTE));
    });

    it('finds sales whose inspection window has run out', async () => {
      const sale = await storedSale();
      await stores.sales.mutate(sale.id, (current) => ({
        next: confirmDelivery(
          confirmPickup(
            assignCarrier(current, 'carrier-1', at(CLOSES_AT + MINUTE)),
            current.transport.gatePassToken,
            at(CLOSES_AT + 60 * MINUTE),
          ),
          current.transport.gatePassToken,
          at(CLOSES_AT + 180 * MINUTE),
        ),
        result: null,
      }));

      const deadline = (await stores.sales.get(sale.id))!.inspectionDeadline!;
      expect(await stores.sales.findDue(deadline)).toEqual([]);
      expect(
        (await stores.sales.findDue(new Date(deadline.getTime() + 1_000))).map((s) => s.id),
      ).toEqual([sale.id]);
    });
  });

  describe('dealers', () => {
    it('round trips a dealer and looks one up by API key hash', async () => {
      await stores.dealers.upsert(BUYER_B, 'hash-b');
      expect(await stores.dealers.get(BUYER_B.id)).toEqual(BUYER_B);
      expect((await stores.dealers.findByApiKeyHash('hash-b'))!.id).toBe(BUYER_B.id);
      expect(await stores.dealers.findByApiKeyHash('hash-unknown')).toBeNull();
    });

    it('updates a dealer in place', async () => {
      await stores.dealers.upsert(BUYER_B, 'hash-b');
      await stores.dealers.upsert(
        { ...BUYER_B, subscription: { planId: 'dealer', status: 'past_due' } },
        'hash-b',
      );
      expect((await stores.dealers.get(BUYER_B.id))!.subscription.status).toBe('past_due');
    });
  });
});
