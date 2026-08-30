import { timingSafeEqual } from 'node:crypto';
import type { Cents } from './money.js';
import { type FeeBreakdown, type FeeSchedule, DEFAULT_FEE_SCHEDULE, quoteFees } from './fees.js';
import { invariant } from './errors.js';
import { type Listing, highestBid } from './listing.js';
import { newId, newScanToken } from './ids.js';

export type SaleStatus =
  | 'transport_pending'
  | 'transport_assigned'
  | 'picked_up'
  | 'delivered'
  | 'accepted'
  | 'disputed'
  | 'paid'
  | 'unwound';

export interface TransportJob {
  readonly id: string;
  /**
   * Encoded into the QR on the gate pass. The carrier scans it at pickup and
   * again at drop-off, so the chain of custody is two timestamps rather than a
   * phone call anybody can misremember.
   */
  readonly gatePassToken: string;
  readonly carrierId: string | null;
  readonly assignedAt: Date | null;
  readonly pickedUpAt: Date | null;
  readonly deliveredAt: Date | null;
}

export interface FulfillmentRules {
  /** How long the buying dealer has to inspect before the sale sticks. */
  readonly inspectionWindowMs: number;
}

export const DEFAULT_FULFILLMENT_RULES: FulfillmentRules = {
  inspectionWindowMs: 24 * 60 * 60_000,
};

export interface Sale {
  readonly id: string;
  readonly listingId: string;
  readonly sellerDealerId: string;
  readonly buyerDealerId: string;
  readonly price: Cents;
  readonly fees: FeeBreakdown;
  readonly status: SaleStatus;
  readonly awardedAt: Date;
  readonly transport: TransportJob;
  /** Set the moment the unit is delivered; null until then. */
  readonly inspectionDeadline: Date | null;
  readonly acceptedAt: Date | null;
  readonly disputeReason: string | null;
  readonly paidAt: Date | null;
  readonly rules: FulfillmentRules;
}

/**
 * Turn an awarded listing into a sale. Transport is created in the same step —
 * the moment the hammer falls the gate pass exists, which is what lets towing
 * start before the customer has left the showroom.
 */
export function awardSale(
  listing: Listing,
  now: Date,
  options: { feeSchedule?: FeeSchedule; rules?: FulfillmentRules } = {},
): Sale {
  invariant(
    listing.status === 'awarded',
    'INVALID_TRANSITION',
    `Only an awarded listing produces a sale; this one is ${listing.status}.`,
  );

  const winner = highestBid(listing);
  invariant(winner !== null, 'INVALID_TRANSITION', 'An awarded listing must have a winning bid.');

  return {
    id: newId('sale'),
    listingId: listing.id,
    sellerDealerId: listing.sellerDealerId,
    buyerDealerId: winner.dealerId,
    price: winner.amount,
    fees: quoteFees(winner.amount, options.feeSchedule ?? DEFAULT_FEE_SCHEDULE),
    status: 'transport_pending',
    awardedAt: now,
    transport: {
      id: newId('trn'),
      gatePassToken: newScanToken(),
      carrierId: null,
      assignedAt: null,
      pickedUpAt: null,
      deliveredAt: null,
    },
    inspectionDeadline: null,
    acceptedAt: null,
    disputeReason: null,
    paidAt: null,
    rules: options.rules ?? DEFAULT_FULFILLMENT_RULES,
  };
}

/** Constant-time compare so a scan endpoint cannot be probed byte by byte. */
function tokenMatches(expected: string, provided: string): boolean {
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(provided, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function assignCarrier(sale: Sale, carrierId: string, now: Date): Sale {
  invariant(
    sale.status === 'transport_pending',
    'INVALID_TRANSITION',
    `Transport is already ${sale.status}.`,
  );
  return {
    ...sale,
    status: 'transport_assigned',
    transport: { ...sale.transport, carrierId, assignedAt: now },
  };
}

export function confirmPickup(sale: Sale, scannedToken: string, now: Date): Sale {
  invariant(
    sale.status === 'transport_assigned',
    'INVALID_TRANSITION',
    `Pickup expects an assigned carrier; the sale is ${sale.status}.`,
  );
  invariant(
    tokenMatches(sale.transport.gatePassToken, scannedToken),
    'INVALID_TOKEN',
    'Gate pass does not match this vehicle.',
  );
  return { ...sale, status: 'picked_up', transport: { ...sale.transport, pickedUpAt: now } };
}

/** Delivery starts the inspection clock. */
export function confirmDelivery(sale: Sale, scannedToken: string, now: Date): Sale {
  invariant(
    sale.status === 'picked_up',
    'INVALID_TRANSITION',
    `Delivery expects a vehicle in transit; the sale is ${sale.status}.`,
  );
  invariant(
    tokenMatches(sale.transport.gatePassToken, scannedToken),
    'INVALID_TOKEN',
    'Gate pass does not match this vehicle.',
  );
  return {
    ...sale,
    status: 'delivered',
    transport: { ...sale.transport, deliveredAt: now },
    inspectionDeadline: new Date(now.getTime() + sale.rules.inspectionWindowMs),
  };
}

export function acceptDelivery(sale: Sale, now: Date): Sale {
  invariant(
    sale.status === 'delivered',
    'INVALID_TRANSITION',
    `Only a delivered vehicle can be accepted; the sale is ${sale.status}.`,
  );
  return { ...sale, status: 'accepted', acceptedAt: now };
}

/**
 * Arbitration. Only open while the inspection window is running — past the
 * deadline the sale has already stuck, which is the promise that makes selling
 * here safe.
 */
export function openDispute(sale: Sale, reason: string, now: Date): Sale {
  invariant(
    sale.status === 'delivered',
    'INVALID_TRANSITION',
    `Only a delivered vehicle can be disputed; the sale is ${sale.status}.`,
  );
  invariant(reason.trim() !== '', 'INVALID_LISTING', 'A dispute needs a written reason.');
  invariant(
    sale.inspectionDeadline !== null,
    'INVALID_TRANSITION',
    'No inspection window is open.',
  );
  invariant(
    now <= sale.inspectionDeadline,
    'WINDOW_EXPIRED',
    'The 24-hour inspection window has closed and the sale is final.',
  );
  return { ...sale, status: 'disputed', disputeReason: reason };
}

/** Arbitration found for the buyer: the sale is undone and the unit goes back. */
export function unwind(sale: Sale): Sale {
  invariant(
    sale.status === 'disputed',
    'INVALID_TRANSITION',
    `Only a disputed sale can be unwound; the sale is ${sale.status}.`,
  );
  return { ...sale, status: 'unwound' };
}

/** Arbitration found for the seller: the sale stands. */
export function upholdSale(sale: Sale, now: Date): Sale {
  invariant(
    sale.status === 'disputed',
    'INVALID_TRANSITION',
    `Only a disputed sale can be upheld; the sale is ${sale.status}.`,
  );
  return { ...sale, status: 'accepted', acceptedAt: now };
}

/** Release funds to the selling dealer. */
export function settle(sale: Sale, now: Date): Sale {
  invariant(
    sale.status === 'accepted',
    'INVALID_TRANSITION',
    `Only an accepted sale can be settled; the sale is ${sale.status}.`,
  );
  return { ...sale, status: 'paid', paidAt: now };
}

/**
 * Clock-driven transitions. Silence from the buyer past the inspection deadline
 * is an acceptance — otherwise a seller's money sits behind someone else's
 * inbox, and the whole point is that the seller gets paid.
 */
export function advanceSale(sale: Sale, now: Date): Sale {
  if (
    sale.status === 'delivered' &&
    sale.inspectionDeadline !== null &&
    now > sale.inspectionDeadline
  ) {
    return { ...sale, status: 'accepted', acceptedAt: sale.inspectionDeadline };
  }
  return sale;
}
