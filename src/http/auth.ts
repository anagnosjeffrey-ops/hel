import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Dealer } from '../domain/dealer.js';
import type { DealerStore } from '../store/types.js';
import { UnauthorizedError } from '../app/errors.js';

/**
 * Minimal dealer authentication: a long random API key per rooftop, stored only
 * as a SHA-256 digest.
 *
 * This is deliberately small and deliberately not the finished article — there
 * are no sessions, no rotation, no scopes, and no dealer-licence verification
 * workflow behind it. It exists so that "who is bidding" is an answered question
 * rather than a header a caller can claim.
 */
export function generateApiKey(): string {
  return `ab_${randomBytes(32).toString('base64url')}`;
}

export function hashApiKey(key: string): string {
  return createHash('sha256').update(key, 'utf8').digest('hex');
}

export function extractBearer(header: string | undefined): string | null {
  if (header === undefined) return null;
  const match = /^Bearer (.+)$/.exec(header.trim());
  return match?.[1]?.trim() ?? null;
}

/** Constant-time digest comparison, so a near-miss key leaks no timing signal. */
export function digestsMatch(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/**
 * The key as presented by a browser websocket.
 *
 * `new WebSocket(...)` cannot set request headers — the one thing it can shape
 * is the subprotocol list, so the key rides there as `autobank.key.<key>`. That
 * keeps it in a header rather than in the query string, which would otherwise
 * put a long-lived bearer credential into every access log and proxy trace
 * between here and the dealership.
 *
 * A short-lived connect ticket would be better still and is the intended next
 * step; this is the version that works from a phone today.
 */
const SUBPROTOCOL_PREFIX = 'autobank.key.';

export function extractSocketKey(protocolHeader: string | undefined): string | null {
  if (protocolHeader === undefined) return null;
  for (const entry of protocolHeader.split(',')) {
    const token = entry.trim();
    if (token.startsWith(SUBPROTOCOL_PREFIX)) {
      const key = token.slice(SUBPROTOCOL_PREFIX.length);
      return key === '' ? null : key;
    }
  }
  return null;
}

export async function authenticateSocket(
  dealers: DealerStore,
  headers: { authorization?: string | undefined; 'sec-websocket-protocol'?: string | undefined },
): Promise<Dealer> {
  const presented =
    extractBearer(headers.authorization) ?? extractSocketKey(headers['sec-websocket-protocol']);
  if (presented === null) throw new UnauthorizedError();

  const dealer = await dealers.findByApiKeyHash(hashApiKey(presented));
  if (dealer === null) throw new UnauthorizedError();
  return dealer;
}

export async function authenticate(
  dealers: DealerStore,
  authorizationHeader: string | undefined,
): Promise<Dealer> {
  const presented = extractBearer(authorizationHeader);
  if (presented === null) throw new UnauthorizedError();

  const dealer = await dealers.findByApiKeyHash(hashApiKey(presented));
  if (dealer === null) throw new UnauthorizedError();
  return dealer;
}
