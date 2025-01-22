require('dotenv').config();
import {Configuration} from "./config/config-manager";
import { readFile } from "./utils/file";

const rawConfig = readFile("config.json") as any;
const configuration = Configuration.instance(rawConfig);
/////////////////////////////////////////////////////////////////////////////
import "./instrument";
import "./utils/extensions/string.extensions"
import express, { Express } from "express";
import helmet from "helmet";
import compression from "compression";
import cors from "cors";
import rateLimit from "express-rate-limit";
import httpStatus from "http-status";
import v1Routes from "./routes/v1";
import {ApiError, httpRequestErrorLogger, httpRequestSuccessLogger, logger} from "./utils";
import { errorConverter, errorHandler } from "./middlewares";
import * as Sentry from "@sentry/node";

const app: Express = express();

// HTTP request logger
app.use(httpRequestSuccessLogger);
app.use(httpRequestErrorLogger);

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

// Apply generic rate limit
app.use(
  rateLimit({
    windowMs: 60 * 1000, // 1 minutes
    max: 25, // Limit each IP to 5 requests per `window`
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

Sentry.setupExpressErrorHandler(app);

app.listen(configuration.port, () => {
  logger.info(`Listening to port ${configuration.port}`);
});