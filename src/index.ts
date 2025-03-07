import {startSendNotificationsCronJob} from "./services/alerts.service";

require('dotenv').config();
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
import Logger from "./utils/logger";
import {errorConverter, errorHandler} from "./middlewares";
import {AccountEventTracker} from "./models/events/account-event-tracker";

const app: Express = express();
const configuration = Configuration.instance();

// HTTP request logger
app.use(Logger.httpRequestSuccessLogger());
// @ts-ignore
app.use(Logger.httpRequestErrorLogger());

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
    limit: 25, // Limit each IP to 25 requests per `window`
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

app.listen(configuration.port, () => {
  Logger.info(`Listening to port ${configuration.port}`);
  //
  delay(2500).then(async () => {
    await AccountEventTracker.instance().loadSubscriptions();
    startSendNotificationsCronJob();
  })
});