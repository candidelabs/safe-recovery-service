// Shared Candide logging module, vendored as-is: keep changes small and additive.
export type { Logger } from "pino";
export { createLogger, type CreateLoggerOptions } from "./logger";
export { installProcessLogging } from "./process";
export { serializeError } from "./errors";
export { serializeRequest, serializeResponse } from "./http";
export {
  isSensitiveKey,
  maskSecret,
  REDACTED,
  registerSecret,
  registerSecretsFromEnv,
  sanitizePath,
  sanitizeString,
  sanitizeValue,
} from "./sanitize";
export { createLogThrottle } from "./throttle";
