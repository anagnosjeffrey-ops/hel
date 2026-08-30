/**
 * Every rejection a dealer can hit carries a stable code. The showroom floor is
 * not the place to decode a stack trace — the code maps to one plain sentence
 * in the UI, and to one row in the audit log.
 */
export type DomainErrorCode =
  | 'INVALID_LISTING'
  | 'INVALID_TRANSITION'
  | 'AUCTION_NOT_LIVE'
  | 'SELF_BIDDING'
  | 'BID_TOO_LOW'
  | 'DEALER_NOT_ELIGIBLE'
  | 'RESERVE_NOT_MET'
  | 'WINDOW_EXPIRED'
  | 'INVALID_TOKEN';

export class DomainError extends Error {
  readonly code: DomainErrorCode;

  constructor(code: DomainErrorCode, message: string) {
    super(message);
    this.name = 'DomainError';
    this.code = code;
  }
}

export function invariant(
  condition: unknown,
  code: DomainErrorCode,
  message: string,
): asserts condition {
  if (!condition) {
    throw new DomainError(code, message);
  }
}
