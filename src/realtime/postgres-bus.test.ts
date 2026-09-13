import { afterAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { createPool } from '../store/postgres/pool.js';
import { PostgresEventBus } from './postgres-bus.js';
import { MemoryEventBus } from './memory-bus.js';
import { ALL_LANES, type AuctionEvent } from './events.js';
import { usd } from '../testing/fixtures.js';

const DATABASE_URL =
  process.env['TEST_DATABASE_URL'] ?? 'postgres://autobank:autobank@127.0.0.1:5432/autobank_test';

const pools: Pool[] = [];
const buses: PostgresEventBus[] = [];

afterAll(async () => {
  await Promise.all(buses.map((bus) => bus.close()));
  await Promise.all(pools.map((pool) => pool.end()));
});

/** Each bus stands in for a separate server instance. */
async function startInstance(): Promise<PostgresEventBus> {
  const pool = createPool(DATABASE_URL);
  pools.push(pool);
  const bus = await PostgresEventBus.start(pool, DATABASE_URL);
  buses.push(bus);
  return bus;
}

function bidEvent(listingId: string): AuctionEvent {
  return {
    type: 'bid.placed',
    listingId,
    bidId: 'bid_1',
    dealerId: 'dealer-b',
    amount: usd(11_000),
    minimumNextBid: usd(11_100),
    reserveState: 'met',
    closesAt: new Date().toISOString(),
    extended: false,
    at: new Date().toISOString(),
  };
}

function once(bus: PostgresEventBus, topic: string, timeoutMs = 3_000): Promise<AuctionEvent> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      unsubscribe();
      reject(new Error(`No event on "${topic}" within ${timeoutMs}ms`));
    }, timeoutMs);

    const unsubscribe = bus.subscribe(topic, (event) => {
      clearTimeout(timer);
      unsubscribe();
      resolve(event);
    });
  });
}

describe('PostgresEventBus', () => {
  /**
   * The reason this class exists: a dealer's socket is attached to whichever
   * instance answered the upgrade, and the bid that matters to them may land on
   * any other one.
   */
  it('delivers a bid placed on one instance to a socket on another', async () => {
    const publisher = await startInstance();
    const subscriber = await startInstance();
    const listingId = `lst_${Date.now()}`;

    const received = once(subscriber, listingId);
    await publisher.publish(bidEvent(listingId));

    expect(await received).toMatchObject({
      type: 'bid.placed',
      listingId,
      amount: usd(11_000),
    });
  });

  it('delivers to the publishing instance too', async () => {
    const bus = await startInstance();
    const listingId = `lst_self_${Date.now()}`;

    const received = once(bus, listingId);
    await bus.publish(bidEvent(listingId));

    expect(await received).toMatchObject({ listingId });
  });

  it('feeds the all-lanes topic', async () => {
    const publisher = await startInstance();
    const subscriber = await startInstance();

    const received = once(subscriber, ALL_LANES);
    await publisher.publish(bidEvent(`lst_all_${Date.now()}`));

    expect(await received).toMatchObject({ type: 'bid.placed' });
  });

  it("does not deliver one lane's bids to another lane's subscribers", async () => {
    const publisher = await startInstance();
    const subscriber = await startInstance();

    const wrongLane = once(subscriber, 'lst_not_this_one', 400);
    await publisher.publish(bidEvent(`lst_other_${Date.now()}`));

    await expect(wrongLane).rejects.toThrow(/No event/);
  });

  it('refuses a payload too large for a NOTIFY, rather than dropping it silently', async () => {
    const bus = await startInstance();
    const huge = { ...bidEvent('lst_huge'), bidId: 'x'.repeat(8_000) } as AuctionEvent;
    await expect(bus.publish(huge)).rejects.toThrow(/too large/);
  });
});

describe('MemoryEventBus', () => {
  it('keeps delivering after a subscriber throws', async () => {
    const bus = new MemoryEventBus();
    const seen: string[] = [];

    bus.subscribe('lst_1', () => {
      throw new Error('this socket is gone');
    });
    bus.subscribe('lst_1', (event) => seen.push(event.type));

    await bus.publish(bidEvent('lst_1'));
    expect(seen).toEqual(['bid.placed']);
  });

  it('stops delivering once unsubscribed', async () => {
    const bus = new MemoryEventBus();
    const seen: string[] = [];
    const unsubscribe = bus.subscribe('lst_1', (event) => seen.push(event.type));

    await bus.publish(bidEvent('lst_1'));
    unsubscribe();
    await bus.publish(bidEvent('lst_1'));

    expect(seen).toHaveLength(1);
  });
});
