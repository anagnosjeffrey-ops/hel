import { describe, expect, it } from 'vitest';
import { add, cents, dollars, formatUsd, subtract, sum, ZERO } from './money.js';

describe('money', () => {
  it('rejects fractional cents rather than silently rounding', () => {
    expect(() => cents(10.5)).toThrow(RangeError);
  });

  it('rejects negative money', () => {
    expect(() => cents(-1)).toThrow(RangeError);
  });

  it('converts dollars without floating point drift', () => {
    expect(dollars(12_500)).toBe(1_250_000);
    expect(dollars(1234.56)).toBe(123_456);
    expect(dollars(0.07)).toBe(7);
  });

  it('adds, subtracts, and sums', () => {
    expect(add(dollars(100), dollars(25))).toBe(dollars(125));
    expect(subtract(dollars(100), dollars(25))).toBe(dollars(75));
    expect(sum([dollars(1), dollars(2), dollars(3)])).toBe(dollars(6));
    expect(sum([])).toBe(ZERO);
  });

  it('formats for display', () => {
    expect(formatUsd(dollars(12_500))).toBe('$12,500.00');
    expect(formatUsd(dollars(1234.5))).toBe('$1,234.50');
  });
});
