export class NavApiError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
  }
}

export class AuthError extends NavApiError {}

export class HttpError extends NavApiError {
  readonly status: number;
  readonly code?: string;
  readonly body?: unknown;

  constructor(status: number, message: string, code?: string, body?: unknown) {
    super(message);
    this.status = status;
    this.code = code;
    this.body = body;
  }
}

export class NotFoundError extends HttpError {
  constructor(message: string, code?: string, body?: unknown) {
    super(404, message, code, body);
  }
}

export class PreconditionFailedError extends HttpError {
  constructor(message: string, code?: string, body?: unknown) {
    super(412, message, code, body);
  }
}

/** Builds the most specific error for a BC/OData failure response. */
export function toHttpError(status: number, body: unknown): HttpError {
  let code: string | undefined;
  let message = `HTTP ${status}`;
  if (body && typeof body === 'object' && 'error' in body) {
    const err = (body as { error?: { code?: string; message?: string } }).error;
    if (err?.code) code = err.code;
    if (err?.message) message = `${err.message} (HTTP ${status})`;
  } else if (typeof body === 'string' && body.trim()) {
    message = `HTTP ${status}: ${body.trim().slice(0, 500)}`;
  }
  if (status === 404) return new NotFoundError(message, code, body);
  if (status === 412) {
    return new PreconditionFailedError(
      code ? message : `The record was modified by someone else (ETag mismatch, HTTP 412).`,
      code,
      body,
    );
  }
  return new HttpError(status, message, code, body);
}
