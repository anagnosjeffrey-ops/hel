import { DomainError } from './errors.js';

/**
 * The camera angles a seller must capture before a unit may open. Dealers B
 * through E are bidding sight-unseen on a fifteen-minute clock; a guaranteed
 * photo set is the only thing that makes that a fair ask.
 */
export const REQUIRED_PHOTO_ANGLES = [
  'front_34',
  'rear_34',
  'driver_side',
  'passenger_side',
  'interior_front',
  'odometer',
  'engine_bay',
  'vin_plate',
] as const;

export const OPTIONAL_PHOTO_ANGLES = [
  'damage',
  'undercarriage',
  'tire_tread',
  'service_record',
] as const;

export type PhotoAngle =
  (typeof REQUIRED_PHOTO_ANGLES)[number] | (typeof OPTIONAL_PHOTO_ANGLES)[number];

export interface Photo {
  readonly angle: PhotoAngle;
  readonly url: string;
  readonly takenAt: Date;
}

export type TitleStatus = 'clean' | 'branded' | 'salvage' | 'unknown';

export type DisclosureCode =
  | 'frame_damage'
  | 'prior_paint'
  | 'warning_light'
  | 'mechanical_issue'
  | 'odometer_discrepancy'
  | 'flood'
  | 'aftermarket_modification'
  | 'missing_key';

/** Disclosures that cannot stand on text alone — the buyer must see it. */
const PHOTO_BACKED_DISCLOSURES: ReadonlySet<DisclosureCode> = new Set([
  'frame_damage',
  'prior_paint',
  'mechanical_issue',
  'flood',
]);

export interface Disclosure {
  readonly code: DisclosureCode;
  readonly note: string;
}

export interface Vehicle {
  readonly vin: string;
  readonly year: number;
  readonly make: string;
  readonly model: string;
  readonly trim: string | null;
  readonly odometerMiles: number;
  readonly titleStatus: TitleStatus;
  readonly keyCount: number;
  readonly photos: readonly Photo[];
  readonly disclosures: readonly Disclosure[];
}

const VIN_PATTERN = /^[A-HJ-NPR-Z0-9]{17}$/;

export function isWellFormedVin(vin: string): boolean {
  return VIN_PATTERN.test(vin.toUpperCase());
}

const TRANSLITERATION: Readonly<Record<string, number>> = {
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
const WEIGHTS = [8, 7, 6, 5, 4, 3, 2, 10, 0, 9, 8, 7, 6, 5, 4, 3, 2] as const;

/**
 * ISO 3779 check digit (position 9). North American VINs carry it, imports may
 * not — so a failure is surfaced as a warning on the listing rather than a hard
 * block. It exists to catch a mistyped character on the showroom floor, which
 * is the difference between the right car and a chargeback.
 */
export function hasValidCheckDigit(vin: string): boolean {
  const upper = vin.toUpperCase();
  if (!isWellFormedVin(upper)) return false;

  let total = 0;
  for (let i = 0; i < 17; i += 1) {
    const char = upper[i]!;
    const value = /\d/.test(char) ? Number(char) : TRANSLITERATION[char];
    if (value === undefined) return false;
    total += value * WEIGHTS[i]!;
  }

  const remainder = total % 11;
  const expected = remainder === 10 ? 'X' : String(remainder);
  return upper[8] === expected;
}

export interface VehicleProblem {
  readonly field: string;
  readonly message: string;
}

/**
 * Everything wrong with a unit, returned at once. A seller standing next to a
 * waiting customer should not fix one field, resubmit, and be told about the
 * next one.
 */
export function findVehicleProblems(vehicle: Vehicle): VehicleProblem[] {
  const problems: VehicleProblem[] = [];

  if (!isWellFormedVin(vehicle.vin)) {
    problems.push({ field: 'vin', message: 'VIN must be 17 characters and exclude I, O, and Q.' });
  }

  const currentYear = new Date().getUTCFullYear();
  if (!Number.isInteger(vehicle.year) || vehicle.year < 1900 || vehicle.year > currentYear + 2) {
    problems.push({ field: 'year', message: `Year must be between 1900 and ${currentYear + 2}.` });
  }

  if (vehicle.make.trim() === '') {
    problems.push({ field: 'make', message: 'Make is required.' });
  }
  if (vehicle.model.trim() === '') {
    problems.push({ field: 'model', message: 'Model is required.' });
  }

  if (!Number.isInteger(vehicle.odometerMiles) || vehicle.odometerMiles < 0) {
    problems.push({
      field: 'odometerMiles',
      message: 'Odometer must be a whole, non-negative number.',
    });
  }

  if (!Number.isInteger(vehicle.keyCount) || vehicle.keyCount < 0) {
    problems.push({
      field: 'keyCount',
      message: 'Key count must be a whole, non-negative number.',
    });
  }

  const captured = new Set(vehicle.photos.map((photo) => photo.angle));
  for (const angle of REQUIRED_PHOTO_ANGLES) {
    if (!captured.has(angle)) {
      problems.push({ field: `photos.${angle}`, message: `A "${angle}" photo is required.` });
    }
  }

  const needsDamagePhoto = vehicle.disclosures.some((d) => PHOTO_BACKED_DISCLOSURES.has(d.code));
  if (needsDamagePhoto && !captured.has('damage')) {
    problems.push({
      field: 'photos.damage',
      message: 'Disclosed damage must be shown in at least one "damage" photo.',
    });
  }

  for (const disclosure of vehicle.disclosures) {
    if (disclosure.note.trim() === '') {
      problems.push({
        field: `disclosures.${disclosure.code}`,
        message: 'Every disclosure needs a written note.',
      });
    }
  }

  return problems;
}

export function assertVehicleIsListable(vehicle: Vehicle): void {
  const problems = findVehicleProblems(vehicle);
  if (problems.length > 0) {
    throw new DomainError(
      'INVALID_LISTING',
      `Vehicle is not ready to list: ${problems.map((p) => p.message).join(' ')}`,
    );
  }
}
