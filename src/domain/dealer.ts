import type { Cents } from './money.js';
import { type Subscription, canTransact } from './subscription.js';

export interface Dealer {
  readonly id: string;
  readonly name: string;
  /** Franchise rooftop, independent lot, or a group operating several. */
  readonly rooftopCount: number;
  readonly subscription: Subscription;
  /** Dealer licence and floor-plan checks cleared by the platform. */
  readonly verified: boolean;
  /** Per-listing ceiling the platform will let this dealer commit to. */
  readonly bidLimit: Cents | null;
}

export function canSell(dealer: Dealer): boolean {
  return dealer.verified && canTransact(dealer.subscription);
}

export function canBid(dealer: Dealer): boolean {
  return dealer.verified && canTransact(dealer.subscription);
}
