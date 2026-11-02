import { createLogger } from "../logging";
import { sentryLogStream } from "./sentry";

// One JSON line per event on stdout. Error lines are also forwarded to Sentry
// when a DSN is configured; the forwarder receives the same sanitized line that goes to stdout.
const logger = createLogger({
  service: "safe-recovery-service",
  streams: [{ level: "error", stream: sentryLogStream }],
});

export default logger;
