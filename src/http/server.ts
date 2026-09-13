import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import websocket from '@fastify/websocket';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import type { Clock } from '../domain/clock.js';
import { cents } from '../domain/money.js';
import type { Stores } from '../store/types.js';
import { ALL_LANES, type AuctionEvent, type EventBus } from '../realtime/events.js';
import type { AuctionService } from '../app/auction-service.js';
import type { SaleService } from '../app/sale-service.js';
import { ForbiddenError } from '../app/errors.js';
import { toPublicListing, toSaleView, toSellerListing } from '../app/views.js';
import { authenticate, authenticateSocket } from './auth.js';
import { toProblem } from './problems.js';
import { MAX_PHOTO_BYTES, type PhotoStore } from '../photos/store.js';
import { DomainError } from '../domain/errors.js';

export interface ServerDeps {
  readonly stores: Stores;
  readonly bus: EventBus;
  readonly clock: Clock;
  readonly auctions: AuctionService;
  readonly sales: SaleService;
  readonly photos: PhotoStore;
  /** Directory holding the capture app. Omit to run the API on its own. */
  readonly clientRoot?: string;
  readonly logger?: boolean;
}

interface ListingParams {
  readonly id: string;
}

/**
 * Request shapes, validated by Fastify before a handler runs.
 *
 * Money crosses the wire as an integer count of cents and is rejected here if
 * it is anything else — a dealer integration that sends `11000.5` or a string
 * must get a 400 naming the field, never a 500 from deep inside a money
 * constructor.
 *
 * Vehicle detail is checked only loosely here on purpose: the domain already
 * reports every problem with a unit at once, with messages written for the
 * person holding the camera, and that is a better answer than a schema error.
 */
const moneySchema = { type: 'integer', minimum: 0 } as const;

const createListingSchema = {
  type: 'object',
  required: ['vehicle', 'startingBidCents'],
  properties: {
    vehicle: {
      type: 'object',
      required: ['photos'],
      properties: { photos: { type: 'array' } },
    },
    startingBidCents: moneySchema,
    reserveCents: { type: ['integer', 'null'], minimum: 0 },
  },
} as const;

const placeBidSchema = {
  type: 'object',
  required: ['amountCents'],
  properties: { amountCents: moneySchema },
} as const;

const disputeSchema = {
  type: 'object',
  required: ['reason'],
  properties: { reason: { type: 'string', minLength: 1 } },
} as const;

const scanSchema = {
  type: 'object',
  required: ['token'],
  properties: { token: { type: 'string', minLength: 1 } },
} as const;

export async function buildServer(deps: ServerDeps): Promise<FastifyInstance> {
  const app = Fastify({
    logger: deps.logger ?? false,
    ajv: {
      customOptions: {
        // Ajv coerces "800000" to 800000 by default. That particular conversion
        // is lossless, but money should have one wire representation and not
        // two: an integration sending money as a string has a bug, and it is
        // cheaper to find on the first request than on the one that sends
        // "8,000.00".
        coerceTypes: false,
        allErrors: true,
      },
    },
  });
  await app.register(websocket);
  await app.register(multipart, {
    limits: { fileSize: MAX_PHOTO_BYTES, files: 1 },
  });

  if (deps.clientRoot !== undefined) {
    await app.register(fastifyStatic, { root: deps.clientRoot, prefix: '/app/' });
  }

  /**
   * `POST /listings/:id/publish` and friends take no parameters. A client that
   * sets `Content-Type: application/json` and sends nothing is doing a normal
   * thing, and Fastify rejects it by default — so treat an empty body as `{}`.
   */
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_request, body, done) => {
    const text = typeof body === 'string' ? body.trim() : '';
    if (text === '') {
      done(null, {});
      return;
    }
    try {
      done(null, JSON.parse(text) as unknown);
    } catch {
      const error = Object.assign(new Error('Body is not valid JSON.'), {
        statusCode: 400,
        code: 'INVALID_JSON',
      });
      done(error, undefined);
    }
  });

  app.setErrorHandler((error, _request, reply) => {
    const problem = toProblem(error);
    if (problem.status >= 500) app.log.error(error);
    void reply.status(problem.status).send(problem.body);
  });

  const actor = (request: FastifyRequest) =>
    authenticate(deps.stores.dealers, request.headers.authorization);

  app.get('/health', async () => ({ status: 'ok' }));

  // ---------------------------------------------------------------- listings

  app.post('/listings', { schema: { body: createListingSchema } }, async (request, reply) => {
    const dealer = await actor(request);
    const body = request.body as {
      vehicle: Parameters<AuctionService['createDraft']>[0]['vehicle'];
      startingBidCents: number;
      reserveCents?: number | null;
    };

    const listing = await deps.auctions.createDraft({
      sellerDealerId: dealer.id,
      vehicle: reviveVehicle(body.vehicle),
      startingBid: cents(body.startingBidCents),
      reserve:
        body.reserveCents === undefined || body.reserveCents === null
          ? null
          : cents(body.reserveCents),
    });

    return reply.status(201).send(toSellerListing(listing));
  });

  app.post<{ Params: ListingParams }>('/listings/:id/publish', async (request) => {
    const dealer = await actor(request);
    const listing = await deps.auctions.publish(request.params.id, dealer.id);
    return toSellerListing(listing);
  });

  app.post<{ Params: ListingParams }>('/listings/:id/cancel', async (request) => {
    const dealer = await actor(request);
    const listing = await deps.auctions.cancel(request.params.id, dealer.id);
    return toSellerListing(listing);
  });

  app.get('/listings', async (request) => {
    await actor(request);
    const open = await deps.auctions.listOpen();
    return { listings: open.map(toPublicListing) };
  });

  app.get<{ Params: ListingParams }>('/listings/:id', async (request) => {
    const dealer = await actor(request);
    const listing = await deps.auctions.getListing(request.params.id);
    // The seller sees its own reserve; nobody else does.
    return listing.sellerDealerId === dealer.id
      ? toSellerListing(listing)
      : toPublicListing(listing);
  });

  app.post<{ Params: ListingParams }>(
    '/listings/:id/bids',
    { schema: { body: placeBidSchema } },
    async (request, reply) => {
      const dealer = await actor(request);
      const body = request.body as { amountCents: number };
      const { listing, bidId } = await deps.auctions.placeBid(
        request.params.id,
        dealer.id,
        cents(body.amountCents),
      );
      return reply.status(201).send({ bidId, listing: toPublicListing(listing) });
    },
  );

  // ------------------------------------------------------------------- sales

  app.get<{ Params: ListingParams }>('/listings/:id/sale', async (request, reply) => {
    const dealer = await actor(request);
    const sale = await deps.sales.findByListing(request.params.id);
    if (sale === null) {
      return reply
        .status(404)
        .send({ error: 'not_found', code: 'NOT_FOUND', message: 'This lane has no sale.' });
    }
    assertParty(sale.buyerDealerId, sale.sellerDealerId, dealer.id, sale.id);
    return toSaleView(sale);
  });

  app.get<{ Params: ListingParams }>('/sales/:id', async (request) => {
    const dealer = await actor(request);
    const sale = await deps.sales.get(request.params.id);
    assertParty(sale.buyerDealerId, sale.sellerDealerId, dealer.id, sale.id);
    return toSaleView(sale);
  });

  app.post<{ Params: ListingParams }>('/sales/:id/accept', async (request) => {
    const dealer = await actor(request);
    return toSaleView(await deps.sales.accept(request.params.id, dealer.id));
  });

  app.post<{ Params: ListingParams }>(
    '/sales/:id/dispute',
    { schema: { body: disputeSchema } },
    async (request) => {
      const dealer = await actor(request);
      const body = request.body as { reason: string };
      return toSaleView(await deps.sales.dispute(request.params.id, dealer.id, body.reason));
    },
  );

  /**
   * The carrier's scan. The gate pass in the QR is the credential — whoever is
   * holding the paperwork is the one moving the vehicle — so this route takes no
   * dealer key. That is a deliberate v1 tradeoff, revisited when carriers have
   * accounts of their own.
   */
  app.post('/transport/scan', { schema: { body: scanSchema } }, async (request) => {
    const body = request.body as { token: string };
    const { sale, outcome } = await deps.sales.scanGatePass(String(body.token ?? ''));
    return { outcome, sale: toSaleView(sale) };
  });

  // ------------------------------------------------------------------ photos

  /**
   * Upload one photo. The capture app calls this the moment a picture is taken,
   * in the background, so the uploads are finished by the time the manager has
   * typed the odometer reading — the showroom clock is the scarce resource here,
   * not bandwidth.
   */
  app.post('/photos', async (request, reply) => {
    const dealer = await actor(request);

    const file = await request.file();
    if (file === undefined) {
      throw new DomainError('INVALID_LISTING', 'Attach a photo as the "file" field.');
    }

    let data: Buffer;
    try {
      data = await file.toBuffer();
    } catch {
      throw new DomainError('INVALID_LISTING', 'The photo is larger than 12MB.');
    }
    if (file.file.truncated) {
      throw new DomainError('INVALID_LISTING', 'The photo is larger than 12MB.');
    }

    const stored = await deps.photos.put(data, dealer.id);
    return reply.status(201).send(stored);
  });

  /**
   * Serve a photo. The id is unguessable and stands in for authentication, so an
   * `<img>` tag works without cookies. The type served is sniffed from the bytes
   * and `nosniff` stops a browser second-guessing it.
   */
  app.get<{ Params: ListingParams }>('/photos/:id', async (request, reply) => {
    const photo = await deps.photos.get(request.params.id);
    if (photo === null) {
      return reply
        .status(404)
        .send({ error: 'not_found', code: 'NOT_FOUND', message: 'No such photo.' });
    }

    return reply
      .header('content-type', photo.contentType)
      .header('x-content-type-options', 'nosniff')
      .header('content-disposition', 'inline')
      .header('cache-control', 'public, max-age=31536000, immutable')
      .send(photo.data);
  });

  // ---------------------------------------------------------------- the feed

  /**
   * Live lane feed. A snapshot on connect, then every event for this lane, so a
   * client that joins thirty seconds before the close is immediately correct
   * rather than waiting for the next bid to learn the price.
   */
  app.get<{ Params: ListingParams }>(
    '/listings/:id/feed',
    { websocket: true },
    async (socket, request) => {
      const listingId = request.params.id;

      let dealerId: string;
      try {
        dealerId = (await authenticateSocket(deps.stores.dealers, request.headers)).id;
      } catch {
        socket.send(JSON.stringify({ type: 'error', code: 'UNAUTHORIZED' }));
        socket.close(4401, 'unauthorized');
        return;
      }

      try {
        const listing = await deps.auctions.getListing(listingId);
        socket.send(
          JSON.stringify({
            type: 'snapshot',
            listing:
              listing.sellerDealerId === dealerId
                ? toSellerListing(listing)
                : toPublicListing(listing),
          }),
        );
      } catch {
        socket.send(JSON.stringify({ type: 'error', code: 'NOT_FOUND' }));
        socket.close(4404, 'not found');
        return;
      }

      const send = (event: AuctionEvent) => {
        // readyState 1 is OPEN; a socket closing mid-broadcast is routine.
        if (socket.readyState === 1) socket.send(JSON.stringify(event));
      };

      const unsubscribe = deps.bus.subscribe(listingId, send);
      socket.on('close', unsubscribe);
      socket.on('error', unsubscribe);
    },
  );

  /** Every lane at once, for the buyer's lane-list screen. */
  app.get('/feed', { websocket: true }, async (socket, request) => {
    try {
      await authenticateSocket(deps.stores.dealers, request.headers);
    } catch {
      socket.send(JSON.stringify({ type: 'error', code: 'UNAUTHORIZED' }));
      socket.close(4401, 'unauthorized');
      return;
    }

    const send = (event: AuctionEvent) => {
      if (socket.readyState === 1) socket.send(JSON.stringify(event));
    };
    const unsubscribe = deps.bus.subscribe(ALL_LANES, send);
    socket.on('close', unsubscribe);
    socket.on('error', unsubscribe);
  });

  return app;
}

function assertParty(
  buyerDealerId: string,
  sellerDealerId: string,
  actorId: string,
  saleId: string,
): void {
  if (actorId !== buyerDealerId && actorId !== sellerDealerId) {
    throw new ForbiddenError(`Dealer ${actorId} is not a party to sale ${saleId}.`);
  }
}

/** JSON carries photo timestamps as strings; the domain requires real Dates. */
function reviveVehicle(
  raw: Parameters<AuctionService['createDraft']>[0]['vehicle'],
): Parameters<AuctionService['createDraft']>[0]['vehicle'] {
  return {
    ...raw,
    photos: raw.photos.map((photo) => ({ ...photo, takenAt: new Date(photo.takenAt) })),
  };
}

export type { FastifyReply, FastifyRequest };
