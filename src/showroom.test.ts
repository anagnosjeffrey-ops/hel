import { describe, expect, it } from 'vitest';
import { FixedClock } from './domain/clock.js';
import {
  DEFAULT_AUCTION_RULES,
  advance,
  createListing,
  currentPrice,
  minimumNextBid,
  placeBid,
  schedule,
} from './domain/listing.js';
import {
  acceptDelivery,
  assignCarrier,
  awardSale,
  confirmDelivery,
  confirmPickup,
  settle,
} from './domain/fulfillment.js';
import { formatUsd } from './domain/money.js';
import { T0, dealer, usd, vehicle } from './testing/fixtures.js';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/**
 * The whole business, start to finish, on one clock.
 *
 * A customer walks into Gilroy — a domestic store — with an off-brand trade.
 * Gilroy would have put $9,000 into it. Four stores that actually retail this
 * model get fifteen minutes to say otherwise, and the customer is still in the
 * showroom when it settles.
 */
describe('a trade run while the customer waits', () => {
  it('takes an off-brand trade from the showroom floor to a funded seller', () => {
    const clock = new FixedClock(T0);

    const gilroy = dealer('gilroy');
    const dealerB = dealer('dealer-b');
    const dealerC = dealer('dealer-c');
    const dealerD = dealer('dealer-d');

    // 15:00 — the used-car manager photographs the unit and posts it.
    const trade = vehicle({ year: 2019, make: 'Toyota', model: 'Tacoma', odometerMiles: 68_412 });
    let listing = schedule(
      createListing({
        seller: gilroy,
        vehicle: trade,
        startingBid: usd(8_000),
        // What Gilroy was prepared to put in the deal on its own.
        reserve: usd(9_000),
        now: clock.now(),
      }),
      clock.now(),
    );

    expect(listing.status).toBe('scheduled');
    expect(listing.opensAt).toEqual(new Date(T0.getTime() + 15 * MINUTE));

    // 15:15 — the lane opens.
    clock.set(listing.opensAt!);
    listing = advance(listing, clock.now());
    expect(listing.status).toBe('live');
    expect(minimumNextBid(listing)).toBe(usd(8_000));

    // 15:17 — B opens at the floor.
    clock.advance(2 * MINUTE);
    listing = placeBid(listing, { bidder: dealerB, amount: usd(8_000), now: clock.now() }).listing;

    // 15:21 — C takes it past what Gilroy would have paid.
    clock.advance(4 * MINUTE);
    listing = placeBid(listing, { bidder: dealerC, amount: usd(9_200), now: clock.now() }).listing;
    expect(currentPrice(listing)).toBe(usd(9_200));

    // 15:26 — D pushes it further.
    clock.advance(5 * MINUTE);
    listing = placeBid(listing, { bidder: dealerD, amount: usd(10_400), now: clock.now() }).listing;

    // 15:29:40 — B comes back inside the final minute, so the clock stretches.
    clock.set(new Date(listing.closesAt!.getTime() - 20_000));
    const late = placeBid(listing, { bidder: dealerB, amount: usd(11_000), now: clock.now() });
    listing = late.listing;
    expect(late.extended).toBe(true);

    // Nobody answers. The lane closes on its own.
    clock.set(listing.closesAt!);
    listing = advance(listing, clock.now());
    expect(listing.status).toBe('awarded');

    // Bounded: the customer was told fifteen minutes and waited under twenty.
    const runMs = listing.closesAt!.getTime() - listing.opensAt!.getTime();
    expect(runMs).toBeLessThanOrEqual(
      DEFAULT_AUCTION_RULES.runTimeMs + DEFAULT_AUCTION_RULES.maxTotalExtensionMs,
    );

    // The trade brought $2,000 more than Gilroy was going to put in it.
    let sale = awardSale(listing, clock.now());
    expect(sale.buyerDealerId).toBe('dealer-b');
    expect(sale.price).toBe(usd(11_000));
    expect(formatUsd(sale.price)).toBe('$11,000.00');
    expect(sale.price - usd(9_000)).toBe(usd(2_000));

    // Both sides know their fee before anyone signs anything.
    expect(sale.fees.buyerTotal).toBe(usd(11_349));
    expect(sale.fees.sellerProceeds).toBe(usd(10_901));
    expect(sale.fees.platformRevenue).toBe(usd(448));

    // The gate pass exists at the hammer — towing is already dispatchable.
    expect(sale.status).toBe('transport_pending');
    const gatePass = sale.transport.gatePassToken;

    // 15:45 — a carrier takes the run and scans the QR off the paperwork.
    clock.advance(15 * MINUTE);
    sale = assignCarrier(sale, 'carrier-1', clock.now());
    clock.advance(90 * MINUTE);
    sale = confirmPickup(sale, gatePass, clock.now());

    // 19:00 — delivered to B, which starts the 24-hour inspection clock.
    clock.advance(2 * HOUR);
    sale = confirmDelivery(sale, gatePass, clock.now());
    expect(sale.status).toBe('delivered');
    expect(sale.inspectionDeadline).toEqual(new Date(clock.now().getTime() + 24 * HOUR));

    // Next morning B looks it over and finalizes.
    clock.advance(16 * HOUR);
    sale = acceptDelivery(sale, clock.now());

    // Gilroy gets paid.
    sale = settle(sale, clock.now());
    expect(sale.status).toBe('paid');
    expect(sale.paidAt).toEqual(clock.now());
  });
});
