import { Request, Response, NextFunction } from 'express';
import { sendError, ApiError, errorBody } from '../utils/apiError.js';

/** Central error handler: every error leaves the API in the canonical shape. */
export const errorHandler = (err: any, _req: Request, res: Response, _next: NextFunction): void => {
  sendError(res, err);
};

/** Unknown /api route → canonical 404 (not Express HTML). */
export const apiNotFound = (_req: Request, res: Response): void => {
  const e = ApiError.notFound('API route not found.');
  res.status(e.statusCode).json(errorBody(e.code, e.message));
};
