import type { Cents } from '../domain/money.js';
import {
  type Listing,
  type ReserveState,
  currentPrice,
  highestBid,
  minimumNextBid,
  reserveState,
} from '../domain/listing.js';
import type { Sale } from '../domain/fulfillment.js';
import type { Vehicle } from '../domain/vehicle.js';

/**
 * What a bidding dealer is allowed to see.
 *
 * The reserve number is absent by construction, not filtered out downstream. If
 * it were a nullable field on this type, one forgotten branch would leak the
 * seller's floor and turn the auction into a fixed price.
 */
export interface PublicListingView {
  readonly id: string;
  readonly sellerDealerId: string;
  readonly vehicle: Vehicle;
  readonly status: Listing['status'];
  readonly startingBid: Cents;
  readonly currentPrice: Cents;
  readonly minimumNextBid: Cents;
  readonly reserveState: ReserveState;
  readonly bidCount: number;
  readonly highBidderDealerId: string | null;
  readonly opensAt: string | null;
  readonly closesAt: string | null;
  readonly extendedMs: number;
  readonly bids: readonly {
    readonly id: string;
    readonly dealerId: string;
    readonly amount: Cents;
    readonly placedAt: string;
  }[];
}

export function toPublicListing(listing: Listing): PublicListingView {
  return {
    id: listing.id,
    sellerDealerId: listing.sellerDealerId,
    vehicle: listing.vehicle,
    status: listing.status,
    startingBid: listing.startingBid,
    currentPrice: currentPrice(listing),
    minimumNextBid: minimumNextBid(listing),
    reserveState: reserveState(listing),
    bidCount: listing.bids.length,
    highBidderDealerId: highestBid(listing)?.dealerId ?? null,
    opensAt: listing.opensAt?.toISOString() ?? null,
    closesAt: listing.closesAt?.toISOString() ?? null,
    extendedMs: listing.extendedMs,
    bids: listing.bids.map((bid) => ({
      id: bid.id,
      dealerId: bid.dealerId,
      amount: bid.amount,
      placedAt: bid.placedAt.toISOString(),
    })),
  };
}

/** The seller's own view of its lane — the only view carrying the reserve. */
export interface SellerListingView extends PublicListingView {
  readonly reserve: Cents | null;
}

export function toSellerListing(listing: Listing): SellerListingView {
  return { ...toPublicListing(listing), reserve: listing.reserve };
}

export interface SaleView {
  readonly id: string;
  readonly listingId: string;
  readonly sellerDealerId: string;
  readonly buyerDealerId: string;
  readonly status: Sale['status'];
  readonly price: Cents;
  readonly fees: Sale['fees'];
  readonly awardedAt: string;
  readonly inspectionDeadline: string | null;
  readonly transport: {
    readonly carrierId: string | null;
    readonly assignedAt: string | null;
    readonly pickedUpAt: string | null;
    readonly deliveredAt: string | null;
  };
}

/**
 * The gate pass token is deliberately absent. It is a bearer credential that
 * moves a vehicle — it belongs in the QR handed to the carrier, not in an API
 * response anyone with sale access can read.
 */
export function toSaleView(sale: Sale): SaleView {
  return {
    id: sale.id,
    listingId: sale.listingId,
    sellerDealerId: sale.sellerDealerId,
    buyerDealerId: sale.buyerDealerId,
    status: sale.status,
    price: sale.price,
    fees: sale.fees,
    awardedAt: sale.awardedAt.toISOString(),
    inspectionDeadline: sale.inspectionDeadline?.toISOString() ?? null,
    transport: {
      carrierId: sale.transport.carrierId,
      assignedAt: sale.transport.assignedAt?.toISOString() ?? null,
      pickedUpAt: sale.transport.pickedUpAt?.toISOString() ?? null,
      deliveredAt: sale.transport.deliveredAt?.toISOString() ?? null,
    },
  };
}
