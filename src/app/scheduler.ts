import type { AuctionService } from './auction-service.js';
import type { SaleService } from './sale-service.js';

export interface SchedulerOptions {
  /**
   * How often to sweep. A lane closes on a fifteen-minute clock but a soft-close
   * extension turns on a one-minute window, so the sweep has to be well inside
   * that to look instant to a dealer watching the countdown.
   */
  readonly intervalMs?: number;
  readonly onError?: (error: unknown) => void;
}

/**
 * Drives every clock-based transition: lanes opening, lanes closing, sales being
 * created, inspection windows expiring.
 *
 * Bids are pushed by dealers; everything else in this business happens because
 * time passed, and this is the only thing that notices.
 */
export class Scheduler {
  readonly #auctions: AuctionService;
  readonly #sales: SaleService;
  readonly #intervalMs: number;
  readonly #onError: (error: unknown) => void;
  #timer: NodeJS.Timeout | null = null;
  #running = false;

  constructor(auctions: AuctionService, sales: SaleService, options: SchedulerOptions = {}) {
    this.#auctions = auctions;
    this.#sales = sales;
    this.#intervalMs = options.intervalMs ?? 1_000;
    this.#onError = options.onError ?? (() => undefined);
  }

  start(): void {
    if (this.#timer !== null) return;
    this.#timer = setInterval(() => void this.runOnce(), this.#intervalMs);
    this.#timer.unref?.();
  }

  stop(): void {
    if (this.#timer !== null) clearTimeout(this.#timer);
    clearInterval(this.#timer ?? undefined);
    this.#timer = null;
  }

  /**
   * One sweep. Guarded against overlap: a slow sweep must not have a second one
   * start behind it and double-publish the same close.
   */
  async runOnce(): Promise<void> {
    if (this.#running) return;
    this.#running = true;
    try {
      await this.#auctions.tick();
      await this.#sales.sweepInspections();
    } catch (error) {
      this.#onError(error);
    } finally {
      this.#running = false;
    }
  }
}
