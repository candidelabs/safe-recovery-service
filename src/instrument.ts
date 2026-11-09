import * as Sentry from "@sentry/bun";
import { PrismaInstrumentation } from "@prisma/instrumentation";
import isURL from "validator/lib/isURL";
import {Configuration} from "./config/config-manager";
import { readFile } from "./utils/file";
import logger from "./utils/logger";
import { percentEncodedPattern, sanitizeSentryEvent } from "./utils/sentry";

// First thing to run: loads config.json and builds the Configuration singleton. A config that
// cannot be loaded ends the process with one fatal JSON line instead of a raw stack trace.
let configuration: Configuration;
try {
  const rawConfig = readFile("config.json") as any;
  configuration = Configuration.instance(rawConfig);
} catch (error) {
  const missingEnv = (error as { missingEnv?: string[] } | null)?.missingEnv;
  logger.fatal({ err: error, missingEnv }, "configuration failed to load");
  logger.flush();
  process.exit(1);
}

if (isURL(configuration.sentryDSN ?? "")) {
  // the API key is a path segment, so the request URLs Sentry captures carry it, maybe percent-encoded
  const {apiKey} = configuration.authentication;
  const apiKeyPattern = apiKey === undefined ? undefined : percentEncodedPattern(apiKey);
  Sentry.init({
    dsn: configuration.sentryDSN,
    integrations: [
      Sentry.prismaIntegration({
        prismaInstrumentation: new PrismaInstrumentation(),
      }),
    ],
    tracesSampleRate: 1.0,
    // everything sent to Sentry passes through the same redaction as the logs
    beforeSend: (event) => sanitizeSentryEvent(event, apiKeyPattern),
    beforeSendTransaction: (event) => sanitizeSentryEvent(event, apiKeyPattern),
  });
}
