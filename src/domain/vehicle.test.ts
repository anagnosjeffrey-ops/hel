import { describe, expect, it } from 'vitest';
import {
  assertVehicleIsListable,
  findVehicleProblems,
  hasValidCheckDigit,
  isWellFormedVin,
} from './vehicle.js';
import { DomainError } from './errors.js';
import { GOOD_VIN, T0, photoSet, vehicle } from '../testing/fixtures.js';

describe('VIN validation', () => {
  it('accepts a well-formed VIN', () => {
    expect(isWellFormedVin(GOOD_VIN)).toBe(true);
  });

  it('rejects the letters that are not allowed in a VIN', () => {
    expect(isWellFormedVin('1HGCM82633A00435I')).toBe(false);
    expect(isWellFormedVin('1HGCM82633A00435O')).toBe(false);
    expect(isWellFormedVin('1HGCM82633A00435Q')).toBe(false);
  });

  it('rejects the wrong length', () => {
    expect(isWellFormedVin('1HGCM82633A0043')).toBe(false);
  });

  it('verifies the ISO 3779 check digit', () => {
    expect(hasValidCheckDigit(GOOD_VIN)).toBe(true);
  });

  it('catches a transposed character via the check digit', () => {
    const transposed = '1HGCM82633A004325';
    expect(isWellFormedVin(transposed)).toBe(true);
    expect(hasValidCheckDigit(transposed)).toBe(false);
  });
});

describe('listability', () => {
  it('passes a complete unit', () => {
    expect(findVehicleProblems(vehicle())).toEqual([]);
  });

  it('names every missing required photo at once', () => {
    const problems = findVehicleProblems(
      vehicle({
        photos: photoSet(T0).filter((p) => p.angle !== 'odometer' && p.angle !== 'vin_plate'),
      }),
    );
    expect(problems.map((p) => p.field)).toEqual(['photos.odometer', 'photos.vin_plate']);
  });

  it('requires a damage photo when damage is disclosed', () => {
    const problems = findVehicleProblems(
      vehicle({ disclosures: [{ code: 'frame_damage', note: 'Right rear frame rail repaired.' }] }),
    );
    expect(problems.map((p) => p.field)).toContain('photos.damage');
  });

  it('accepts disclosed damage once it is photographed', () => {
    const problems = findVehicleProblems(
      vehicle({
        disclosures: [{ code: 'frame_damage', note: 'Right rear frame rail repaired.' }],
        photos: photoSet(T0, [
          { angle: 'damage', url: 'https://cdn.autobank.test/damage.jpg', takenAt: T0 },
        ]),
      }),
    );
    expect(problems).toEqual([]);
  });

  it('requires a written note on every disclosure', () => {
    const problems = findVehicleProblems(
      vehicle({ disclosures: [{ code: 'warning_light', note: '   ' }] }),
    );
    expect(problems.map((p) => p.field)).toContain('disclosures.warning_light');
  });

  it('reports several independent problems together', () => {
    const problems = findVehicleProblems(vehicle({ vin: 'NOPE', make: '', odometerMiles: -5 }));
    expect(problems.map((p) => p.field)).toEqual(['vin', 'make', 'odometerMiles']);
  });

  it('throws a domain error when asserted', () => {
    expect(() => assertVehicleIsListable(vehicle({ photos: [] }))).toThrow(DomainError);
  });
});
