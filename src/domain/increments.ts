import { type Cents, add, dollars } from './money.js';

/**
 * Bid increments scale with price the way a physical lane does. A $50 step on a
 * $40,000 truck wastes the clock; a $500 step on a $3,000 unit kills the bidding.
 */
interface IncrementTier {
  /** Applies while the current price is at or above this floor. */
  readonly floor: Cents;
  readonly increment: Cents;
}

/** Ordered high floor first so the first match wins. */
const TIERS: readonly IncrementTier[] = [
  { floor: dollars(30_000), increment: dollars(500) },
  { floor: dollars(15_000), increment: dollars(250) },
  { floor: dollars(5_000), increment: dollars(100) },
  { floor: dollars(0), increment: dollars(50) },
];

export function incrementFor(price: Cents): Cents {
  for (const tier of TIERS) {
    if (price >= tier.floor) {
      return tier.increment;
    }
  }
  // Unreachable: the last tier has a floor of zero and price is never negative.
  throw new Error(`No increment tier matched price ${price}`);
}

/** The lowest bid the floor will accept right now. */
export function nextValidBid(currentPrice: Cents): Cents {
  return add(currentPrice, incrementFor(currentPrice));
}
