import { formatWithOptions } from "node:util";
import type { Logger } from "pino";
import { registerSecretsFromEnv } from "./sanitize";

const CONSOLE_LEVELS = [
  ["log", "info"],
  ["info", "info"],
  ["warn", "warn"],
  ["error", "error"],
  ["debug", "debug"],
  ["trace", "debug"],
] as const;

let installed = false;

// Routes console output from dependencies, process warnings and crashes through the logger so
// they get the same JSON shape and redaction. Call once from the service entrypoint.
export function installProcessLogging(logger: Logger): void {
  if (installed) return;
  installed = true;
  registerSecretsFromEnv();
  bridgeConsole(logger.child({ origin: "console" }));
  process.removeAllListeners("warning");
  process.on("warning", (warning) => logger.warn({ err: warning }, "node process warning"));
  // registered before parse-server's own handler, which would write the raw stack to stderr
  process.on("uncaughtException", (err, origin) => {
    logger.fatal({ err, origin }, "uncaught exception");
    exitAfterFlush(logger);
  });
  // Node routes these through "uncaughtException" when nothing listens; Bun prints the raw error
  // to stderr and exits instead, so they are handled explicitly with the same outcome.
  process.on("unhandledRejection", (reason) => {
    logger.fatal({ err: reason, origin: "unhandledRejection" }, "unhandled rejection");
    exitAfterFlush(logger);
  });
}

function exitAfterFlush(logger: Logger): void {
  const exit = () => process.exit(1);
  setTimeout(exit, 1000);
  logger.flush(exit);
}

function bridgeConsole(log: Logger): void {
  let writing = false;
  for (const [method, level] of CONSOLE_LEVELS) {
    console[method] = (...args: unknown[]) => {
      if (writing) return;
      writing = true;
      try {
        const err = args.find((arg) => arg instanceof Error);
        const rest = err === undefined ? args : args.filter((arg) => arg !== err);
        const detail = rest.length
          ? formatWithOptions({ colors: false, depth: 4, breakLength: Infinity }, ...rest)
          : undefined;
        log[level]({ detail, err }, "console output");
      } finally {
        writing = false;
      }
    };
  }
}
