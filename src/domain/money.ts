/**
 * Money is always whole cents held in a safe integer. Floating point dollars
 * are never stored or compared — a half-cent rounding error on a $30,000 unit
 * is a real dispute, and disputes are what this platform exists to avoid.
 */
export type Cents = number & { readonly __brand: 'Cents' };

export function cents(value: number): Cents {
  if (!Number.isInteger(value)) {
    throw new RangeError(`Money must be whole cents, received ${value}`);
  }
  if (!Number.isSafeInteger(value)) {
    throw new RangeError(`Money is outside the safe integer range: ${value}`);
  }
  if (value < 0) {
    throw new RangeError(`Money must not be negative, received ${value}`);
  }
  return value as Cents;
}

/** Convert whole or fractional dollars to cents, e.g. `dollars(12_500)`. */
export function dollars(value: number): Cents {
  if (!Number.isFinite(value)) {
    throw new RangeError(`Dollars must be finite, received ${value}`);
  }
  return cents(Math.round(value * 100));
}

export const ZERO: Cents = cents(0);

export function add(a: Cents, b: Cents): Cents {
  return cents(a + b);
}

export function subtract(a: Cents, b: Cents): Cents {
  return cents(a - b);
}

export function sum(values: readonly Cents[]): Cents {
  return values.reduce<Cents>((acc, value) => add(acc, value), ZERO);
}

/** Format for display and for anything a dealer signs off on. */
export function formatUsd(value: Cents): string {
  return (value / 100).toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
  });
}
