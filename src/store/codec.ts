import type { Listing, Bid } from '../domain/listing.js';
import type { Sale } from '../domain/fulfillment.js';
import { cents } from '../domain/money.js';

/**
 * Explicit codecs rather than a JSON.parse reviver.
 *
 * Money and timestamps are the two things that must survive a round trip
 * exactly, and a reviver that guesses which strings are dates will eventually
 * guess wrong on a VIN or a dealer name.
 */

type Json = Record<string, unknown>;

function isoOrNull(value: Date | null): string | null {
  return value === null ? null : value.toISOString();
}

function dateOrNull(value: unknown): Date | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') {
    throw new TypeError(`Expected an ISO timestamp, received ${typeof value}`);
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new TypeError(`Expected an ISO timestamp, received "${value}"`);
  }
  return parsed;
}

function requireDate(value: unknown): Date {
  const parsed = dateOrNull(value);
  if (parsed === null) throw new TypeError('Expected a timestamp, received null');
  return parsed;
}

function requireMoney(value: unknown): ReturnType<typeof cents> {
  if (typeof value !== 'number') {
    throw new TypeError(`Expected money as a number, received ${typeof value}`);
  }
  return cents(value);
}

function moneyOrNull(value: unknown): ReturnType<typeof cents> | null {
  return value === null || value === undefined ? null : requireMoney(value);
}

export function encodeListing(listing: Listing): Json {
  return {
    ...listing,
    createdAt: listing.createdAt.toISOString(),
    opensAt: isoOrNull(listing.opensAt),
    closesAt: isoOrNull(listing.closesAt),
    vehicle: {
      ...listing.vehicle,
      photos: listing.vehicle.photos.map((photo) => ({
        ...photo,
        takenAt: photo.takenAt.toISOString(),
      })),
    },
    bids: listing.bids.map((bid) => ({ ...bid, placedAt: bid.placedAt.toISOString() })),
  };
}

export function decodeListing(raw: Json): Listing {
  const vehicleRaw = raw['vehicle'] as Json;
  const bidsRaw = (raw['bids'] ?? []) as Json[];
  const photosRaw = (vehicleRaw['photos'] ?? []) as Json[];

  const bids: Bid[] = bidsRaw.map((bid) => ({
    id: String(bid['id']),
    dealerId: String(bid['dealerId']),
    amount: requireMoney(bid['amount']),
    placedAt: requireDate(bid['placedAt']),
  }));

  return {
    ...(raw as unknown as Listing),
    startingBid: requireMoney(raw['startingBid']),
    reserve: moneyOrNull(raw['reserve']),
    createdAt: requireDate(raw['createdAt']),
    opensAt: dateOrNull(raw['opensAt']),
    closesAt: dateOrNull(raw['closesAt']),
    vehicle: {
      ...(vehicleRaw as unknown as Listing['vehicle']),
      photos: photosRaw.map((photo) => ({
        ...(photo as unknown as Listing['vehicle']['photos'][number]),
        takenAt: requireDate(photo['takenAt']),
      })),
    },
    bids,
  };
}

export function encodeSale(sale: Sale): Json {
  return {
    ...sale,
    awardedAt: sale.awardedAt.toISOString(),
    inspectionDeadline: isoOrNull(sale.inspectionDeadline),
    acceptedAt: isoOrNull(sale.acceptedAt),
    paidAt: isoOrNull(sale.paidAt),
    transport: {
      ...sale.transport,
      assignedAt: isoOrNull(sale.transport.assignedAt),
      pickedUpAt: isoOrNull(sale.transport.pickedUpAt),
      deliveredAt: isoOrNull(sale.transport.deliveredAt),
    },
  };
}

export function decodeSale(raw: Json): Sale {
  const transportRaw = raw['transport'] as Json;
  const feesRaw = raw['fees'] as Json;

  return {
    ...(raw as unknown as Sale),
    price: requireMoney(raw['price']),
    fees: {
      salePrice: requireMoney(feesRaw['salePrice']),
      buyerFee: requireMoney(feesRaw['buyerFee']),
      sellerFee: requireMoney(feesRaw['sellerFee']),
      buyerTotal: requireMoney(feesRaw['buyerTotal']),
      sellerProceeds: requireMoney(feesRaw['sellerProceeds']),
      platformRevenue: requireMoney(feesRaw['platformRevenue']),
    },
    awardedAt: requireDate(raw['awardedAt']),
    inspectionDeadline: dateOrNull(raw['inspectionDeadline']),
    acceptedAt: dateOrNull(raw['acceptedAt']),
    paidAt: dateOrNull(raw['paidAt']),
    transport: {
      ...(transportRaw as unknown as Sale['transport']),
      assignedAt: dateOrNull(transportRaw['assignedAt']),
      pickedUpAt: dateOrNull(transportRaw['pickedUpAt']),
      deliveredAt: dateOrNull(transportRaw['deliveredAt']),
    },
  };
}
