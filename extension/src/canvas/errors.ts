/**
 * Failure modes worth telling apart.
 *
 * Ported from the CLI's transport layer. The distinction that matters most is
 * between "you are logged out" and "you cannot see this" — the first should
 * stop everything and prompt a sign-in, the second should be skipped past.
 */

export class CanvasError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CanvasError";
  }
}

/**
 * The Canvas session is gone, expired, or was never there.
 *
 * Stops the whole run. Letting each remaining request fail on its own would
 * turn one expired cookie into dozens of identical errors.
 */
export class SessionExpiredError extends CanvasError {
  constructor(
    message = "You're not signed in to Canvas, or your session expired.",
  ) {
    super(message);
    this.name = "SessionExpiredError";
  }
}

/**
 * Canvas returned 403 for a reason other than rate limiting.
 *
 * Usually an instructor disabling a course feature. Callers skip the affected
 * resource and continue — one locked feature must never end a refresh.
 */
export class AccessDeniedError extends CanvasError {
  constructor(message: string) {
    super(message);
    this.name = "AccessDeniedError";
  }
}

/** Canvas returned 404. Often benign: a feature switched off for a course. */
export class NotFoundError extends CanvasError {
  constructor(message: string) {
    super(message);
    this.name = "NotFoundError";
  }
}

/** Throttled repeatedly and gave up. */
export class RateLimitError extends CanvasError {
  constructor(message: string) {
    super(message);
    this.name = "RateLimitError";
  }
}
