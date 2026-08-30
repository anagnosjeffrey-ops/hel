import { type Cents, add, dollars, sum } from './money.js';

/**
 * Flat, tiered, and published before the auction opens.
 *
 * A percentage fee moves while dealers are bidding, which means the number a
 * seller nets is unknown until the hammer falls. Flat tiers mean both sides can
 * read their exact fee off the listing page before the first bid — that is what
 * "up front, honest, and fair" has to mean in code, not just in marketing.
 */
export interface FeeSchedule {
  /** Applies while the sale price is at or above `floor`. Highest floor first. */
  readonly buyerTiers: readonly { readonly floor: Cents; readonly fee: Cents }[];
  readonly sellerFee: Cents;
}

export const DEFAULT_FEE_SCHEDULE: FeeSchedule = {
  buyerTiers: [
    { floor: dollars(20_000), fee: dollars(449) },
    { floor: dollars(10_000), fee: dollars(349) },
    { floor: dollars(5_000), fee: dollars(249) },
    { floor: dollars(0), fee: dollars(149) },
  ],
  sellerFee: dollars(99),
};

export interface FeeBreakdown {
  readonly salePrice: Cents;
  readonly buyerFee: Cents;
  readonly sellerFee: Cents;
  /** What the buying dealer is invoiced in total. */
  readonly buyerTotal: Cents;
  /** What the selling dealer is paid after the platform's cut. */
  readonly sellerProceeds: Cents;
  /** Platform revenue on this transaction, excluding subscription. */
  readonly platformRevenue: Cents;
}

export function buyerFeeFor(salePrice: Cents, schedule: FeeSchedule = DEFAULT_FEE_SCHEDULE): Cents {
  for (const tier of schedule.buyerTiers) {
    if (salePrice >= tier.floor) {
      return tier.fee;
    }
  }
  throw new Error(`No buyer fee tier matched sale price ${salePrice}`);
}

export function quoteFees(
  salePrice: Cents,
  schedule: FeeSchedule = DEFAULT_FEE_SCHEDULE,
): FeeBreakdown {
  const buyerFee = buyerFeeFor(salePrice, schedule);
  const sellerFee = schedule.sellerFee;
  return {
    salePrice,
    buyerFee,
    sellerFee,
    buyerTotal: add(salePrice, buyerFee),
    sellerProceeds: (salePrice - sellerFee) as Cents,
    platformRevenue: sum([buyerFee, sellerFee]),
  };
}
