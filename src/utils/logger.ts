import { Response } from "express";
import winston from "winston";
import Sentry from "winston-transport-sentry-node";
import isURL from "validator/lib/isURL";
import morgan from "morgan";
import {Configuration} from "../config/config-manager";

const enumerateErrorFormat = winston.format((info) => {
  if (info instanceof Error) {
    Object.assign(info, { message: info.stack });
  }
  return info;
});

const baseTransport = [
  new winston.transports.Console({
    stderrLevels: ["error"],
  }),
];

export const logger = winston.createLogger({
  level: Configuration.instance().environment === "development" ? "debug" : "info",
  format: winston.format.combine(
    enumerateErrorFormat(),
    Configuration.instance().environment === "development"
      ? winston.format.colorize()
      : winston.format.uncolorize(),
    winston.format.splat(),
    winston.format.printf(
      ({ level, message }) => `[safe-recovery-service] ${level}: ${message}`
    )
  ),
  transports: isURL(Configuration.instance().sentryDSN ?? "")
    ? [
        ...baseTransport,
        new Sentry({
          sentry: {
            dsn: Configuration.instance().sentryDSN,
          },
          level: "error",
        }),
      ]
    : baseTransport,
});

morgan.token("message", (_req, res: Response) => res.locals.errorMessage || "");

const getIpFormat = () =>
  Configuration.instance().sentryDSN === "production" ? ":remote-addr - " : "";
const successResponseFormat = `${getIpFormat()}:method :url :status - :response-time ms`;
const errorResponseFormat = `${getIpFormat()}:method :url :status - :response-time ms - message: :message`;

export const httpRequestSuccessLogger = morgan(successResponseFormat, {
  skip: (_req, res) => res.statusCode >= 400,
  stream: { write: (message) => logger.info(message.trim()) },
});

export const httpRequestErrorLogger = morgan(errorResponseFormat, {
  skip: (_req, res) => res.statusCode < 400,
  stream: { write: (message) => logger.error(message.trim()) },
});
