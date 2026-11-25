import { NextFunction, Request, Response } from "express";

interface IApiError extends Error {
  statusCode: number;
  isOperational: boolean;
}

export class ApiError extends Error implements IApiError {
  statusCode: number;
  isOperational: boolean;
  // Machine-readable fields answered next to code and message (e.g. details.reason), for an operational error.
  details?: Record<string, unknown>;

  constructor(
    statusCode: number,
    message: string,
    isOperational = true,
    stack = "",
    details?: Record<string, unknown>
  ) {
    super(message);
    this.statusCode = statusCode;
    this.isOperational = isOperational;
    if (details !== undefined) {
      this.details = details;
    }
    if (stack) {
      this.stack = stack;
    } else {
      Error.captureStackTrace(this, this.constructor);
    }
  }
}

export const catchAsync =
  (
    fn: (
      req: Request,
      res: Response,
      next: NextFunction
    ) => Promise<void> | void
  ) =>
  (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(fn(req, res, next)).catch((err) => next(err));
  };
