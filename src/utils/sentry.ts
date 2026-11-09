import * as Sentry from "@sentry/bun";
import type { DestinationStream } from "pino";
import { isSensitiveKey, REDACTED, sanitizeString } from "../logging";

// line fields that are not worth repeating as Sentry extras
const LINE_FIELDS = new Set(["time", "level", "service", "env", "msg", "err", "pid", "hostname"]);

// Forwards error-level log lines to Sentry once it is initialized. The logger feeds it the
// serialized line, i.e. exactly the sanitized JSON written to stdout, so nothing beyond what is
// logged can reach Sentry. Process crashes are reported by Sentry's own integrations, not here.
export const sentryLogStream: DestinationStream = {
  write(line: string): void {
    if (!Sentry.getClient()) return;
    let fields: Record<string, unknown>;
    try {
      fields = JSON.parse(line);
    } catch {
      return;
    }
    if (fields.level !== "error" && fields.level !== 50) return;
    const msg = typeof fields.msg === "string" ? fields.msg : "error";
    const extra = Object.fromEntries(Object.entries(fields).filter(([key]) => !LINE_FIELDS.has(key)));
    const tags = typeof fields.component === "string" ? { component: fields.component } : undefined;
    const err = fields.err as { type?: unknown; message?: unknown; stack?: unknown } | undefined;
    if (err && typeof err === "object" && typeof err.message === "string") {
      const error = new Error(err.message);
      error.name = typeof err.type === "string" ? err.type : "Error";
      if (typeof err.stack === "string") error.stack = err.stack;
      Sentry.captureException(error, { level: "error", tags, extra: { ...extra, msg } });
    } else {
      Sentry.captureMessage(msg, { level: "error", tags, extra });
    }
  },
};

// identifiers Sentry needs intact (hex ids would otherwise be masked) and SDK-internal state
const UNTOUCHED_KEYS = new Set([
  "event_id",
  "trace_id",
  "span_id",
  "parent_span_id",
  "sdk",
  "sdkProcessingMetadata",
  "timestamp",
  "start_timestamp",
  "release",
  "environment",
  "platform",
  "type",
  "level",
]);
const MAX_DEPTH = 12;

// the marker the registered options.authentication.apiKey secret is replaced with
const API_KEY_REDACTED = "[REDACTED:options.authentication.apiKey]";

// Matches the API key with any of its characters percent-encoded (e.g. "~" as %7E or %7e). Express decodes
// the path before checking the key, so a client may send it encoded, and Sentry's request URLs keep it as
// sent; the registered secret only matches it literally. The key is ASCII (parseAuthentication).
export function percentEncodedPattern(apiKey: string): RegExp {
  const characters = [...apiKey].map((char) => {
    const hex = char.charCodeAt(0).toString(16).padStart(2, "0");
    const encoded = `%${[...hex].map((digit) => (/[a-f]/.test(digit) ? `[${digit}${digit.toUpperCase()}]` : digit)).join("")}`;
    return `(?:${char.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}|${encoded})`;
  });
  return new RegExp(characters.join(""), "g");
}

// `beforeSend` / `beforeSendTransaction`: applies the log redaction rules to every string of an
// outgoing Sentry event (exception messages, stack frames, breadcrumbs, span data, request url)
// and blanks values under secret-looking keys. Request bodies, query strings and cookies are
// dropped outright, as they are from the logs. `apiKeyPattern` (percentEncodedPattern) also redacts
// the API key in its percent-encoded forms.
export function sanitizeSentryEvent<T>(event: T, apiKeyPattern?: RegExp): T {
  const request = (event as { request?: Record<string, unknown> }).request;
  if (request && typeof request === "object") {
    delete request.data;
    delete request.query_string;
    delete request.cookies;
  }
  sanitizeInPlace(event, 0, apiKeyPattern);
  return event;
}

function sanitizeInPlace(value: unknown, depth: number, apiKeyPattern?: RegExp): void {
  if (value === null || typeof value !== "object" || depth > MAX_DEPTH) return;
  const container = value as Record<string, unknown>;
  const isArray = Array.isArray(value);
  for (const key of Object.keys(container)) {
    if (UNTOUCHED_KEYS.has(key)) continue;
    const item = container[key];
    if (!isArray && isSensitiveKey(key)) {
      if (item !== undefined) container[key] = REDACTED;
    } else if (typeof item === "string") {
      const clean = sanitizeString(apiKeyPattern ? item.replace(apiKeyPattern, API_KEY_REDACTED) : item);
      if (clean !== item) container[key] = clean;
    } else {
      sanitizeInPlace(item, depth + 1, apiKeyPattern);
    }
  }
}
