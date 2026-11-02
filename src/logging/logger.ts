import pino, { type DestinationStream, type Level, type Logger, type LoggerOptions } from "pino";
import { serializeError } from "./errors";
import { serializeRequest, serializeResponse } from "./http";
import { REDACTED, registerSecretsFromEnv, sanitizeFields, sanitizeString } from "./sanitize";

export interface CreateLoggerOptions {
  service: string;
  env?: string;
  level?: string;
  pretty?: boolean;
  enabled?: boolean;
  // file descriptor for JSON output; 2 for child processes whose stdout is not collected
  destination?: 1 | 2;
  // in-process consumers that also receive every line at or above `level` (e.g. an error
  // forwarder); they get the same sanitized JSON that goes to the destination. Ignored when pretty.
  streams?: Array<{ level: Level; stream: DestinationStream }>;
}

const SERIALIZED_KEYS: ReadonlySet<string> = new Set(["err", "req", "res"]);
const REDACT_KEYS = [
  "apiKey",
  "api_key",
  "apikey",
  "authorization",
  "cookie",
  "password",
  "secret",
  "token",
  "accessToken",
  "refreshToken",
  "idToken",
  "sessionToken",
  "privateKey",
  "private_key",
  "mnemonic",
  "masterKey",
  "clientSecret",
  "connectionString",
  "rpcUrl",
];
const REDACT_HEADER_KEYS = [
  "x-api-key",
  "x-parse-master-key",
  "x-parse-session-token",
  "set-cookie",
];
const REDACT_PATHS = [
  ...REDACT_KEYS.flatMap((key) => [key, `*.${key}`]),
  ...REDACT_HEADER_KEYS.map((key) => `*["${key}"]`),
];

function withStreams(
  destination: DestinationStream,
  streams: CreateLoggerOptions["streams"]
): DestinationStream {
  if (!streams?.length) return destination;
  return pino.multistream([{ level: "trace", stream: destination }, ...streams]);
}

function isInstalled(moduleName: string): boolean {
  try {
    require.resolve(moduleName);
    return true;
  } catch {
    return false;
  }
}

export function createLogger(options: CreateLoggerOptions): Logger {
  registerSecretsFromEnv();
  const wantsPretty = options.pretty ?? process.env.LOG_PRETTY === "true";
  const pretty = wantsPretty && isInstalled("pino-pretty");
  const config: LoggerOptions = {
    level: options.level ?? process.env.LOG_LEVEL ?? "info",
    enabled: options.enabled ?? true,
    base: {
      service: options.service,
      env: options.env ?? process.env.ENVIRONMENT ?? process.env.NODE_ENV ?? "unknown",
    },
    messageKey: "msg",
    errorKey: "err",
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: {
      // pino-pretty renders numeric levels itself
      ...(pretty ? {} : { level: (label: string) => ({ level: label }) }),
      bindings: (bindings) => sanitizeFields(bindings, SERIALIZED_KEYS),
      log: (fields) => sanitizeFields(fields, SERIALIZED_KEYS),
    },
    serializers: {
      err: (err) => serializeError(err),
      req: serializeRequest,
      res: serializeResponse,
      msg: (msg) => (typeof msg === "string" ? sanitizeString(msg) : msg),
    },
    redact: { paths: REDACT_PATHS, censor: REDACTED },
  };
  const logger = pretty
    ? pino({
        ...config,
        transport: {
          target: "pino-pretty",
          options: {
            colorize: true,
            translateTime: "SYS:HH:MM:ss.l",
            ignore: "service,env",
            destination: options.destination ?? 1,
          },
        },
      })
    : pino(
        config,
        withStreams(pino.destination({ dest: options.destination ?? 1, sync: true }), options.streams)
      );
  if (wantsPretty && !pretty) {
    logger.warn("LOG_PRETTY is set but pino-pretty is not installed, writing JSON");
  }
  return logger;
}
