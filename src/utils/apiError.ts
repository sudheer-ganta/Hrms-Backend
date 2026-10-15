import { Request, Response, NextFunction, RequestHandler } from 'express';

export type ApiErrorCode =
  | 'VALIDATION_ERROR'
  | 'UNAUTHENTICATED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'BUSINESS_RULE'
  | 'UPSTREAM_FAILED'
  | 'SERVICE_UNAVAILABLE'
  | 'RATE_LIMITED'
  | 'INTERNAL';

export interface ApiErrorDetail {
  field?: string;
  issue: string;
}

const STATUS: Record<ApiErrorCode, number> = {
  VALIDATION_ERROR: 400,
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  BUSINESS_RULE: 422,
  UPSTREAM_FAILED: 502,
  SERVICE_UNAVAILABLE: 503,
  RATE_LIMITED: 429,
  INTERNAL: 500,
};

export class ApiError extends Error {
  public readonly code: ApiErrorCode;
  public readonly statusCode: number;
  public readonly details?: ApiErrorDetail[];
  constructor(code: ApiErrorCode, message: string, details?: ApiErrorDetail[]) {
    super(message);
    this.code = code;
    this.statusCode = STATUS[code];
    this.details = details;
  }
  static validation(message: string, details?: ApiErrorDetail[]) { return new ApiError('VALIDATION_ERROR', message, details); }
  static unauthenticated(message = 'Authentication required.') { return new ApiError('UNAUTHENTICATED', message); }
  static forbidden(message = 'You do not have permission to perform this action.') { return new ApiError('FORBIDDEN', message); }
  static notFound(message = 'Resource not found.') { return new ApiError('NOT_FOUND', message); }
  static conflict(message: string) { return new ApiError('CONFLICT', message); }
  static rule(message: string) { return new ApiError('BUSINESS_RULE', message); }
  static upstream(message: string) { return new ApiError('UPSTREAM_FAILED', message); }
  static unavailable(message = 'Database unavailable. Please try again shortly.') { return new ApiError('SERVICE_UNAVAILABLE', message); }
  static tooMany(message = 'Too many attempts. Please try again later.') { return new ApiError('RATE_LIMITED', message); }
}

/** Canonical error body. Never leaks Mongo/Mongoose internals. */
export const errorBody = (code: ApiErrorCode, message: string, details?: ApiErrorDetail[]) => ({
  success: false as const,
  error: { code, message, ...(details && details.length ? { details } : {}) },
});

/** Converts anything thrown into an ApiError (unknown errors become a generic INTERNAL). */
export const toApiError = (err: any): ApiError => {
  if (err instanceof ApiError) return err;
  if (err?.name === 'ValidationError' || err?.name === 'CastError') {
    return ApiError.validation('Invalid request data.');
  }
  if (err?.code === 11000) return ApiError.conflict('A record with the same unique key already exists.');
  if (err?.name === 'MongoServerSelectionError' || err?.name === 'MongoNetworkError') return ApiError.unavailable();
  if (err?.type === 'entity.parse.failed') return ApiError.validation('Malformed JSON body.');
  if (err?.type === 'entity.too.large') return ApiError.validation('Request body too large.');
  return new ApiError('INTERNAL', 'Internal server error.');
};

export const sendError = (res: Response, err: unknown): void => {
  const apiErr = toApiError(err);
  if (apiErr.code === 'INTERNAL') console.error('[API] Unhandled error:', err);
  res.status(apiErr.statusCode).json(errorBody(apiErr.code, apiErr.message, apiErr.details));
};

/** Wraps an async handler so thrown ApiErrors/unknown errors become the canonical error response. */
export const handle = (fn: (req: any, res: Response, next: NextFunction) => Promise<unknown> | unknown): RequestHandler =>
  (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(fn(req, res, next)).catch((e) => sendError(res, e));
  };
