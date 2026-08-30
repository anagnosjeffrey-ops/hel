import { describe, expect, it } from 'vitest';
import { buyerFeeFor, quoteFees } from './fees.js';
import { dollars } from './money.js';

describe('fees', () => {
  it.each([
    [3_000, 149],
    [5_000, 249],
    [9_999, 249],
    [10_000, 349],
    [19_999, 349],
    [20_000, 449],
    [85_000, 449],
  ])('charges a $%d sale a flat $%d buyer fee', (price, fee) => {
    expect(buyerFeeFor(dollars(price))).toBe(dollars(fee));
  });

  it('quotes both sides of a sale so neither is surprised', () => {
    const quote = quoteFees(dollars(14_250));
    expect(quote.buyerFee).toBe(dollars(349));
    expect(quote.sellerFee).toBe(dollars(99));
    expect(quote.buyerTotal).toBe(dollars(14_599));
    expect(quote.sellerProceeds).toBe(dollars(14_151));
    expect(quote.platformRevenue).toBe(dollars(448));
  });

  it('keeps the fee flat as the price moves inside a tier', () => {
    expect(quoteFees(dollars(10_000)).buyerFee).toBe(quoteFees(dollars(19_999)).buyerFee);
  });
});
