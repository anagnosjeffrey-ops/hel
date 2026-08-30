import type { Dealer } from '../domain/dealer.js';
import { type Cents, dollars } from '../domain/money.js';
import { REQUIRED_PHOTO_ANGLES, type Photo, type Vehicle } from '../domain/vehicle.js';

/** A VIN with a valid ISO 3779 check digit, used across the suite. */
export const GOOD_VIN = '1HGCM82633A004352';

export const T0 = new Date('2026-03-02T15:00:00.000Z');

export function photoSet(takenAt: Date = T0, extra: readonly Photo[] = []): Photo[] {
  return [
    ...REQUIRED_PHOTO_ANGLES.map((angle) => ({
      angle,
      url: `https://cdn.autobank.test/${angle}.jpg`,
      takenAt,
    })),
    ...extra,
  ];
}

export function vehicle(overrides: Partial<Vehicle> = {}): Vehicle {
  return {
    vin: GOOD_VIN,
    year: 2019,
    make: 'Toyota',
    model: 'Tacoma',
    trim: 'TRD Off-Road',
    odometerMiles: 68_412,
    titleStatus: 'clean',
    keyCount: 2,
    photos: photoSet(),
    disclosures: [],
    ...overrides,
  };
}

export function dealer(id: string, overrides: Partial<Dealer> = {}): Dealer {
  return {
    id,
    name: `${id} Motors`,
    rooftopCount: 1,
    subscription: { planId: 'dealer', status: 'active' },
    verified: true,
    bidLimit: null,
    ...overrides,
  };
}

export const usd = (value: number): Cents => dollars(value);
