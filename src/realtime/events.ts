import type { Cents } from '../domain/money.js';
import type { ReserveState } from '../domain/listing.js';
import type { SaleStatus } from '../domain/fulfillment.js';

/**
 * What a lane broadcasts. A dealer watching a fifteen-minute run needs the
 * price, the clock, and whether the reserve is met — every one of those can
 * change on any bid, so each event carries the full current picture rather than
 * a delta the client has to reassemble.
 */
export type AuctionEvent =
  | {
      readonly type: 'listing.scheduled';
      readonly listingId: string;
      readonly opensAt: string;
      readonly closesAt: string;
      readonly at: string;
    }
  | {
      readonly type: 'listing.opened';
      readonly listingId: string;
      readonly closesAt: string;
      readonly minimumNextBid: Cents;
      readonly at: string;
    }
  | {
      readonly type: 'bid.placed';
      readonly listingId: string;
      readonly bidId: string;
      /** Who bid. Buyers see this; it is the seller's lane, not a blind pool. */
      readonly dealerId: string;
      readonly amount: Cents;
      readonly minimumNextBid: Cents;
      readonly reserveState: ReserveState;
      readonly closesAt: string;
      /** True when this bid pushed the close out. */
      readonly extended: boolean;
      readonly at: string;
    }
  | {
      readonly type: 'listing.closed';
      readonly listingId: string;
      readonly outcome: 'awarded' | 'no_sale';
      readonly price: Cents | null;
      readonly buyerDealerId: string | null;
      readonly at: string;
    }
  | {
      readonly type: 'sale.awarded';
      readonly listingId: string;
      readonly saleId: string;
      readonly buyerDealerId: string;
      readonly price: Cents;
      readonly at: string;
    }
  | {
      readonly type: 'sale.progressed';
      readonly listingId: string;
      readonly saleId: string;
      readonly status: SaleStatus;
      readonly at: string;
    };

/** Every subscriber to this topic sees every lane. */
export const ALL_LANES = '*';

export type EventHandler = (event: AuctionEvent) => void;
export type Unsubscribe = () => void;

export interface EventBus {
  publish(event: AuctionEvent): Promise<void>;
  /** `topic` is a listing id, or `ALL_LANES` for the lane-list feed. */
  subscribe(topic: string, handler: EventHandler): Unsubscribe;
  close(): Promise<void>;
}
