import { Response } from "express";
import winston from "winston";
import isURL from "validator/lib/isURL";
import morgan from "morgan";
import {Configuration} from "../config/config-manager";
import {WinstonSentryTransport} from "./winston-sentry-transport";

class Logger {
  private static logger: winston.Logger | undefined;
  private static readonly baseTransport = [
    new winston.transports.Console({
      stderrLevels: ["error"],
    }),
  ];

  private static readonly enumerateErrorFormat = winston.format((info) => {
    if (info instanceof Error) {
      Object.assign(info, { message: info.stack });
    }
    return info;
  });

  private static initializeLogger(): void {
    if (!this.logger) {
      this.logger = winston.createLogger({
        level: Configuration.instance().environment === "development" ? "debug" : "info",
        format: winston.format.combine(
          this.enumerateErrorFormat(),
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
            ...this.baseTransport,
            new WinstonSentryTransport({
              sentry: {
                dsn: Configuration.instance().sentryDSN,
              },
              level: "error",
            }),
          ]
          : this.baseTransport,
      });
    }
  }

  // Logging methods
  public static info(message: string): void {
    this.initializeLogger();
    this.logger!.info(message);
  }

  public static debug(message: string): void {
    this.initializeLogger();
    this.logger!.debug(message);
  }

  public static warn(message: string): void {
    this.initializeLogger();
    this.logger!.warn(message);
  }

  public static error(message: string): void {
    this.initializeLogger();
    this.logger!.error(message);
  }

  // HTTP request loggers
  public static httpRequestSuccessLogger(){
    return morgan(
      `${this.getIpFormat()}:method :url :status - :response-time ms`,
      {
        skip: (_req, res) => res.statusCode >= 400,
        stream: {
          write: (message) => {
            this.initializeLogger();
            this.logger!.info(message.trim());
          }
        },
      }
    );
  };

  public static httpRequestErrorLogger(){
    return morgan(
      `${this.getIpFormat()}:method :url :status - :response-time ms - message: :message`,
      {
        skip: (_req, res) => res.statusCode < 400,
        stream: {
          write: (message) => {
            this.initializeLogger();
            this.logger!.error(message.trim());
          }
        },
      }
    );
  };

  private static getIpFormat(): string {
    return Configuration.instance().sentryDSN === "production" ? ":remote-addr - " : "";
  }
}

morgan.token("message", (_req, res: Response) => res.locals.errorMessage || "");
export default Logger;