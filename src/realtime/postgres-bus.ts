import { Client, type Pool } from 'pg';
import { MemoryEventBus } from './memory-bus.js';
import type { AuctionEvent, EventBus, EventHandler, Unsubscribe } from './events.js';

const CHANNEL = 'autobank_events';

/** Postgres refuses a NOTIFY payload over 8000 bytes. */
const MAX_PAYLOAD_BYTES = 7_500;

/**
 * Fan-out across server instances using LISTEN/NOTIFY.
 *
 * A dealer's websocket is attached to whichever instance answered the upgrade,
 * but the bid that matters to them may land on any other. Publishing through the
 * database means every instance sees every bid, and the ordering is the
 * database's ordering — the same one the bids were validated in.
 *
 * The listening connection is dedicated and outside the pool: it is idle for
 * long stretches and must never be handed to a query.
 */
export class PostgresEventBus implements EventBus {
  readonly #pool: Pool;
  readonly #connectionString: string;
  readonly #local = new MemoryEventBus();
  #listener: Client | null = null;
  #closed = false;
  #reconnectDelayMs = 250;
  #reconnectTimer: NodeJS.Timeout | null = null;

  private constructor(pool: Pool, connectionString: string) {
    this.#pool = pool;
    this.#connectionString = connectionString;
  }

  static async start(pool: Pool, connectionString: string): Promise<PostgresEventBus> {
    const bus = new PostgresEventBus(pool, connectionString);
    await bus.#listen();
    return bus;
  }

  async publish(event: AuctionEvent): Promise<void> {
    const payload = JSON.stringify(event);
    if (Buffer.byteLength(payload, 'utf8') > MAX_PAYLOAD_BYTES) {
      throw new Error(`Event payload is too large to notify: ${event.type}`);
    }
    // Every instance, this one included, receives the event back through its
    // own LISTEN connection — so local delivery happens there and ordering is
    // identical everywhere.
    await this.#pool.query('SELECT pg_notify($1, $2)', [CHANNEL, payload]);
  }

  subscribe(topic: string, handler: EventHandler): Unsubscribe {
    return this.#local.subscribe(topic, handler);
  }

  async close(): Promise<void> {
    this.#closed = true;
    if (this.#reconnectTimer !== null) clearTimeout(this.#reconnectTimer);
    const listener = this.#listener;
    this.#listener = null;
    await listener?.end().catch(() => undefined);
    await this.#local.close();
  }

  async #listen(): Promise<void> {
    const client = new Client({ connectionString: this.#connectionString });

    client.on('notification', (message) => {
      if (message.channel !== CHANNEL || message.payload === undefined) return;
      try {
        void this.#local.publish(JSON.parse(message.payload) as AuctionEvent);
      } catch {
        // A malformed payload is not worth tearing the listener down for.
      }
    });

    // A dropped listener is silent — sockets stay open and simply stop
    // updating — so reconnect rather than waiting to be noticed.
    client.on('error', () => this.#scheduleReconnect());
    client.on('end', () => this.#scheduleReconnect());

    await client.connect();
    await client.query(`LISTEN ${CHANNEL}`);
    this.#listener = client;
    this.#reconnectDelayMs = 250;
  }

  #scheduleReconnect(): void {
    if (this.#closed || this.#reconnectTimer !== null) return;

    const delay = this.#reconnectDelayMs;
    this.#reconnectDelayMs = Math.min(delay * 2, 10_000);
    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectTimer = null;
      if (this.#closed) return;
      void this.#listen().catch(() => this.#scheduleReconnect());
    }, delay);
    this.#reconnectTimer.unref?.();
  }
}
