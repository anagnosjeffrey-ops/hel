import { type Cents, dollars } from './money.js';

/**
 * The recurring half of the revenue model. Seats are per rooftop, not per user:
 * a dealership pays once and puts as many of its buyers in the lane as it wants.
 */
export type PlanId = 'starter' | 'dealer' | 'group';

export interface Plan {
  readonly id: PlanId;
  readonly monthlyFee: Cents;
  /** Listings a rooftop may run per month before overage applies. */
  readonly includedListings: number;
  readonly overagePerListing: Cents;
}

export const PLANS: Readonly<Record<PlanId, Plan>> = {
  starter: {
    id: 'starter',
    monthlyFee: dollars(199),
    includedListings: 10,
    overagePerListing: dollars(25),
  },
  dealer: {
    id: 'dealer',
    monthlyFee: dollars(499),
    includedListings: 40,
    overagePerListing: dollars(15),
  },
  group: {
    id: 'group',
    monthlyFee: dollars(1_499),
    includedListings: Number.POSITIVE_INFINITY,
    overagePerListing: dollars(0),
  },
};

export type SubscriptionStatus = 'trialing' | 'active' | 'past_due' | 'cancelled';

export interface Subscription {
  readonly planId: PlanId;
  readonly status: SubscriptionStatus;
}

/**
 * A past-due or cancelled rooftop keeps read access but loses the lane. Letting
 * a dealer bid on credit and then chasing the money is how marketplaces rot.
 */
export function canTransact(subscription: Subscription): boolean {
  return subscription.status === 'trialing' || subscription.status === 'active';
}

export function monthlyCharge(plan: Plan, listingsUsed: number): Cents {
  const overage = Math.max(0, listingsUsed - plan.includedListings);
  if (overage === 0 || !Number.isFinite(plan.includedListings)) {
    return plan.monthlyFee;
  }
  return (plan.monthlyFee + overage * plan.overagePerListing) as Cents;
}
