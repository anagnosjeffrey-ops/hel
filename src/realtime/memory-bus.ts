import {
  ALL_LANES,
  type AuctionEvent,
  type EventBus,
  type EventHandler,
  type Unsubscribe,
} from './events.js';

/**
 * Single-process fan-out. Correct for one server; a second instance would not
 * see the first instance's bids, which is what `PostgresEventBus` exists for.
 */
export class MemoryEventBus implements EventBus {
  readonly #topics = new Map<string, Set<EventHandler>>();

  async publish(event: AuctionEvent): Promise<void> {
    this.#deliver(event.listingId, event);
    this.#deliver(ALL_LANES, event);
  }

  subscribe(topic: string, handler: EventHandler): Unsubscribe {
    const handlers = this.#topics.get(topic) ?? new Set<EventHandler>();
    handlers.add(handler);
    this.#topics.set(topic, handlers);

    return () => {
      handlers.delete(handler);
      if (handlers.size === 0) this.#topics.delete(topic);
    };
  }

  async close(): Promise<void> {
    this.#topics.clear();
  }

  #deliver(topic: string, event: AuctionEvent): void {
    for (const handler of this.#topics.get(topic) ?? []) {
      // One broken subscriber — a socket that closed mid-write — must not stop
      // the rest of the lane from getting the bid.
      try {
        handler(event);
      } catch {
        /* ignore */
      }
    }
  }
}
