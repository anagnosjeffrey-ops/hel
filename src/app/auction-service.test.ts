import { beforeEach, describe, expect, it } from 'vitest';
import { createHarness, type Harness } from '../testing/harness.js';
import { T0, usd, vehicle } from '../testing/fixtures.js';
import { ForbiddenError } from './errors.js';
import { toPublicListing, toSellerListing } from './views.js';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

describe('AuctionService', () => {
  let h: Harness;

  beforeEach(async () => {
    h = await createHarness(T0);
    await h.register('gilroy');
    await h.register('dealer-b');
    await h.register('dealer-c');
  });

  async function publishedListing(reserve = usd(9_000)) {
    const draft = await h.auctions.createDraft({
      sellerDealerId: 'gilroy',
      vehicle: vehicle(),
      startingBid: usd(8_000),
      reserve,
    });
    return h.auctions.publish(draft.id, 'gilroy');
  }

  it('refuses to list a vehicle for an unregistered dealer', async () => {
    await expect(
      h.auctions.createDraft({
        sellerDealerId: 'ghost-motors',
        vehicle: vehicle(),
        startingBid: usd(8_000),
      }),
    ).rejects.toThrow(/not registered/);
  });

  it("will not let one dealer publish another dealer's listing", async () => {
    const draft = await h.auctions.createDraft({
      sellerDealerId: 'gilroy',
      vehicle: vehicle(),
      startingBid: usd(8_000),
    });
    await expect(h.auctions.publish(draft.id, 'dealer-b')).rejects.toThrow(ForbiddenError);
  });

  it('announces the schedule when a lane is published', async () => {
    const listing = await publishedListing();
    expect(h.events).toContainEqual(
      expect.objectContaining({ type: 'listing.scheduled', listingId: listing.id }),
    );
  });

  it('opens the lane on the tick that reaches its open time', async () => {
    const listing = await publishedListing();

    h.clock.advance(15 * MINUTE - 1_000);
    expect((await h.auctions.tick()).opened).toEqual([]);

    h.clock.advance(1_000);
    expect((await h.auctions.tick()).opened).toEqual([listing.id]);
    expect((await h.auctions.getListing(listing.id)).status).toBe('live');
    expect(h.events).toContainEqual(
      expect.objectContaining({ type: 'listing.opened', listingId: listing.id }),
    );
  });

  it('broadcasts each bid with the new price and the live clock', async () => {
    const listing = await publishedListing();
    h.clock.advance(15 * MINUTE);
    await h.auctions.tick();

    h.clock.advance(MINUTE);
    await h.auctions.placeBid(listing.id, 'dealer-b', usd(8_000));

    const event = h.events.find((e) => e.type === 'bid.placed');
    expect(event).toMatchObject({
      type: 'bid.placed',
      dealerId: 'dealer-b',
      amount: usd(8_000),
      minimumNextBid: usd(8_100),
      reserveState: 'not_met',
      extended: false,
    });
  });

  it('reports the reserve as met once bidding clears it', async () => {
    const listing = await publishedListing();
    h.clock.advance(15 * MINUTE);
    await h.auctions.tick();

    h.clock.advance(MINUTE);
    await h.auctions.placeBid(listing.id, 'dealer-b', usd(9_500));

    const event = h.events.filter((e) => e.type === 'bid.placed').at(-1);
    expect(event).toMatchObject({ reserveState: 'met' });
  });

  it('flags a bid that stretched the clock', async () => {
    const listing = await publishedListing();
    h.clock.advance(15 * MINUTE);
    await h.auctions.tick();

    // Twenty seconds before the close.
    h.clock.advance(15 * MINUTE - 20_000);
    await h.auctions.placeBid(listing.id, 'dealer-b', usd(8_000));

    expect(h.events.filter((e) => e.type === 'bid.placed').at(-1)).toMatchObject({
      extended: true,
    });
  });

  it('does not publish an event for a bid that was rejected', async () => {
    const listing = await publishedListing();
    h.clock.advance(15 * MINUTE);
    await h.auctions.tick();

    await expect(h.auctions.placeBid(listing.id, 'dealer-b', usd(100))).rejects.toThrow();
    expect(h.events.filter((e) => e.type === 'bid.placed')).toEqual([]);
  });

  it('closes, awards, and creates the sale in one tick', async () => {
    const listing = await publishedListing();
    h.clock.advance(15 * MINUTE);
    await h.auctions.tick();

    h.clock.advance(MINUTE);
    await h.auctions.placeBid(listing.id, 'dealer-b', usd(11_000));

    h.clock.advance(15 * MINUTE);
    const report = await h.auctions.tick();

    expect(report.closed).toEqual([listing.id]);
    expect(report.awarded).toEqual([listing.id]);

    const sale = await h.sales.findByListing(listing.id);
    expect(sale).not.toBeNull();
    expect(sale!.buyerDealerId).toBe('dealer-b');
    expect(sale!.price).toBe(usd(11_000));
    expect(h.events).toContainEqual(
      expect.objectContaining({ type: 'listing.closed', outcome: 'awarded' }),
    );
  });

  it('closes a lane nobody bid on as a no-sale and creates nothing', async () => {
    const listing = await publishedListing();
    h.clock.advance(15 * MINUTE);
    await h.auctions.tick();

    h.clock.advance(15 * MINUTE);
    const report = await h.auctions.tick();

    expect(report.closed).toEqual([listing.id]);
    expect(report.awarded).toEqual([]);
    expect(await h.sales.findByListing(listing.id)).toBeNull();
  });

  it('creates exactly one sale no matter how many times the tick runs', async () => {
    const listing = await publishedListing();
    h.clock.advance(15 * MINUTE);
    await h.auctions.tick();
    h.clock.advance(MINUTE);
    await h.auctions.placeBid(listing.id, 'dealer-b', usd(11_000));
    h.clock.advance(15 * MINUTE);

    await h.auctions.tick();
    const second = await h.auctions.tick();
    const third = await h.auctions.tick();

    expect(second.awarded).toEqual([]);
    expect(third.awarded).toEqual([]);
    expect(h.events.filter((e) => e.type === 'sale.awarded')).toHaveLength(1);
  });

  it('recovers a sale for a lane that closed before the sale was written', async () => {
    const listing = await publishedListing();
    h.clock.advance(15 * MINUTE);
    await h.auctions.tick();
    h.clock.advance(MINUTE);
    await h.auctions.placeBid(listing.id, 'dealer-b', usd(11_000));

    // Close the lane directly, as if the process died before reconciling.
    h.clock.advance(15 * MINUTE);
    await h.stores.listings.mutate(listing.id, (current) => ({
      next: { ...current, status: 'awarded' as const },
      result: null,
    }));
    expect(await h.sales.findByListing(listing.id)).toBeNull();

    await h.auctions.tick();
    expect(await h.sales.findByListing(listing.id)).not.toBeNull();
  });

  it('auto-accepts a delivered vehicle once the inspection window lapses', async () => {
    const listing = await publishedListing();
    h.clock.advance(15 * MINUTE);
    await h.auctions.tick();
    h.clock.advance(MINUTE);
    await h.auctions.placeBid(listing.id, 'dealer-b', usd(11_000));
    h.clock.advance(15 * MINUTE);
    await h.auctions.tick();

    const sale = (await h.sales.findByListing(listing.id))!;
    await h.sales.assignCarrier(sale.id, 'carrier-1');
    const token = sale.transport.gatePassToken;
    h.clock.advance(HOUR);
    await h.sales.scanGatePass(token);
    h.clock.advance(2 * HOUR);
    await h.sales.scanGatePass(token);

    h.clock.advance(23 * HOUR);
    expect(await h.sales.sweepInspections()).toEqual([]);

    h.clock.advance(2 * HOUR);
    expect(await h.sales.sweepInspections()).toEqual([sale.id]);
    expect((await h.sales.get(sale.id)).status).toBe('accepted');
  });
});

describe('views', () => {
  it('never carries the reserve in the public projection', async () => {
    const h = await createHarness(T0);
    await h.register('gilroy');
    const listing = await h.auctions.createDraft({
      sellerDealerId: 'gilroy',
      vehicle: vehicle(),
      startingBid: usd(8_000),
      reserve: usd(9_000),
    });

    const asBuyer = toPublicListing(listing);
    expect(JSON.stringify(asBuyer)).not.toContain('900000');
    expect(Object.keys(asBuyer)).not.toContain('reserve');
    expect(asBuyer.reserveState).toBe('not_met');

    expect(toSellerListing(listing).reserve).toBe(usd(9_000));
  });
});
