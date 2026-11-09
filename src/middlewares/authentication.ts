import { createHash, timingSafeEqual } from "node:crypto";
import type { RequestHandler } from "express";
import { status as httpStatus } from "http-status";
import { ApiError } from "../utils/error";
import { Configuration } from "../config/config-manager";

// options.authentication (parseAuthentication in config-manager.ts): an API key, the first path segment of
// every request, or a bearer token in the Authorization header.

// The path the routes are mounted under when an API key is configured (src/index.ts).
export const API_KEY_PATH = "/:apiKey";

const digest = (value: string): Buffer => createHash("sha256").update(value).digest();
// Constant time whatever the lengths: both digests have 32 bytes.
const matches = (given: string, expected: Buffer): boolean => timingSafeEqual(digest(given), expected);

// Mounted on API_KEY_PATH: any first path segment other than the key is answered 401, a missing key included
// (/v1/... reads "v1" as the key).
export const requireApiKey = (apiKey: string): RequestHandler => {
  const expected = digest(apiKey);
  return (req, _res, next) => {
    if (matches(req.params.apiKey ?? "", expected)) return next();
    next(new ApiError(httpStatus.UNAUTHORIZED, "Invalid API key"));
  };
};

// "Authorization: Bearer <token>" (the scheme in any case); 401 with a WWW-Authenticate challenge (RFC 6750) otherwise.
export const requireBearerToken = (bearerToken: string): RequestHandler => {
  const expected = digest(bearerToken);
  return (req, res, next) => {
    const given = /^Bearer +(\S+) *$/i.exec(req.headers.authorization ?? "")?.[1];
    if (given !== undefined && matches(given, expected)) return next();
    res.setHeader("WWW-Authenticate", given === undefined ? "Bearer" : 'Bearer error="invalid_token"');
    next(new ApiError(httpStatus.UNAUTHORIZED, given === undefined ? "Bearer token required" : "Invalid bearer token"));
  };
};

// The request URL as the logs show it. With an API key configured, the first path segment is the key's slot and
// is logged as :apiKey, whatever the request put there: the key, or a wrong one (a typo of it, an old one).
export const redactApiKey = (url: string): string =>
  Configuration.instance().authentication.apiKey === undefined ? url : url.replace(/^\/[^/?#]+/, API_KEY_PATH);
