import { describe, expect, it } from 'vitest';
import {
  DEFAULT_AUCTION_RULES,
  acceptUnderReserve,
  advance,
  cancel,
  createListing,
  currentPrice,
  minimumNextBid,
  placeBid,
  reserveState,
  schedule,
  type Listing,
} from './listing.js';
import { DomainError } from './errors.js';
import { dollars } from './money.js';
import { T0, dealer, usd, vehicle } from '../testing/fixtures.js';

const MINUTE = 60_000;
const SELLER = dealer('gilroy');
const BUYER_B = dealer('dealer-b');
const BUYER_C = dealer('dealer-c');

function at(offsetMs: number): Date {
  return new Date(T0.getTime() + offsetMs);
}

/** A listing already open and taking bids, opened at T0 + leadTime. */
function liveListing(overrides: { reserve?: ReturnType<typeof usd> | null } = {}): Listing {
  const listing = createListing({
    seller: SELLER,
    vehicle: vehicle(),
    startingBid: usd(8_000),
    reserve: overrides.reserve ?? null,
    now: T0,
  });
  return advance(schedule(listing, T0), at(DEFAULT_AUCTION_RULES.leadTimeMs));
}

const OPENS_AT = DEFAULT_AUCTION_RULES.leadTimeMs;
const CLOSES_AT = OPENS_AT + DEFAULT_AUCTION_RULES.runTimeMs;

describe('creating a listing', () => {
  it('starts as a draft with no schedule', () => {
    const listing = createListing({
      seller: SELLER,
      vehicle: vehicle(),
      startingBid: usd(8_000),
      now: T0,
    });
    expect(listing.status).toBe('draft');
    expect(listing.opensAt).toBeNull();
    expect(listing.bids).toEqual([]);
  });

  it('refuses a vehicle that is missing required photos', () => {
    expect(() =>
      createListing({
        seller: SELLER,
        vehicle: vehicle({ photos: [] }),
        startingBid: usd(8_000),
        now: T0,
      }),
    ).toThrow(DomainError);
  });

  it('refuses a reserve below the starting bid', () => {
    expect(() =>
      createListing({
        seller: SELLER,
        vehicle: vehicle(),
        startingBid: usd(8_000),
        reserve: usd(7_000),
        now: T0,
      }),
    ).toThrow(/Reserve must be at or above/);
  });

  it('refuses a dealer whose subscription lapsed', () => {
    const lapsed = dealer('gilroy', { subscription: { planId: 'dealer', status: 'past_due' } });
    expect(() =>
      createListing({ seller: lapsed, vehicle: vehicle(), startingBid: usd(8_000), now: T0 }),
    ).toThrow(/not cleared to list/);
  });
});

describe('the fifteen-and-fifteen clock', () => {
  it('opens fifteen minutes out and runs fifteen minutes', () => {
    const listing = schedule(
      createListing({ seller: SELLER, vehicle: vehicle(), startingBid: usd(8_000), now: T0 }),
      T0,
    );
    expect(listing.status).toBe('scheduled');
    expect(listing.opensAt).toEqual(at(15 * MINUTE));
    expect(listing.closesAt).toEqual(at(30 * MINUTE));
  });

  it('stays scheduled until the lead time elapses', () => {
    const listing = schedule(
      createListing({ seller: SELLER, vehicle: vehicle(), startingBid: usd(8_000), now: T0 }),
      T0,
    );
    expect(advance(listing, at(OPENS_AT - 1)).status).toBe('scheduled');
    expect(advance(listing, at(OPENS_AT)).status).toBe('live');
  });

  it('closes as a no-sale when nobody bids', () => {
    expect(advance(liveListing(), at(CLOSES_AT)).status).toBe('no_sale');
  });

  it('cannot be scheduled twice', () => {
    const listing = schedule(
      createListing({ seller: SELLER, vehicle: vehicle(), startingBid: usd(8_000), now: T0 }),
      T0,
    );
    expect(() => schedule(listing, T0)).toThrow(/Only a draft listing/);
  });
});

describe('bidding', () => {
  it('rejects a bid before the lane opens', () => {
    const listing = schedule(
      createListing({ seller: SELLER, vehicle: vehicle(), startingBid: usd(8_000), now: T0 }),
      T0,
    );
    expect(() =>
      placeBid(listing, { bidder: BUYER_B, amount: usd(8_000), now: at(60_000) }),
    ).toThrow(/Bidding is closed/);
  });

  it('requires the first bid to meet the starting bid', () => {
    const listing = liveListing();
    expect(minimumNextBid(listing)).toBe(usd(8_000));
    expect(() =>
      placeBid(listing, { bidder: BUYER_B, amount: usd(7_950), now: at(OPENS_AT + 1_000) }),
    ).toThrow(/at least/);
  });

  it('requires each later bid to clear the increment for its tier', () => {
    const opened = placeBid(liveListing(), {
      bidder: BUYER_B,
      amount: usd(8_000),
      now: at(OPENS_AT + 1_000),
    }).listing;

    expect(currentPrice(opened)).toBe(usd(8_000));
    expect(minimumNextBid(opened)).toBe(usd(8_100));
    expect(() =>
      placeBid(opened, { bidder: BUYER_C, amount: usd(8_050), now: at(OPENS_AT + 2_000) }),
    ).toThrow(/at least/);

    const raised = placeBid(opened, {
      bidder: BUYER_C,
      amount: usd(8_100),
      now: at(OPENS_AT + 2_000),
    });
    expect(currentPrice(raised.listing)).toBe(usd(8_100));
  });

  it('will not let a seller bid on its own vehicle', () => {
    expect(() =>
      placeBid(liveListing(), { bidder: SELLER, amount: usd(9_000), now: at(OPENS_AT + 1_000) }),
    ).toThrow(/may not bid on its own/);
  });

  it('will not let the high bidder bid against itself', () => {
    const opened = placeBid(liveListing(), {
      bidder: BUYER_B,
      amount: usd(8_000),
      now: at(OPENS_AT + 1_000),
    }).listing;
    expect(() =>
      placeBid(opened, { bidder: BUYER_B, amount: usd(8_500), now: at(OPENS_AT + 2_000) }),
    ).toThrow(/already the high bidder/);
  });

  it('turns away a dealer whose subscription is past due', () => {
    const lapsed = dealer('dealer-d', { subscription: { planId: 'starter', status: 'past_due' } });
    expect(() =>
      placeBid(liveListing(), { bidder: lapsed, amount: usd(8_000), now: at(OPENS_AT + 1_000) }),
    ).toThrow(/not cleared to bid/);
  });

  it('turns away an unverified dealer', () => {
    const unverified = dealer('dealer-e', { verified: false });
    expect(() =>
      placeBid(liveListing(), {
        bidder: unverified,
        amount: usd(8_000),
        now: at(OPENS_AT + 1_000),
      }),
    ).toThrow(/not cleared to bid/);
  });

  it('enforces a dealer bid limit', () => {
    const capped = dealer('dealer-f', { bidLimit: usd(10_000) });
    expect(() =>
      placeBid(liveListing(), { bidder: capped, amount: usd(10_500), now: at(OPENS_AT + 1_000) }),
    ).toThrow(/exceeds the/);
  });

  it('rejects a bid after the close', () => {
    expect(() =>
      placeBid(liveListing(), { bidder: BUYER_B, amount: usd(9_000), now: at(CLOSES_AT + 1) }),
    ).toThrow(/Bidding is closed/);
  });
});

describe('reserve', () => {
  it('reports met or not met without publishing the number', () => {
    const listing = liveListing({ reserve: usd(11_000) });
    expect(reserveState(listing)).toBe('not_met');

    const under = placeBid(listing, {
      bidder: BUYER_B,
      amount: usd(10_000),
      now: at(OPENS_AT + 1_000),
    }).listing;
    expect(reserveState(under)).toBe('not_met');

    const over = placeBid(under, {
      bidder: BUYER_C,
      amount: usd(11_000),
      now: at(OPENS_AT + 2_000),
    }).listing;
    expect(reserveState(over)).toBe('met');
  });

  it('reports no_reserve when the seller set none', () => {
    expect(reserveState(liveListing())).toBe('no_reserve');
  });

  it('closes a listing under reserve as a no-sale', () => {
    const bid = placeBid(liveListing({ reserve: usd(11_000) }), {
      bidder: BUYER_B,
      amount: usd(10_000),
      now: at(OPENS_AT + 1_000),
    }).listing;
    expect(advance(bid, at(CLOSES_AT)).status).toBe('no_sale');
  });

  it('awards a listing whose reserve was met', () => {
    const bid = placeBid(liveListing({ reserve: usd(9_000) }), {
      bidder: BUYER_B,
      amount: usd(9_500),
      now: at(OPENS_AT + 1_000),
    }).listing;
    expect(advance(bid, at(CLOSES_AT)).status).toBe('awarded');
  });

  it('lets the seller take the high bid inside the discretion window', () => {
    const closed = advance(
      placeBid(liveListing({ reserve: usd(11_000) }), {
        bidder: BUYER_B,
        amount: usd(10_000),
        now: at(OPENS_AT + 1_000),
      }).listing,
      at(CLOSES_AT),
    );
    expect(acceptUnderReserve(closed, at(CLOSES_AT + 5 * MINUTE)).status).toBe('awarded');
  });

  it('closes the discretion window on time', () => {
    const closed = advance(
      placeBid(liveListing({ reserve: usd(11_000) }), {
        bidder: BUYER_B,
        amount: usd(10_000),
        now: at(OPENS_AT + 1_000),
      }).listing,
      at(CLOSES_AT),
    );
    expect(() => acceptUnderReserve(closed, at(CLOSES_AT + 11 * MINUTE))).toThrow(
      /window to accept/,
    );
  });

  it('has nothing to accept when nobody bid', () => {
    const closed = advance(liveListing({ reserve: usd(11_000) }), at(CLOSES_AT));
    expect(() => acceptUnderReserve(closed, at(CLOSES_AT + MINUTE))).toThrow(/no bid to accept/);
  });
});

describe('soft close', () => {
  it('leaves the clock alone for a bid placed early', () => {
    const result = placeBid(liveListing(), {
      bidder: BUYER_B,
      amount: usd(8_000),
      now: at(OPENS_AT + MINUTE),
    });
    expect(result.extended).toBe(false);
    expect(result.listing.closesAt).toEqual(at(CLOSES_AT));
  });

  it('pushes the close out for a bid inside the final minute', () => {
    const result = placeBid(liveListing(), {
      bidder: BUYER_B,
      amount: usd(8_000),
      now: at(CLOSES_AT - 30_000),
    });
    expect(result.extended).toBe(true);
    expect(result.listing.closesAt).toEqual(at(CLOSES_AT + 30_000));
    expect(result.listing.extendedMs).toBe(30_000);
  });

  it('never extends past the ceiling, so the seller can promise an end time', () => {
    let listing = liveListing();
    const bidders = [BUYER_B, BUYER_C];

    // Bid one second before each successive close, forever.
    for (let round = 0; round < 12; round += 1) {
      const closesAt = listing.closesAt!.getTime();
      const result = placeBid(listing, {
        bidder: bidders[round % 2]!,
        amount: dollars(8_000 + round * 100),
        now: new Date(closesAt - 1_000),
      });
      listing = result.listing;
    }

    expect(listing.extendedMs).toBe(DEFAULT_AUCTION_RULES.maxTotalExtensionMs);
    expect(listing.closesAt).toEqual(at(CLOSES_AT + 5 * MINUTE));

    // Total run is bounded at twenty minutes: fifteen plus the five-minute cap.
    const totalRunMs = listing.closesAt!.getTime() - at(OPENS_AT).getTime();
    expect(totalRunMs).toBe(20 * MINUTE);
  });
});

describe('cancelling', () => {
  it('is allowed before the lane opens', () => {
    const listing = schedule(
      createListing({ seller: SELLER, vehicle: vehicle(), startingBid: usd(8_000), now: T0 }),
      T0,
    );
    expect(cancel(listing, at(MINUTE)).status).toBe('cancelled');
  });

  it('is refused once bidding is live', () => {
    expect(() => cancel(liveListing(), at(OPENS_AT + MINUTE))).toThrow(/only be cancelled before/);
  });
});
