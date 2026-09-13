import { DomainError, type DomainErrorCode } from '../domain/errors.js';
import { NotFoundError } from '../store/types.js';
import { ForbiddenError, UnauthorizedError } from '../app/errors.js';

/**
 * Domain rejections map to status codes once, here. A dealer on a fifteen-minute
 * clock needs to know instantly whether to re-bid higher (409) or stop (403).
 */
const DOMAIN_STATUS: Readonly<Record<DomainErrorCode, number>> = {
  INVALID_LISTING: 422,
  INVALID_TRANSITION: 409,
  AUCTION_NOT_LIVE: 409,
  SELF_BIDDING: 409,
  BID_TOO_LOW: 409,
  DEALER_NOT_ELIGIBLE: 403,
  RESERVE_NOT_MET: 409,
  WINDOW_EXPIRED: 409,
  // A wrong gate pass reads as "no such thing", so scanning cannot be used to
  // discover which tokens are live.
  INVALID_TOKEN: 404,
};

export interface Problem {
  readonly status: number;
  readonly body: { readonly error: string; readonly code: string; readonly message: string };
}

export function toProblem(error: unknown): Problem {
  if (error instanceof DomainError) {
    return {
      status: DOMAIN_STATUS[error.code],
      body: { error: 'domain_rule', code: error.code, message: error.message },
    };
  }
  if (error instanceof NotFoundError) {
    return { status: 404, body: { error: 'not_found', code: 'NOT_FOUND', message: error.message } };
  }
  if (error instanceof ForbiddenError) {
    return { status: 403, body: { error: 'forbidden', code: error.code, message: error.message } };
  }
  if (error instanceof UnauthorizedError) {
    return {
      status: 401,
      body: { error: 'unauthorized', code: error.code, message: error.message },
    };
  }
  // Framework errors (a malformed body, an unsupported content type) already
  // carry the right status. Burying them as a 500 tells a dealer the platform
  // broke when in fact their request needs fixing.
  const framework = asClientError(error);
  if (framework !== null) return framework;

  return {
    status: 500,
    body: {
      error: 'internal',
      code: 'INTERNAL',
      // Never surface an unexpected error's text: it may carry a token or a query.
      message: 'Something went wrong on our side.',
    },
  };
}

function asClientError(error: unknown): Problem | null {
  if (typeof error !== 'object' || error === null) return null;

  const candidate = error as { statusCode?: unknown; code?: unknown; message?: unknown };
  const status = candidate.statusCode;
  if (typeof status !== 'number' || status < 400 || status > 499) return null;

  return {
    status,
    body: {
      error: 'bad_request',
      code: typeof candidate.code === 'string' ? candidate.code : 'BAD_REQUEST',
      message: typeof candidate.message === 'string' ? candidate.message : 'Request was rejected.',
    },
  };
}
