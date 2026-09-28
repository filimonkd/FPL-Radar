// HTTP-facing application errors with stable codes. Services throw these (or
// domain errors that middleware/errors.js maps); routes never build error bodies.
export class AppError extends Error {
  constructor(status, code, message, details = undefined) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const unauthorized = (message = 'authentication required') => new AppError(401, 'UNAUTHENTICATED', message);
export const forbidden = (message = 'not allowed') => new AppError(403, 'FORBIDDEN', message);
export const notFound = (what = 'resource') => new AppError(404, 'NOT_FOUND', `${what} not found`);
