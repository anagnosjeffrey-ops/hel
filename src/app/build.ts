import type { Clock } from '../domain/clock.js';
import { systemClock } from '../domain/clock.js';
import type { Stores } from '../store/types.js';
import type { EventBus } from '../realtime/events.js';
import type { AuctionRules } from '../domain/listing.js';
import type { FeeSchedule } from '../domain/fees.js';
import type { FulfillmentRules } from '../domain/fulfillment.js';
import { AuctionService } from './auction-service.js';
import { SaleService } from './sale-service.js';
import { Scheduler, type SchedulerOptions } from './scheduler.js';

export interface AppOptions {
  readonly stores: Stores;
  readonly bus: EventBus;
  readonly clock?: Clock;
  readonly auctionRules?: AuctionRules;
  readonly feeSchedule?: FeeSchedule;
  readonly fulfillmentRules?: FulfillmentRules;
  readonly scheduler?: SchedulerOptions;
}

export interface App {
  readonly stores: Stores;
  readonly bus: EventBus;
  readonly clock: Clock;
  readonly auctions: AuctionService;
  readonly sales: SaleService;
  readonly scheduler: Scheduler;
}

/** One composition root, shared by the server, the worker, and the tests. */
export function buildApp(options: AppOptions): App {
  const clock = options.clock ?? systemClock;
  const auctions = new AuctionService({
    stores: options.stores,
    bus: options.bus,
    clock,
    ...(options.auctionRules ? { auctionRules: options.auctionRules } : {}),
    ...(options.feeSchedule ? { feeSchedule: options.feeSchedule } : {}),
    ...(options.fulfillmentRules ? { fulfillmentRules: options.fulfillmentRules } : {}),
  });
  const sales = new SaleService({ stores: options.stores, bus: options.bus, clock });

  return {
    stores: options.stores,
    bus: options.bus,
    clock,
    auctions,
    sales,
    scheduler: new Scheduler(auctions, sales, options.scheduler ?? {}),
  };
}
