/**
 * VIN checks, mirrored from `src/domain/vehicle.ts`.
 *
 * Duplicating a rule is a cost worth paying here: the manager is standing next
 * to the customer and needs to know the VIN is wrong before the round trip, and
 * dealership wifi is not something to depend on for that. The server still
 * validates — this copy is for speed, never for authority.
 */
const TRANSLITERATION = {
  A: 1,
  B: 2,
  C: 3,
  D: 4,
  E: 5,
  F: 6,
  G: 7,
  H: 8,
  J: 1,
  K: 2,
  L: 3,
  M: 4,
  N: 5,
  P: 7,
  R: 9,
  S: 2,
  T: 3,
  U: 4,
  V: 5,
  W: 6,
  X: 7,
  Y: 8,
  Z: 9,
};

const WEIGHTS = [8, 7, 6, 5, 4, 3, 2, 10, 0, 9, 8, 7, 6, 5, 4, 3, 2];

export function isWellFormedVin(vin) {
  return /^[A-HJ-NPR-Z0-9]{17}$/.test(String(vin).toUpperCase());
}

export function hasValidCheckDigit(vin) {
  const upper = String(vin).toUpperCase();
  if (!isWellFormedVin(upper)) return false;

  let total = 0;
  for (let i = 0; i < 17; i += 1) {
    const char = upper[i];
    const value = /\d/.test(char) ? Number(char) : TRANSLITERATION[char];
    if (value === undefined) return false;
    total += value * WEIGHTS[i];
  }

  const remainder = total % 11;
  return upper[8] === (remainder === 10 ? 'X' : String(remainder));
}

/**
 * What to show under the field as it is typed. A failed check digit is a
 * warning rather than a block: imports do not always carry one, and refusing a
 * real car because of that would be worse than the typo it catches.
 */
export function vinFeedback(vin) {
  const upper = String(vin).toUpperCase();
  if (upper.length === 0) return null;
  if (upper.length < 17) {
    return {
      tone: 'warn',
      message: `${17 - upper.length} more character${17 - upper.length === 1 ? '' : 's'}`,
    };
  }
  if (!isWellFormedVin(upper)) {
    return { tone: 'bad', message: 'A VIN is 17 characters and never contains I, O, or Q.' };
  }
  if (!hasValidCheckDigit(upper)) {
    return {
      tone: 'warn',
      message: 'Check digit does not match — worth a second look at the plate.',
    };
  }
  return { tone: 'good', message: 'VIN checks out.' };
}
