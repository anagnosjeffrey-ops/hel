/**
 * Domain functions take an explicit `now`, so every rule is testable without
 * waiting fifteen real minutes. The Clock exists for the application layer that
 * drives the ticks.
 */
export interface Clock {
  now(): Date;
}

export const systemClock: Clock = {
  now: () => new Date(),
};

/** Test clock. Advance it deliberately; never let a test depend on wall time. */
export class FixedClock implements Clock {
  #current: Date;

  constructor(start: Date) {
    this.#current = new Date(start.getTime());
  }

  now(): Date {
    return new Date(this.#current.getTime());
  }

  advance(ms: number): Date {
    this.#current = new Date(this.#current.getTime() + ms);
    return this.now();
  }

  set(next: Date): Date {
    this.#current = new Date(next.getTime());
    return this.now();
  }
}
