require('dotenv').config();
import logger from "./utils/logger";
import {installProcessLogging} from "./logging";
import {Configuration} from "./config/config-manager";
import "./utils/extensions/string.extensions"
import "./instrument";
/////////////////////////////////////////////////////////////////////////////
import express, {type Express} from "express";
import helmet from "helmet";
import compression from "compression";
import cors from "cors";
import rateLimit from "express-rate-limit";
import httpStatus from "http-status";
import v1Routes from "./routes/v1";
import {ApiError, delay} from "./utils";
import {errorConverter, errorHandler, requestLogger} from "./middlewares";
import {AccountEventTracker} from "./models/events/account-event-tracker";
import {startSendNotificationsCronJob} from "./services/alerts.service";
import {releaseOrphanedSponsorships} from "./services/recoveries.service";
import {assignLegacyRequestRows, verifyRecoveryModuleCode} from "./services/recovery-modules.service";
import {Network} from "./models/network";

// Console output of dependencies, Node warnings and crashes go through the same JSON logger.
installProcessLogging(logger);

export const app: Express = express();
const configuration = Configuration.instance();

// HTTP request logger (one line per request)
app.use(requestLogger);

// set security HTTP headers
app.use(helmet());

// parse json request body
app.use(express.json());

// parse urlencoded request body
app.use(express.urlencoded({ extended: true }));

// gzip compression
app.use(compression());

// enable cors
app.use(cors());

if (configuration.trustProxy){
  app.set('trust proxy', 1);
}

// Apply generic rate limit
app.use(
  rateLimit({
    validate: {xForwardedForHeader: false},
    windowMs: 60 * 1000, // 1 minutes
    limit: configuration.rateLimit, // Limit each IP to rateLimit per `window`
    standardHeaders: true, // Return rate limit info in the `RateLimit-*` headers
    legacyHeaders: false, // Disable the `X-RateLimit-*` headers
  })
);

// v1 api routes
app.use("/v1", v1Routes);

// send back a 404 error for any unknown api request
app.use((_req, _res, next) => {
  next(new ApiError(httpStatus.NOT_FOUND, "Not found"));
});

// convert error to ApiError, if needed
app.use(errorConverter);

// handle error
app.use(errorHandler);

const listen = () => app.listen(configuration.port, () => {
  logger.info({ port: configuration.port }, "server listening");
  releaseOrphanedSponsorships()
    .then((count) => {
      if (count > 0) logger.warn({ count }, "released orphaned sponsorship claims left by a previous run");
    })
    .catch((error) => logger.error({ err: error }, "orphaned sponsorship release failed"));
  void verifyRecoveryModuleCode();
  delay(2500).then(async () => {
    await AccountEventTracker.instance().loadSubscriptions();
    startSendNotificationsCronJob();
  })
});

// Requests made before they named their module get it before the server takes any request, whether or not
// the indexer runs.
Promise.all(Network.instances.instances.map(assignLegacyRequestRows))
  .then(listen, (error) => {
    // Serving them on a guessed module would sign and execute against the wrong contract.
    logger.fatal({ err: error }, "legacy requests cannot be assigned to a recovery module");
    logger.flush();
    process.exit(1);
  });