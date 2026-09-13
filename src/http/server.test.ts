import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import WebSocket from 'ws';
import { buildServer } from './server.js';
import { createHarness, type Harness } from '../testing/harness.js';
import { T0, usd, vehicle } from '../testing/fixtures.js';

const MINUTE = 60_000;

describe('HTTP API', () => {
  let h: Harness;
  let app: FastifyInstance;

  beforeEach(async () => {
    h = await createHarness(T0);
    await h.register('gilroy');
    await h.register('dealer-b');
    await h.register('dealer-c');
    app = await buildServer({
      stores: h.stores,
      bus: h.bus,
      clock: h.clock,
      auctions: h.auctions,
      sales: h.sales,
    });
  });

  afterEach(async () => {
    await app.close();
  });

  const auth = (dealerId: string) => ({ authorization: `Bearer ${h.keys.get(dealerId)!}` });

  async function createListing(reserveCents: number | null = usd(9_000)) {
    const response = await app.inject({
      method: 'POST',
      url: '/listings',
      headers: auth('gilroy'),
      payload: {
        vehicle: vehicle(),
        startingBidCents: usd(8_000),
        reserveCents,
      },
    });
    expect(response.statusCode).toBe(201);
    return response.json() as { id: string; reserve: number | null };
  }

  async function openLane(reserveCents: number | null = usd(9_000)) {
    const listing = await createListing(reserveCents);
    await app.inject({
      method: 'POST',
      url: `/listings/${listing.id}/publish`,
      headers: auth('gilroy'),
    });
    h.clock.advance(15 * MINUTE);
    await h.auctions.tick();
    return listing;
  }

  describe('authentication', () => {
    it('rejects a request with no key', async () => {
      const response = await app.inject({ method: 'GET', url: '/listings' });
      expect(response.statusCode).toBe(401);
      expect(response.json()).toMatchObject({ code: 'UNAUTHORIZED' });
    });

    it('rejects an unknown key', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/listings',
        headers: { authorization: 'Bearer ab_not-a-real-key' },
      });
      expect(response.statusCode).toBe(401);
    });

    it('leaves /health open', async () => {
      expect((await app.inject({ method: 'GET', url: '/health' })).statusCode).toBe(200);
    });
  });

  describe('listings', () => {
    it('creates a draft and shows the seller its own reserve', async () => {
      const listing = await createListing();
      expect(listing.reserve).toBe(usd(9_000));
    });

    it('revives photo timestamps sent as JSON strings', async () => {
      const listing = await createListing();
      const stored = await h.auctions.getListing(listing.id);
      expect(stored.vehicle.photos[0]!.takenAt).toBeInstanceOf(Date);
    });

    it('rejects a vehicle missing required photos with a 422', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/listings',
        headers: auth('gilroy'),
        payload: { vehicle: vehicle({ photos: [] }), startingBidCents: usd(8_000) },
      });
      expect(response.statusCode).toBe(422);
      expect(response.json()).toMatchObject({ code: 'INVALID_LISTING' });
    });

    it('hides the reserve from every dealer but the seller', async () => {
      const listing = await createListing();
      const response = await app.inject({
        method: 'GET',
        url: `/listings/${listing.id}`,
        headers: auth('dealer-b'),
      });

      const body = response.json() as Record<string, unknown>;
      expect(response.statusCode).toBe(200);
      expect(body['reserve']).toBeUndefined();
      expect(body['reserveState']).toBe('not_met');
      expect(response.payload).not.toContain('900000');
    });

    it('will not let another dealer publish the lane', async () => {
      const listing = await createListing();
      const response = await app.inject({
        method: 'POST',
        url: `/listings/${listing.id}/publish`,
        headers: auth('dealer-b'),
      });
      expect(response.statusCode).toBe(403);
    });

    it('404s an unknown listing', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/listings/lst_nope',
        headers: auth('dealer-b'),
      });
      expect(response.statusCode).toBe(404);
    });
  });

  describe('request bodies', () => {
    /**
     * Regression: an action endpoint takes no parameters, and a client that
     * still announces a JSON content type used to get a 400 from the framework,
     * which the error handler then reported as a 500.
     */
    it('accepts an empty JSON body on an endpoint that takes no parameters', async () => {
      const listing = await createListing();
      const response = await app.inject({
        method: 'POST',
        url: `/listings/${listing.id}/publish`,
        headers: { ...auth('gilroy'), 'content-type': 'application/json' },
        payload: '',
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ status: 'scheduled' });
    });

    it('reports malformed JSON as the client error it is, not a server fault', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/listings',
        headers: { ...auth('gilroy'), 'content-type': 'application/json' },
        payload: '{ not json',
      });

      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ code: 'INVALID_JSON' });
    });

    it('does not bury a framework rejection as a 500', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/listings',
        headers: { ...auth('gilroy'), 'content-type': 'text/plain' },
        payload: 'nope',
      });

      expect(response.statusCode).toBeGreaterThanOrEqual(400);
      expect(response.statusCode).toBeLessThan(500);
    });
  });

  describe('request validation', () => {
    it.each([
      ['a missing amount', {}],
      ['fractional cents', { amountCents: 800_000.5 }],
      ['a negative amount', { amountCents: -100 }],
      ['money as a string', { amountCents: '800000' }],
    ])('rejects %s with a 400 rather than a 500', async (_label, payload) => {
      const listing = await openLane();
      const response = await app.inject({
        method: 'POST',
        url: `/listings/${listing.id}/bids`,
        headers: auth('dealer-b'),
        payload,
      });
      expect(response.statusCode).toBe(400);
    });

    it('rejects a listing with no vehicle', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/listings',
        headers: auth('gilroy'),
        payload: { startingBidCents: usd(8_000) },
      });
      expect(response.statusCode).toBe(400);
    });

    it('rejects a dispute with no reason', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/sales/sale_x/dispute',
        headers: auth('dealer-b'),
        payload: {},
      });
      expect(response.statusCode).toBe(400);
    });

    it('rejects a scan with no token', async () => {
      const response = await app.inject({ method: 'POST', url: '/transport/scan', payload: {} });
      expect(response.statusCode).toBe(400);
    });
  });

  describe('bidding', () => {
    it('accepts a bid at the starting price', async () => {
      const listing = await openLane();
      const response = await app.inject({
        method: 'POST',
        url: `/listings/${listing.id}/bids`,
        headers: auth('dealer-b'),
        payload: { amountCents: usd(8_000) },
      });

      expect(response.statusCode).toBe(201);
      const body = response.json() as { listing: { currentPrice: number; minimumNextBid: number } };
      expect(body.listing.currentPrice).toBe(usd(8_000));
      expect(body.listing.minimumNextBid).toBe(usd(8_100));
    });

    it('rejects a bid under the increment with a 409 the client can act on', async () => {
      const listing = await openLane();
      await app.inject({
        method: 'POST',
        url: `/listings/${listing.id}/bids`,
        headers: auth('dealer-b'),
        payload: { amountCents: usd(8_000) },
      });

      const response = await app.inject({
        method: 'POST',
        url: `/listings/${listing.id}/bids`,
        headers: auth('dealer-c'),
        payload: { amountCents: usd(8_050) },
      });
      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({ code: 'BID_TOO_LOW' });
    });

    it('rejects a bid before the lane opens', async () => {
      const listing = await createListing();
      await app.inject({
        method: 'POST',
        url: `/listings/${listing.id}/publish`,
        headers: auth('gilroy'),
      });

      const response = await app.inject({
        method: 'POST',
        url: `/listings/${listing.id}/bids`,
        headers: auth('dealer-b'),
        payload: { amountCents: usd(8_000) },
      });
      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({ code: 'AUCTION_NOT_LIVE' });
    });

    it('stops a seller bidding on its own vehicle', async () => {
      const listing = await openLane();
      const response = await app.inject({
        method: 'POST',
        url: `/listings/${listing.id}/bids`,
        headers: auth('gilroy'),
        payload: { amountCents: usd(9_000) },
      });
      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({ code: 'SELF_BIDDING' });
    });

    it('turns away a dealer whose subscription lapsed', async () => {
      await h.register('dealer-d', { subscription: { planId: 'starter', status: 'past_due' } });
      const listing = await openLane();

      const response = await app.inject({
        method: 'POST',
        url: `/listings/${listing.id}/bids`,
        headers: { authorization: `Bearer ${h.keys.get('dealer-d')!}` },
        payload: { amountCents: usd(8_000) },
      });
      expect(response.statusCode).toBe(403);
      expect(response.json()).toMatchObject({ code: 'DEALER_NOT_ELIGIBLE' });
    });
  });

  describe('sale and transport', () => {
    async function soldLane() {
      const listing = await openLane();
      await app.inject({
        method: 'POST',
        url: `/listings/${listing.id}/bids`,
        headers: auth('dealer-b'),
        payload: { amountCents: usd(11_000) },
      });
      h.clock.advance(15 * MINUTE);
      await h.auctions.tick();
      return { listing, sale: (await h.sales.findByListing(listing.id))! };
    }

    it('never exposes the gate pass token over the API', async () => {
      const { listing, sale } = await soldLane();
      const response = await app.inject({
        method: 'GET',
        url: `/listings/${listing.id}/sale`,
        headers: auth('dealer-b'),
      });

      expect(response.statusCode).toBe(200);
      expect(response.payload).not.toContain(sale.transport.gatePassToken);
    });

    it("keeps a third dealer out of someone else's sale", async () => {
      const { listing } = await soldLane();
      const response = await app.inject({
        method: 'GET',
        url: `/listings/${listing.id}/sale`,
        headers: auth('dealer-c'),
      });
      expect(response.statusCode).toBe(403);
    });

    it('moves the vehicle on two scans of the same gate pass', async () => {
      const { sale } = await soldLane();
      await h.sales.assignCarrier(sale.id, 'carrier-1');

      const pickup = await app.inject({
        method: 'POST',
        url: '/transport/scan',
        payload: { token: sale.transport.gatePassToken },
      });
      expect(pickup.json()).toMatchObject({ outcome: 'picked_up' });

      h.clock.advance(120 * MINUTE);
      const delivery = await app.inject({
        method: 'POST',
        url: '/transport/scan',
        payload: { token: sale.transport.gatePassToken },
      });
      expect(delivery.json()).toMatchObject({ outcome: 'delivered' });
      expect((await h.sales.get(sale.id)).inspectionDeadline).not.toBeNull();
    });

    it('answers an unknown gate pass with a plain 404', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/transport/scan',
        payload: { token: 'made-up-token' },
      });
      expect(response.statusCode).toBe(404);
      expect(response.json()).toMatchObject({ code: 'INVALID_TOKEN' });
    });

    it('lets the buying dealer finalize, and nobody else', async () => {
      const { sale } = await soldLane();
      await h.sales.assignCarrier(sale.id, 'carrier-1');
      await h.sales.scanGatePass(sale.transport.gatePassToken);
      h.clock.advance(120 * MINUTE);
      await h.sales.scanGatePass(sale.transport.gatePassToken);

      const bySeller = await app.inject({
        method: 'POST',
        url: `/sales/${sale.id}/accept`,
        headers: auth('gilroy'),
      });
      expect(bySeller.statusCode).toBe(403);

      const byBuyer = await app.inject({
        method: 'POST',
        url: `/sales/${sale.id}/accept`,
        headers: auth('dealer-b'),
      });
      expect(byBuyer.statusCode).toBe(200);
      expect(byBuyer.json()).toMatchObject({ status: 'accepted' });
    });
  });
});

describe('the live lane feed', () => {
  let h: Harness;
  let app: FastifyInstance;
  let baseUrl: string;

  beforeEach(async () => {
    h = await createHarness(T0);
    await h.register('gilroy');
    await h.register('dealer-b');
    app = await buildServer({
      stores: h.stores,
      bus: h.bus,
      clock: h.clock,
      auctions: h.auctions,
      sales: h.sales,
    });
    await app.listen({ port: 0, host: '127.0.0.1' });
    const address = app.server.address();
    if (address === null || typeof address === 'string') throw new Error('no address');
    baseUrl = `ws://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    await app.close();
  });

  function nextMessage(socket: WebSocket): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      socket.once('message', (data) => resolve(JSON.parse(String(data))));
      socket.once('error', reject);
    });
  }

  async function liveLane() {
    const draft = await h.auctions.createDraft({
      sellerDealerId: 'gilroy',
      vehicle: vehicle(),
      startingBid: usd(8_000),
      reserve: usd(9_000),
    });
    await h.auctions.publish(draft.id, 'gilroy');
    h.clock.advance(15 * MINUTE);
    await h.auctions.tick();
    return draft.id;
  }

  it('sends a snapshot on connect, then streams every bid', async () => {
    const listingId = await liveLane();
    const socket = new WebSocket(`${baseUrl}/listings/${listingId}/feed`, {
      headers: { authorization: `Bearer ${h.keys.get('dealer-b')!}` },
    });

    try {
      const snapshot = await nextMessage(socket);
      expect(snapshot).toMatchObject({ type: 'snapshot' });
      expect((snapshot['listing'] as Record<string, unknown>)['status']).toBe('live');
      // A buyer's snapshot must not carry the seller's floor.
      expect((snapshot['listing'] as Record<string, unknown>)['reserve']).toBeUndefined();

      const incoming = nextMessage(socket);
      h.clock.advance(MINUTE);
      await h.auctions.placeBid(listingId, 'dealer-b', usd(8_500));

      expect(await incoming).toMatchObject({
        type: 'bid.placed',
        amount: usd(8_500),
        minimumNextBid: usd(8_600),
        reserveState: 'not_met',
      });
    } finally {
      socket.close();
    }
  });

  it('streams the close to everyone watching', async () => {
    const listingId = await liveLane();
    const socket = new WebSocket(`${baseUrl}/listings/${listingId}/feed`, {
      headers: { authorization: `Bearer ${h.keys.get('dealer-b')!}` },
    });

    try {
      await nextMessage(socket);
      h.clock.advance(MINUTE);
      await h.auctions.placeBid(listingId, 'dealer-b', usd(11_000));
      await nextMessage(socket);

      const closing = nextMessage(socket);
      h.clock.advance(15 * MINUTE);
      await h.auctions.tick();

      expect(await closing).toMatchObject({
        type: 'listing.closed',
        outcome: 'awarded',
        price: usd(11_000),
        buyerDealerId: 'dealer-b',
      });
    } finally {
      socket.close();
    }
  });

  it('closes an unauthenticated socket instead of streaming to it', async () => {
    const listingId = await liveLane();
    const socket = new WebSocket(`${baseUrl}/listings/${listingId}/feed`);

    try {
      expect(await nextMessage(socket)).toMatchObject({ type: 'error', code: 'UNAUTHORIZED' });
      const code = await new Promise<number>((resolve) => socket.once('close', resolve));
      expect(code).toBe(4401);
    } finally {
      socket.close();
    }
  });
});
