import { randomUUID, randomBytes } from 'node:crypto';

/** Prefixed ids so a value pasted into a support ticket identifies itself. */
export function newId(prefix: string): string {
  return `${prefix}_${randomUUID()}`;
}

/**
 * The token behind the transport QR code. Opaque, unguessable, and never
 * derived from the listing id — scanning a code must not let anyone enumerate
 * other vehicles awaiting pickup.
 */
export function newScanToken(): string {
  return randomBytes(24).toString('base64url');
}
