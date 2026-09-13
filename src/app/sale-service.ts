import type { Clock } from '../domain/clock.js';
import { NotFoundError, type Stores } from '../store/types.js';
import type { EventBus } from '../realtime/events.js';
import { DomainError } from '../domain/errors.js';
import {
  type Sale,
  acceptDelivery,
  advanceSale,
  assignCarrier,
  confirmDelivery,
  confirmPickup,
  openDispute,
  settle,
  unwind,
  upholdSale,
} from '../domain/fulfillment.js';
import { ForbiddenError } from './errors.js';

export interface SaleServiceDeps {
  readonly stores: Stores;
  readonly bus: EventBus;
  readonly clock: Clock;
}

export type ScanOutcome = 'picked_up' | 'delivered';

export class SaleService {
  readonly #deps: SaleServiceDeps;

  constructor(deps: SaleServiceDeps) {
    this.#deps = deps;
  }

  async get(saleId: string): Promise<Sale> {
    const sale = await this.#deps.stores.sales.get(saleId);
    if (sale === null) throw new NotFoundError('Sale', saleId);
    return sale;
  }

  async findByListing(listingId: string): Promise<Sale | null> {
    return this.#deps.stores.sales.findByListing(listingId);
  }

  async assignCarrier(saleId: string, carrierId: string): Promise<Sale> {
    return this.#apply(saleId, (sale) => assignCarrier(sale, carrierId, this.#deps.clock.now()));
  }

  /**
   * One endpoint for both ends of the tow, because the driver scans the same QR
   * off the same gate pass at both. Which transition it is depends on where the
   * vehicle already is, so a double-scan at pickup cannot mark it delivered.
   */
  async scanGatePass(token: string): Promise<{ sale: Sale; outcome: ScanOutcome }> {
    const found = await this.#deps.stores.sales.findByGatePass(token);
    // Deliberately indistinguishable from a valid token on the wrong vehicle:
    // this is a bearer credential and must not confirm which tokens exist.
    if (found === null) throw new DomainError('INVALID_TOKEN', 'Gate pass is not recognized.');

    const now = this.#deps.clock.now();
    const outcome: ScanOutcome = found.status === 'picked_up' ? 'delivered' : 'picked_up';
    const sale = await this.#apply(found.id, (current) =>
      outcome === 'delivered'
        ? confirmDelivery(current, token, now)
        : confirmPickup(current, token, now),
    );
    return { sale, outcome };
  }

  async accept(saleId: string, actorDealerId: string): Promise<Sale> {
    return this.#apply(saleId, (sale) => {
      this.#assertBuyer(sale, actorDealerId);
      return acceptDelivery(sale, this.#deps.clock.now());
    });
  }

  async dispute(saleId: string, actorDealerId: string, reason: string): Promise<Sale> {
    return this.#apply(saleId, (sale) => {
      this.#assertBuyer(sale, actorDealerId);
      return openDispute(sale, reason, this.#deps.clock.now());
    });
  }

  /** Arbitration outcome, decided by the platform rather than either dealer. */
  async resolveDispute(saleId: string, decision: 'buyer' | 'seller'): Promise<Sale> {
    return this.#apply(saleId, (sale) =>
      decision === 'buyer' ? unwind(sale) : upholdSale(sale, this.#deps.clock.now()),
    );
  }

  async settle(saleId: string): Promise<Sale> {
    return this.#apply(saleId, (sale) => settle(sale, this.#deps.clock.now()));
  }

  /**
   * Accept anything whose inspection window has run out. Runs on the same tick
   * as the auction scheduler.
   */
  async sweepInspections(): Promise<string[]> {
    const now = this.#deps.clock.now();
    const accepted: string[] = [];

    for (const due of await this.#deps.stores.sales.findDue(now)) {
      const next = await this.#deps.stores.sales.mutate(due.id, (sale) => {
        const advanced = advanceSale(sale, now);
        return { next: advanced, result: advanced };
      });
      if (next.status === 'accepted') {
        accepted.push(next.id);
        await this.#publishProgress(next, now);
      }
    }

    return accepted;
  }

  async #apply(saleId: string, fn: (sale: Sale) => Sale): Promise<Sale> {
    const next = await this.#deps.stores.sales.mutate(saleId, (sale) => {
      const updated = fn(sale);
      return { next: updated, result: updated };
    });
    await this.#publishProgress(next, this.#deps.clock.now());
    return next;
  }

  async #publishProgress(sale: Sale, now: Date): Promise<void> {
    await this.#deps.bus.publish({
      type: 'sale.progressed',
      listingId: sale.listingId,
      saleId: sale.id,
      status: sale.status,
      at: now.toISOString(),
    });
  }

  #assertBuyer(sale: Sale, actorDealerId: string): void {
    if (sale.buyerDealerId !== actorDealerId) {
      throw new ForbiddenError(`Dealer ${actorDealerId} did not buy sale ${sale.id}.`);
    }
  }
}
