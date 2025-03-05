import * as Sentry from "@sentry/bun";
import { PrismaInstrumentation } from "@prisma/instrumentation";
import isURL from "validator/lib/isURL";
import {Configuration} from "./config/config-manager";
import { readFile } from "./utils/file";

const rawConfig = readFile("config.json") as any;
const configuration = Configuration.instance(rawConfig);

if (isURL(configuration.sentryDSN ?? "")) {
  Sentry.init({
    dsn: Configuration.instance().sentryDSN,
    integrations: [
      Sentry.prismaIntegration({
        prismaInstrumentation: new PrismaInstrumentation(),
      }),
    ],
    tracesSampleRate: 1.0,
  });
}