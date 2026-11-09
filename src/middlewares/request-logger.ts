import { randomUUID } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { serializeRequest, serializeResponse } from "../logging";
import logger from "../utils/logger";
import { redactApiKey } from "./authentication";

const log = logger.child({ component: "http" });

// Full pattern of the matched route, e.g. /v1/alerts/subscribe (/:apiKey/v1/alerts/subscribe with an API
// key). Express restores req.baseUrl to "" before the app-level error handlers run, so once the response
// is finished the mount prefix is recovered by matching req.route.path against the end of the request path.
export function routePattern(req: Request): string | undefined {
  const routePath: unknown = req.route?.path;
  if (typeof routePath !== "string") return undefined;
  const requestPath = redactApiKey(req.originalUrl ?? req.url ?? "").split("?")[0];
  const tail = routePath
    .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    .replace(/:[A-Za-z0-9_]+/g, "[^/]+");
  const match = new RegExp(`${tail}/?$`, "i").exec(requestPath);
  return match ? `${requestPath.slice(0, match.index)}${routePath}` : `${redactApiKey(req.baseUrl ?? "")}${routePath}`;
}

// One line per request once the response is finished. Replaces morgan: the route pattern is logged
// instead of the URL, so query strings never appear, and 5xx lines carry the error the handler saw.
export const requestLogger = (req: Request, res: Response, next: NextFunction): void => {
  const startedAt = process.hrtime.bigint();
  const requestId = randomUUID();
  res.locals.requestId = requestId;
  res.setHeader("X-Request-Id", requestId);
  res.on("finish", () => {
    const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
    const route = routePattern(req);
    // The shared serializers decide what of a request may be logged (method, route, path, ip);
    // headers, query strings and bodies never get in.
    const request = serializeRequest({
      method: req.method,
      originalUrl: redactApiKey(req.originalUrl),
      ip: req.ip,
      baseUrl: "",
      route: route === undefined ? undefined : { path: route },
    }) as { method?: string; route?: string; path?: string; ip?: string };
    const { statusCode } = serializeResponse(res) as { statusCode: number };
    const fields = {
      requestId,
      httpMethod: request.method,
      route: request.route,
      // only when no route matched (404s): the sanitized path, never the query string
      path: request.route === undefined ? request.path : undefined,
      statusCode,
      durationMs: Math.round(durationMs * 10) / 10,
      ip: request.ip,
      errorMessage: res.locals.errorMessage,
    };
    if (statusCode >= 500) {
      // err carries the message, so errorMessage is not repeated
      log.error({ ...fields, errorMessage: undefined, err: res.locals.error }, "request failed");
    } else if (statusCode >= 400) {
      log.info(fields, "request rejected");
    } else {
      log.info(fields, "request completed");
    }
  });
  next();
};
