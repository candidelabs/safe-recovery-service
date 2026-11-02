import { sanitizeString, sanitizeValue } from "./sanitize";

const MAX_CAUSE_DEPTH = 3;
const MAX_STACK_LENGTH = 4000;
const MAX_AGGREGATED_ERRORS = 5;
// primitive own properties worth keeping; everything else (axios config, driver key values,
// RPC request bodies) can carry secrets or user data and is dropped
const ERROR_PROPS = [
  "code",
  "errno",
  "syscall",
  "status",
  "statusCode",
  "codeName",
  "reason",
  "field",
];

export interface SerializedError {
  type: string;
  message: string;
  stack?: string;
  [prop: string]: unknown;
}

function errorType(err: Error): string {
  if (err.name && err.name !== "Error") return err.name;
  return err.constructor?.name || "Error";
}

function hostOf(url: unknown): string | undefined {
  if (typeof url !== "string") return undefined;
  try {
    return new URL(url).host;
  } catch {
    return undefined;
  }
}

export function serializeError(err: unknown, depth = 0): unknown {
  if (!(err instanceof Error)) {
    if (err !== null && typeof err === "object") return sanitizeValue(err, undefined, depth);
    return { type: typeof err, message: sanitizeString(String(err)) };
  }
  const e = err as Error & Record<string, any>;
  const out: SerializedError = {
    type: errorType(e),
    message: sanitizeString(String(e.message ?? "")),
  };
  for (const prop of ERROR_PROPS) {
    const value = e[prop];
    if (typeof value === "string") out[prop] = sanitizeString(value);
    else if (typeof value === "number" || typeof value === "boolean") out[prop] = value;
  }
  if (e.isAxiosError) {
    const config = e.config ?? {};
    out.request = {
      method: typeof config.method === "string" ? config.method.toUpperCase() : undefined,
      host: hostOf(config.url) ?? hostOf(config.baseURL),
    };
    if (e.response?.status !== undefined) out.status = e.response.status;
  }
  if (typeof e.stack === "string") {
    const stack = sanitizeString(e.stack);
    out.stack = stack.length > MAX_STACK_LENGTH ? stack.slice(0, MAX_STACK_LENGTH) : stack;
  }
  if (depth < MAX_CAUSE_DEPTH) {
    const cause = e.cause ?? (e.error instanceof Error ? e.error : undefined);
    if (cause !== undefined) out.cause = serializeError(cause, depth + 1);
    if (Array.isArray(e.errors)) {
      out.errors = e.errors
        .slice(0, MAX_AGGREGATED_ERRORS)
        .map((inner: unknown) => serializeError(inner, depth + 1));
    }
  }
  return out;
}
