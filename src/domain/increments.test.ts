import { describe, expect, it } from 'vitest';
import { incrementFor, nextValidBid } from './increments.js';
import { dollars } from './money.js';

describe('bid increments', () => {
  it.each([
    [0, 50],
    [4_999, 50],
    [5_000, 100],
    [14_999, 100],
    [15_000, 250],
    [29_999, 250],
    [30_000, 500],
    [120_000, 500],
  ])('a $%d unit steps by $%d', (price, step) => {
    expect(incrementFor(dollars(price))).toBe(dollars(step));
  });

  it('computes the next acceptable bid at a tier boundary', () => {
    expect(nextValidBid(dollars(4_999))).toBe(dollars(5_049));
    expect(nextValidBid(dollars(29_900))).toBe(dollars(30_150));
  });
});
