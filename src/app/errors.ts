/** The actor is known but is not allowed to do this to this record. */
export class ForbiddenError extends Error {
  readonly code = 'FORBIDDEN';

  constructor(message: string) {
    super(message);
    this.name = 'ForbiddenError';
  }
}

/** No dealer matched the presented credential. */
export class UnauthorizedError extends Error {
  readonly code = 'UNAUTHORIZED';

  constructor(message = 'A valid dealer API key is required.') {
    super(message);
    this.name = 'UnauthorizedError';
  }
}
