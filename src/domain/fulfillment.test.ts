import { describe, expect, it } from 'vitest';
import {
  acceptDelivery,
  advanceSale,
  assignCarrier,
  awardSale,
  confirmDelivery,
  confirmPickup,
  openDispute,
  settle,
  unwind,
  upholdSale,
  type Sale,
} from './fulfillment.js';
import { DEFAULT_AUCTION_RULES, advance, createListing, placeBid, schedule } from './listing.js';
import { T0, dealer, usd, vehicle } from '../testing/fixtures.js';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const SELLER = dealer('gilroy');
const BUYER = dealer('dealer-b');

const OPENS_AT = DEFAULT_AUCTION_RULES.leadTimeMs;
const CLOSES_AT = OPENS_AT + DEFAULT_AUCTION_RULES.runTimeMs;

function at(offsetMs: number): Date {
  return new Date(T0.getTime() + offsetMs);
}

function awardedSale(): Sale {
  const live = advance(
    schedule(
      createListing({ seller: SELLER, vehicle: vehicle(), startingBid: usd(8_000), now: T0 }),
      T0,
    ),
    at(OPENS_AT),
  );
  const bid = placeBid(live, { bidder: BUYER, amount: usd(12_500), now: at(OPENS_AT + MINUTE) });
  return awardSale(advance(bid.listing, at(CLOSES_AT)), at(CLOSES_AT));
}

/** Carry a sale to the point where the buyer is holding the keys. */
function deliveredSale(deliveredAtMs = CLOSES_AT + 4 * HOUR): Sale {
  const sale = awardedSale();
  const assigned = assignCarrier(sale, 'carrier-1', at(CLOSES_AT + MINUTE));
  const picked = confirmPickup(assigned, assigned.transport.gatePassToken, at(CLOSES_AT + HOUR));
  return confirmDelivery(picked, picked.transport.gatePassToken, at(deliveredAtMs));
}

describe('awarding a sale', () => {
  it('records the winning dealer, the price, and both fees', () => {
    const sale = awardedSale();
    expect(sale.buyerDealerId).toBe('dealer-b');
    expect(sale.sellerDealerId).toBe('gilroy');
    expect(sale.price).toBe(usd(12_500));
    expect(sale.fees.buyerTotal).toBe(usd(12_849));
    expect(sale.fees.sellerProceeds).toBe(usd(12_401));
  });

  it('issues the gate pass immediately, so towing can start at the hammer', () => {
    const sale = awardedSale();
    expect(sale.status).toBe('transport_pending');
    expect(sale.transport.gatePassToken).toMatch(/^[A-Za-z0-9_-]{32}$/);
  });

  it('gives every sale a distinct gate pass', () => {
    expect(awardedSale().transport.gatePassToken).not.toBe(awardedSale().transport.gatePassToken);
  });

  it('refuses to build a sale from a listing that did not sell', () => {
    const closed = advance(
      schedule(
        createListing({ seller: SELLER, vehicle: vehicle(), startingBid: usd(8_000), now: T0 }),
        T0,
      ),
      at(CLOSES_AT),
    );
    expect(() => awardSale(closed, at(CLOSES_AT))).toThrow(/Only an awarded listing/);
  });
});

describe('transport', () => {
  it('walks assignment, pickup, and delivery in order', () => {
    const sale = awardedSale();
    const assigned = assignCarrier(sale, 'carrier-1', at(CLOSES_AT + MINUTE));
    expect(assigned.status).toBe('transport_assigned');

    const picked = confirmPickup(assigned, assigned.transport.gatePassToken, at(CLOSES_AT + HOUR));
    expect(picked.status).toBe('picked_up');
    expect(picked.transport.pickedUpAt).toEqual(at(CLOSES_AT + HOUR));

    const delivered = confirmDelivery(
      picked,
      picked.transport.gatePassToken,
      at(CLOSES_AT + 4 * HOUR),
    );
    expect(delivered.status).toBe('delivered');
  });

  it('rejects a gate pass that belongs to another vehicle', () => {
    const assigned = assignCarrier(awardedSale(), 'carrier-1', at(CLOSES_AT + MINUTE));
    expect(() => confirmPickup(assigned, 'not-the-right-token', at(CLOSES_AT + HOUR))).toThrow(
      /Gate pass does not match/,
    );
  });

  it('will not accept a pickup before a carrier is assigned', () => {
    const sale = awardedSale();
    expect(() => confirmPickup(sale, sale.transport.gatePassToken, at(CLOSES_AT + HOUR))).toThrow(
      /expects an assigned carrier/,
    );
  });

  it('will not accept a delivery for a vehicle still on the lot', () => {
    const assigned = assignCarrier(awardedSale(), 'carrier-1', at(CLOSES_AT + MINUTE));
    expect(() =>
      confirmDelivery(assigned, assigned.transport.gatePassToken, at(CLOSES_AT + 4 * HOUR)),
    ).toThrow(/expects a vehicle in transit/);
  });
});

describe('the 24-hour inspection window', () => {
  it('starts at delivery', () => {
    const delivered = deliveredSale();
    expect(delivered.inspectionDeadline).toEqual(at(CLOSES_AT + 28 * HOUR));
  });

  it('lets the buyer finalize early', () => {
    const accepted = acceptDelivery(deliveredSale(), at(CLOSES_AT + 6 * HOUR));
    expect(accepted.status).toBe('accepted');
    expect(accepted.acceptedAt).toEqual(at(CLOSES_AT + 6 * HOUR));
  });

  it('lets the buyer arbitrate inside the window', () => {
    const disputed = openDispute(
      deliveredSale(),
      'Frame damage not disclosed.',
      at(CLOSES_AT + 20 * HOUR),
    );
    expect(disputed.status).toBe('disputed');
    expect(disputed.disputeReason).toBe('Frame damage not disclosed.');
  });

  it('refuses an arbitration filed after the window closes', () => {
    expect(() => openDispute(deliveredSale(), 'Too late.', at(CLOSES_AT + 29 * HOUR))).toThrow(
      /inspection window has closed/,
    );
  });

  it('requires a written reason to arbitrate', () => {
    expect(() => openDispute(deliveredSale(), '  ', at(CLOSES_AT + 6 * HOUR))).toThrow(
      /needs a written reason/,
    );
  });

  it('auto-accepts on silence, so the seller is not waiting on an inbox', () => {
    const delivered = deliveredSale();
    expect(advanceSale(delivered, at(CLOSES_AT + 27 * HOUR)).status).toBe('delivered');

    const settled = advanceSale(delivered, at(CLOSES_AT + 28 * HOUR + 1));
    expect(settled.status).toBe('accepted');
    expect(settled.acceptedAt).toEqual(delivered.inspectionDeadline);
  });
});

describe('arbitration and settlement', () => {
  it('unwinds a sale decided for the buyer', () => {
    const disputed = openDispute(deliveredSale(), 'Frame damage.', at(CLOSES_AT + 6 * HOUR));
    expect(unwind(disputed).status).toBe('unwound');
  });

  it('upholds a sale decided for the seller', () => {
    const disputed = openDispute(deliveredSale(), 'Frame damage.', at(CLOSES_AT + 6 * HOUR));
    expect(upholdSale(disputed, at(CLOSES_AT + 30 * HOUR)).status).toBe('accepted');
  });

  it('pays the seller once the sale is accepted', () => {
    const accepted = acceptDelivery(deliveredSale(), at(CLOSES_AT + 6 * HOUR));
    const paid = settle(accepted, at(CLOSES_AT + 7 * HOUR));
    expect(paid.status).toBe('paid');
    expect(paid.paidAt).toEqual(at(CLOSES_AT + 7 * HOUR));
  });

  it('will not pay out on a vehicle that is still in dispute', () => {
    const disputed = openDispute(deliveredSale(), 'Frame damage.', at(CLOSES_AT + 6 * HOUR));
    expect(() => settle(disputed, at(CLOSES_AT + 7 * HOUR))).toThrow(/Only an accepted sale/);
  });

  it('will not pay out before the vehicle is delivered', () => {
    expect(() => settle(awardedSale(), at(CLOSES_AT + HOUR))).toThrow(/Only an accepted sale/);
  });
});
