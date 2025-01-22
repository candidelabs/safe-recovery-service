import * as Sentry from "@sentry/node";
import { nodeProfilingIntegration } from '@sentry/profiling-node';
import isURL from "validator/lib/isURL";
import {Configuration} from "./config/config-manager";

if (isURL(Configuration.instance().sentryDSN ?? "")) {
  Sentry.init({
    dsn: Configuration.instance().sentryDSN,
    integrations: [
      nodeProfilingIntegration(),
    ],
    tracesSampleRate: 1.0,
    profilesSampleRate: 1.0,
  });
}