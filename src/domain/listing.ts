import { type Cents, ZERO } from './money.js';
import { DomainError, invariant } from './errors.js';
import { nextValidBid } from './increments.js';
import { type Dealer, canBid, canSell } from './dealer.js';
import { type Vehicle, assertVehicleIsListable } from './vehicle.js';
import { newId } from './ids.js';

export type ListingStatus = 'draft' | 'scheduled' | 'live' | 'awarded' | 'no_sale' | 'cancelled';

export interface AuctionRules {
  /** Delay between publishing and opening — time for buyers to look at it. */
  readonly leadTimeMs: number;
  /** Nominal length of the lane run. */
  readonly runTimeMs: number;
  /** A bid landing inside this window before close triggers an extension. */
  readonly softCloseWindowMs: number;
  /** How far each late bid pushes the close out. */
  readonly softCloseExtensionMs: number;
  /**
   * Hard ceiling on total extension. Soft close stops snipers from stealing a
   * trade under its worth, but the customer is sitting in the showroom — the
   * auction has to end on a promise the seller can make out loud.
   */
  readonly maxTotalExtensionMs: number;
  /** After a no-sale, how long the seller may still take the high bid. */
  readonly sellerDiscretionMs: number;
}

export const DEFAULT_AUCTION_RULES: AuctionRules = {
  leadTimeMs: 15 * 60_000,
  runTimeMs: 15 * 60_000,
  softCloseWindowMs: 60_000,
  softCloseExtensionMs: 60_000,
  maxTotalExtensionMs: 5 * 60_000,
  sellerDiscretionMs: 10 * 60_000,
};

export interface Bid {
  readonly id: string;
  readonly dealerId: string;
  readonly amount: Cents;
  readonly placedAt: Date;
}

export interface Listing {
  readonly id: string;
  readonly sellerDealerId: string;
  readonly vehicle: Vehicle;
  /** The floor the bidding starts from. Public. */
  readonly startingBid: Cents;
  /** The seller's true minimum. Never published — only whether it is met. */
  readonly reserve: Cents | null;
  readonly status: ListingStatus;
  readonly createdAt: Date;
  readonly opensAt: Date | null;
  readonly closesAt: Date | null;
  /** Total soft-close extension applied so far, against `maxTotalExtensionMs`. */
  readonly extendedMs: number;
  readonly bids: readonly Bid[];
  readonly rules: AuctionRules;
}

export interface CreateListingInput {
  readonly seller: Dealer;
  readonly vehicle: Vehicle;
  readonly startingBid: Cents;
  readonly reserve?: Cents | null;
  readonly now: Date;
  readonly rules?: AuctionRules;
}

export function createListing(input: CreateListingInput): Listing {
  invariant(
    canSell(input.seller),
    'DEALER_NOT_ELIGIBLE',
    `Dealer ${input.seller.id} is not cleared to list vehicles.`,
  );
  assertVehicleIsListable(input.vehicle);

  const reserve = input.reserve ?? null;
  if (reserve !== null && reserve < input.startingBid) {
    throw new DomainError(
      'INVALID_LISTING',
      'Reserve must be at or above the starting bid, otherwise the floor is meaningless.',
    );
  }

  return {
    id: newId('lst'),
    sellerDealerId: input.seller.id,
    vehicle: input.vehicle,
    startingBid: input.startingBid,
    reserve,
    status: 'draft',
    createdAt: input.now,
    opensAt: null,
    closesAt: null,
    extendedMs: 0,
    bids: [],
    rules: input.rules ?? DEFAULT_AUCTION_RULES,
  };
}

/** Publish the listing: the lead-time countdown starts now. */
export function schedule(listing: Listing, now: Date): Listing {
  invariant(
    listing.status === 'draft',
    'INVALID_TRANSITION',
    `Only a draft listing can be scheduled; this one is ${listing.status}.`,
  );

  const opensAt = new Date(now.getTime() + listing.rules.leadTimeMs);
  const closesAt = new Date(opensAt.getTime() + listing.rules.runTimeMs);

  return { ...listing, status: 'scheduled', opensAt, closesAt };
}

export function highestBid(listing: Listing): Bid | null {
  return listing.bids.length === 0 ? null : listing.bids[listing.bids.length - 1]!;
}

/** Zero until the first bid lands — the starting bid is a floor, not a price. */
export function currentPrice(listing: Listing): Cents {
  return highestBid(listing)?.amount ?? ZERO;
}

export function minimumNextBid(listing: Listing): Cents {
  const high = highestBid(listing);
  return high === null ? listing.startingBid : nextValidBid(high.amount);
}

export type ReserveState = 'no_reserve' | 'met' | 'not_met';

/**
 * Buyers see whether the reserve is met, never the number. Publishing the
 * figure turns the auction into a take-it-or-leave-it price; hiding whether it
 * is met wastes everyone's fifteen minutes.
 */
export function reserveState(listing: Listing): ReserveState {
  if (listing.reserve === null) return 'no_reserve';
  return currentPrice(listing) >= listing.reserve ? 'met' : 'not_met';
}

export function isReserveMet(listing: Listing): boolean {
  return reserveState(listing) !== 'not_met';
}

/**
 * Apply every transition the clock alone has earned. A worker calls this on a
 * tick; every command calls it first, so no caller can act on a stale status.
 */
export function advance(listing: Listing, now: Date): Listing {
  let current = listing;

  if (current.status === 'scheduled' && current.opensAt !== null && now >= current.opensAt) {
    current = { ...current, status: 'live' };
  }

  if (current.status === 'live' && current.closesAt !== null && now >= current.closesAt) {
    current = {
      ...current,
      status: isReserveMet(current) && current.bids.length > 0 ? 'awarded' : 'no_sale',
    };
  }

  return current;
}

export interface PlaceBidInput {
  readonly bidder: Dealer;
  readonly amount: Cents;
  readonly now: Date;
}

export interface PlaceBidResult {
  readonly listing: Listing;
  readonly bid: Bid;
  /** True when this bid pushed the close time out. */
  readonly extended: boolean;
}

export function placeBid(listing: Listing, input: PlaceBidInput): PlaceBidResult {
  const current = advance(listing, input.now);

  invariant(
    current.status === 'live',
    'AUCTION_NOT_LIVE',
    `Bidding is closed; the listing is ${current.status}.`,
  );
  invariant(
    input.bidder.id !== current.sellerDealerId,
    'SELF_BIDDING',
    'A seller may not bid on its own vehicle.',
  );
  invariant(
    canBid(input.bidder),
    'DEALER_NOT_ELIGIBLE',
    `Dealer ${input.bidder.id} is not cleared to bid.`,
  );
  invariant(
    highestBid(current)?.dealerId !== input.bidder.id,
    'SELF_BIDDING',
    'You are already the high bidder; bidding against yourself only costs you money.',
  );

  const minimum = minimumNextBid(current);
  invariant(
    input.amount >= minimum,
    'BID_TOO_LOW',
    `Bid must be at least ${minimum} cents; received ${input.amount}.`,
  );

  if (input.bidder.bidLimit !== null && input.amount > input.bidder.bidLimit) {
    throw new DomainError(
      'DEALER_NOT_ELIGIBLE',
      `Bid exceeds the ${input.bidder.bidLimit} cent limit set for dealer ${input.bidder.id}.`,
    );
  }

  const bid: Bid = {
    id: newId('bid'),
    dealerId: input.bidder.id,
    amount: input.amount,
    placedAt: input.now,
  };

  const { closesAt, extendedMs, extended } = applySoftClose(current, input.now);

  return {
    listing: { ...current, bids: [...current.bids, bid], closesAt, extendedMs },
    bid,
    extended,
  };
}

function applySoftClose(
  listing: Listing,
  now: Date,
): { closesAt: Date | null; extendedMs: number; extended: boolean } {
  const { closesAt, rules } = listing;
  if (closesAt === null) {
    return { closesAt, extendedMs: listing.extendedMs, extended: false };
  }

  const remainingMs = closesAt.getTime() - now.getTime();
  if (remainingMs > rules.softCloseWindowMs) {
    return { closesAt, extendedMs: listing.extendedMs, extended: false };
  }

  const headroomMs = rules.maxTotalExtensionMs - listing.extendedMs;
  if (headroomMs <= 0) {
    return { closesAt, extendedMs: listing.extendedMs, extended: false };
  }

  const target = now.getTime() + rules.softCloseExtensionMs;
  const grantedMs = Math.min(target - closesAt.getTime(), headroomMs);
  if (grantedMs <= 0) {
    return { closesAt, extendedMs: listing.extendedMs, extended: false };
  }

  return {
    closesAt: new Date(closesAt.getTime() + grantedMs),
    extendedMs: listing.extendedMs + grantedMs,
    extended: true,
  };
}

/**
 * The seller takes the high bid even though it fell short of reserve. Bounded
 * by the discretion window so a buying dealer is not left holding an open
 * commitment all afternoon.
 */
export function acceptUnderReserve(listing: Listing, now: Date): Listing {
  invariant(
    listing.status === 'no_sale',
    'INVALID_TRANSITION',
    `Only a no-sale listing can be accepted under reserve; this one is ${listing.status}.`,
  );
  invariant(listing.bids.length > 0, 'RESERVE_NOT_MET', 'There is no bid to accept.');
  invariant(listing.closesAt !== null, 'INVALID_TRANSITION', 'Listing never opened.');

  const deadline = listing.closesAt.getTime() + listing.rules.sellerDiscretionMs;
  invariant(
    now.getTime() <= deadline,
    'WINDOW_EXPIRED',
    'The window to accept the high bid has passed.',
  );

  return { ...listing, status: 'awarded' };
}

export function cancel(listing: Listing, now: Date): Listing {
  const current = advance(listing, now);
  invariant(
    current.status === 'draft' || current.status === 'scheduled',
    'INVALID_TRANSITION',
    `A listing can only be cancelled before it opens; this one is ${current.status}.`,
  );
  return { ...current, status: 'cancelled' };
}
