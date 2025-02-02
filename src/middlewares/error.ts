import { NextFunction, Request, Response } from "express";
import { status as httpStatus } from "http-status";
import { ApiError } from "../utils";
import {Configuration} from "../config/config-manager";
import {logger} from "../utils/logger";

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
  }
  next(error);
};

export const errorHandler = (err: any, _req: Request, res: Response) => {
  let { statusCode, message } = err;
  if (Configuration.instance().environment === "production" && !err.isOperational) {
    statusCode = httpStatus.INTERNAL_SERVER_ERROR;
    message = httpStatus[httpStatus.INTERNAL_SERVER_ERROR];
  }

  res.locals.errorMessage = err.message;

  const response = {
    code: statusCode,
    message,
    ...(Configuration.instance().environment === "development" && { stack: err.stack }),
  };

  if (Configuration.instance().environment === "development") {
    logger.error(err);
  }

  res.status(statusCode).send(response);
};
