import { NextFunction, Request, Response } from "express";
import { status as httpStatus } from "http-status";
import { ApiError } from "../utils";
import {Configuration} from "../config/config-manager";

export const errorConverter = (
  err: any,
  _req: Request,
  _res: Response,
  next: NextFunction
) => {
  let error = err;
  if (!(error instanceof ApiError)) {
    const statusCode = error.statusCode ?? httpStatus.INTERNAL_SERVER_ERROR;
    // @ts-ignore
    const message = error.message || httpStatus[statusCode];
    error = new ApiError(statusCode, message, false, err.stack);
    // keeps the original error (type, code, ...) as err.cause in the request log line
    error.cause = err;
  }
  next(error);
};

export const errorHandler = (
  err: any,
  _req: Request,
  res: Response,
  _next: NextFunction
) => {
  let { statusCode, message } = err;
  if (Configuration.instance().environment === "production" && !err.isOperational) {
    statusCode = httpStatus.INTERNAL_SERVER_ERROR;
    message = httpStatus[httpStatus.INTERNAL_SERVER_ERROR];
  }

  // Picked up by the request logger, which writes one line per request (with the error for 5xx).
  res.locals.errorMessage = err.message;
  res.locals.error = err;

  const response = {
    code: statusCode,
    message,
    ...(Configuration.instance().environment === "development" && { stack: err.stack }),
  };

  res.status(statusCode).json(response);
};
