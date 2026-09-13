import type { Clock } from '../domain/clock.js';
import type { Stores } from '../store/types.js';
import { NotFoundError } from '../store/types.js';
import type { EventBus } from '../realtime/events.js';
import type { Cents } from '../domain/money.js';
import type { Vehicle } from '../domain/vehicle.js';
import {
  type AuctionRules,
  type Listing,
  advance,
  cancel,
  createListing,
  currentPrice,
  highestBid,
  minimumNextBid,
  placeBid,
  reserveState,
  schedule,
} from '../domain/listing.js';
import { type FeeSchedule, DEFAULT_FEE_SCHEDULE } from '../domain/fees.js';
import { type FulfillmentRules, awardSale } from '../domain/fulfillment.js';
import { DomainError } from '../domain/errors.js';
import { ForbiddenError } from './errors.js';

export interface AuctionServiceDeps {
  readonly stores: Stores;
  readonly bus: EventBus;
  readonly clock: Clock;
  readonly auctionRules?: AuctionRules;
  readonly feeSchedule?: FeeSchedule;
  readonly fulfillmentRules?: FulfillmentRules;
}

export interface CreateListingCommand {
  readonly sellerDealerId: string;
  readonly vehicle: Vehicle;
  readonly startingBid: Cents;
  readonly reserve?: Cents | null;
}

export interface TickReport {
  readonly opened: string[];
  readonly closed: string[];
  readonly awarded: string[];
  readonly autoAccepted: string[];
}

/**
 * Commands against a lane. Each one loads the actor, runs the domain rule under
 * a row lock, and only then publishes — so nothing is broadcast that did not
 * actually commit.
 */
export class AuctionService {
  readonly #deps: AuctionServiceDeps;

  constructor(deps: AuctionServiceDeps) {
    this.#deps = deps;
  }

  async createDraft(command: CreateListingCommand): Promise<Listing> {
    const seller = await this.#requireDealer(command.sellerDealerId);
    const listing = createListing({
      seller,
      vehicle: command.vehicle,
      startingBid: command.startingBid,
      reserve: command.reserve ?? null,
      now: this.#deps.clock.now(),
      ...(this.#deps.auctionRules ? { rules: this.#deps.auctionRules } : {}),
    });
    await this.#deps.stores.listings.insert(listing);
    return listing;
  }

  /** Publish a draft. The lead-time countdown starts here. */
  async publish(listingId: string, actorDealerId: string): Promise<Listing> {
    const now = this.#deps.clock.now();
    const published = await this.#deps.stores.listings.mutate(listingId, (listing) => {
      this.#assertSeller(listing, actorDealerId);
      const next = schedule(listing, now);
      return { next, result: next };
    });

    await this.#deps.bus.publish({
      type: 'listing.scheduled',
      listingId: published.id,
      opensAt: published.opensAt!.toISOString(),
      closesAt: published.closesAt!.toISOString(),
      at: now.toISOString(),
    });
    return published;
  }

  async placeBid(
    listingId: string,
    bidderDealerId: string,
    amount: Cents,
  ): Promise<{ listing: Listing; bidId: string }> {
    const bidder = await this.#requireDealer(bidderDealerId);
    const now = this.#deps.clock.now();

    const { listing, bidId, extended } = await this.#deps.stores.listings.mutate(
      listingId,
      (current) => {
        const result = placeBid(current, { bidder, amount, now });
        return {
          next: result.listing,
          result: { listing: result.listing, bidId: result.bid.id, extended: result.extended },
        };
      },
    );

    await this.#deps.bus.publish({
      type: 'bid.placed',
      listingId,
      bidId,
      dealerId: bidderDealerId,
      amount,
      minimumNextBid: minimumNextBid(listing),
      reserveState: reserveState(listing),
      closesAt: listing.closesAt!.toISOString(),
      extended,
      at: now.toISOString(),
    });

    return { listing, bidId };
  }

  async cancel(listingId: string, actorDealerId: string): Promise<Listing> {
    const now = this.#deps.clock.now();
    return this.#deps.stores.listings.mutate(listingId, (listing) => {
      this.#assertSeller(listing, actorDealerId);
      const next = cancel(listing, now);
      return { next, result: next };
    });
  }

  async getListing(listingId: string): Promise<Listing> {
    const listing = await this.#deps.stores.listings.get(listingId);
    if (listing === null) throw new NotFoundError('Listing', listingId);
    return listing;
  }

  async listOpen(): Promise<Listing[]> {
    return this.#deps.stores.listings.listOpen();
  }

  /**
   * Advance every lane the clock has work for, then reconcile any awarded lane
   * that has no sale row yet.
   *
   * Safe to run concurrently on several instances and safe to re-run: each step
   * takes the row lock, and the domain transitions are no-ops once applied.
   */
  async tick(): Promise<TickReport> {
    const now = this.#deps.clock.now();
    const report: TickReport = { opened: [], closed: [], awarded: [], autoAccepted: [] };

    for (const due of await this.#deps.stores.listings.findDue(now)) {
      const before = due.status;
      const after = await this.#deps.stores.listings.mutate(due.id, (listing) => {
        const next = advance(listing, now);
        return { next, result: next };
      });

      if (before === 'scheduled' && after.status === 'live') {
        report.opened.push(after.id);
        await this.#deps.bus.publish({
          type: 'listing.opened',
          listingId: after.id,
          closesAt: after.closesAt!.toISOString(),
          minimumNextBid: minimumNextBid(after),
          at: now.toISOString(),
        });
      }

      if (before === 'live' && (after.status === 'awarded' || after.status === 'no_sale')) {
        report.closed.push(after.id);
        const winner = highestBid(after);
        await this.#deps.bus.publish({
          type: 'listing.closed',
          listingId: after.id,
          outcome: after.status,
          price: after.status === 'awarded' ? currentPrice(after) : null,
          buyerDealerId: after.status === 'awarded' ? (winner?.dealerId ?? null) : null,
          at: now.toISOString(),
        });
      }
    }

    for (const awarded of await this.#deps.stores.listings.findAwarded()) {
      const saleId = await this.#ensureSale(awarded, now);
      if (saleId !== null) report.awarded.push(awarded.id);
    }

    return report;
  }

  /**
   * Create the sale for an awarded lane if it does not exist. Returns null when
   * one already does, which is the normal case on every tick after the first.
   */
  async #ensureSale(listing: Listing, now: Date): Promise<string | null> {
    const existing = await this.#deps.stores.sales.findByListing(listing.id);
    if (existing !== null) return null;

    const sale = awardSale(listing, now, {
      ...(this.#deps.feeSchedule ? { feeSchedule: this.#deps.feeSchedule } : {}),
      ...(this.#deps.fulfillmentRules ? { rules: this.#deps.fulfillmentRules } : {}),
    });

    try {
      await this.#deps.stores.sales.insert(sale);
    } catch (error) {
      // Another instance won the race on its own tick. The unique constraint on
      // listing_id is what makes that safe rather than a double sale.
      if ((await this.#deps.stores.sales.findByListing(listing.id)) !== null) return null;
      throw error;
    }

    await this.#deps.bus.publish({
      type: 'sale.awarded',
      listingId: listing.id,
      saleId: sale.id,
      buyerDealerId: sale.buyerDealerId,
      price: sale.price,
      at: now.toISOString(),
    });
    return sale.id;
  }

  #assertSeller(listing: Listing, actorDealerId: string): void {
    if (listing.sellerDealerId !== actorDealerId) {
      throw new ForbiddenError(`Dealer ${actorDealerId} does not own listing ${listing.id}.`);
    }
  }

  async #requireDealer(dealerId: string) {
    const dealer = await this.#deps.stores.dealers.get(dealerId);
    if (dealer === null) {
      throw new DomainError('DEALER_NOT_ELIGIBLE', `Dealer ${dealerId} is not registered.`);
    }
    return dealer;
  }
}

export { DEFAULT_FEE_SCHEDULE };
