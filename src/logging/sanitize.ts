import { serializeError } from "./errors";

export const REDACTED = "[REDACTED]";
const MASK = "***";
const MASKED_PREFIX_CHARS = 4;
const MIN_MASKABLE_LENGTH = 16;
const MIN_KNOWN_SECRET_LENGTH = 8;
const MAX_SCAN_LENGTH = 65_536;
const MAX_STRING_LENGTH = 4096;
const MAX_DEPTH = 6;
const MAX_ARRAY_ITEMS = 50;
const MAX_OBJECT_KEYS = 100;

// At most the first 4 characters survive, and only for secrets long enough that the rest stays
// unguessable.
export function maskSecret(value: string): string {
  if (value.length < MIN_MASKABLE_LENGTH) return MASK;
  return `${value.slice(0, MASKED_PREFIX_CHARS)}${MASK}`;
}

const SENSITIVE_KEY_EXACT = new Set([
  "key",
  "pk",
  "pass",
  "pwd",
  "auth",
  "seed",
  "sig",
  "xapikey",
  "otp",
  "challenge",
  // safe-recovery-service config: an AWS secret access key under an "Id"-suffixed name
  "secretaccesskeyid",
]);
const SENSITIVE_KEY_PARTS = [
  "password",
  "passwd",
  "passphrase",
  "secret",
  "apikey",
  "accesskey",
  "privatekey",
  "privkey",
  "signingkey",
  "signerkey",
  "masterkey",
  "maintenancekey",
  "javascriptkey",
  "mnemonic",
  "seedphrase",
  "authorization",
  "cookie",
  "bearer",
  "jwt",
  "credential",
  "connectionstring",
  "databaseuri",
  "databaseurl",
  "dsn",
  "rpcurl",
  "rpcendpoint",
  "webhook",
  "signature",
  "siwe",
  "invitationcode",
];
// identifiers and flags about a secret, never the secret itself
const SAFE_KEY_SUFFIXES = [
  "id",
  "ids",
  "name",
  "names",
  "hint",
  "count",
  "length",
  "configured",
  "present",
  "enabled",
  "missing",
  "required",
];
const sensitiveKeyCache = new Map<string, boolean>();

function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, "");
}

export function isSensitiveKey(key: string): boolean {
  const cached = sensitiveKeyCache.get(key);
  if (cached !== undefined) return cached;
  const k = normalizeKey(key);
  let sensitive = SENSITIVE_KEY_EXACT.has(k);
  if (!sensitive && !SAFE_KEY_SUFFIXES.some((suffix) => k.endsWith(suffix))) {
    sensitive =
      k.endsWith("token") ||
      k.endsWith("tokens") ||
      SENSITIVE_KEY_PARTS.some((part) => k.includes(part));
  }
  if (sensitiveKeyCache.size < 5000) sensitiveKeyCache.set(key, sensitive);
  return sensitive;
}

// tx/userOp/block hashes are 32-byte hex like private keys; fields named *hash keep them
function isHashKey(key: string): boolean {
  return /hash(es)?$/.test(normalizeKey(key));
}

const knownSecrets = new Map<string, string>();
let knownSecretsPattern: RegExp | null | undefined;

export function registerSecret(value: unknown, label = "secret"): void {
  if (typeof value !== "string") return;
  const secret = value.trim();
  if (secret.length < MIN_KNOWN_SECRET_LENGTH || knownSecrets.has(secret)) return;
  knownSecrets.set(secret, label.replace(/[^A-Za-z0-9_.-]/g, "_"));
  knownSecretsPattern = undefined;
}

const SENSITIVE_ENV_NAME =
  /KEY|SECRET|TOKEN|PASS|PWD|MNEMONIC|SEED|PRIVATE|CREDENTIAL|CONNECTION|WEBHOOK|AUTH|COOKIE|SALT|PEPPER|(^|_)(PK|DSN|URI|URL|RPC|CONF)($|_)/i;
const SAFE_ENV_NAMES = new Set([
  "PWD",
  "OLDPWD",
  "INIT_CWD",
  "HOME",
  "PATH",
  "SHELL",
  "TMPDIR",
  "TEMP",
  "TMP",
]);

export function registerSecretsFromEnv(env: NodeJS.ProcessEnv = process.env): void {
  for (const [name, value] of Object.entries(env)) {
    if (!value || SAFE_ENV_NAMES.has(name) || /^(npm_|yarn_|berry_)/i.test(name)) continue;
    if (/^(true|false|\d+)$/i.test(value) || /^(\/|[A-Za-z]:\\)/.test(value)) continue;
    if (SENSITIVE_ENV_NAME.test(name) || /^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
      registerSecret(value, name);
    }
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function getKnownSecretsPattern(): RegExp | null {
  if (knownSecretsPattern === undefined) {
    const values = [...knownSecrets.keys()].sort((a, b) => b.length - a.length);
    knownSecretsPattern = values.length
      ? new RegExp(values.map(escapeRegExp).join("|"), "g")
      : null;
  }
  return knownSecretsPattern;
}

// hosts whose URL path or query carries the account key
const RPC_PROVIDER_HOSTS = [
  "alchemy.com",
  "alchemyapi.io",
  "infura.io",
  "quiknode.pro",
  "ankr.com",
  "chainstack.com",
  "p2pify.com",
  "blastapi.io",
  "drpc.org",
  "getblock.io",
  "nodereal.io",
  "pimlico.io",
  "tenderly.co",
  "blockpi.network",
  "onfinality.io",
  "nownodes.io",
  "etherscan.io",
  "1rpc.io",
  "lavanet.xyz",
  "moralis-nodes.com",
  "thirdweb.com",
];
const SENSITIVE_QUERY_PARAMS = new Set([
  "key",
  "apikey",
  "dkey",
  "token",
  "accesstoken",
  "sessiontoken",
  "secret",
  "clientsecret",
  "password",
  "pass",
  "auth",
  "sig",
  "signature",
  "code",
]);

function maskPathSegment(segment: string): string {
  if (segment.length >= 20 && /\d/.test(segment) && /[A-Za-z]/.test(segment)) return MASK;
  return segment;
}

function sanitizeQuery(query: string): string {
  return query.replace(/([?&;])([^=&;#]*)=([^&;#]*)/g, (match, sep: string, name: string) => {
    const key = normalizeKey(decodeURIComponentSafe(name));
    return SENSITIVE_QUERY_PARAMS.has(key) || isSensitiveKey(name)
      ? `${sep}${name}=${MASK}`
      : match;
  });
}

function decodeURIComponentSafe(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function sanitizePath(path: string): string {
  return sanitizeString(path.split("/").map(maskPathSegment).join("/"));
}

function sanitizeUrl(url: string): string {
  const withoutUserinfo = url.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/?#@\s]*@/i, `$1${MASK}@`);
  const parts = /^([a-z][a-z0-9+.-]*:\/\/[^/?#]*)([^?#]*)(\?[^#]*)?(#.*)?$/i.exec(withoutUserinfo);
  if (!parts) return withoutUserinfo;
  const [, origin, path, query = "", fragment = ""] = parts;
  const host = origin
    .replace(/^[^:]*:\/\//, "")
    .replace(/^.*@/, "")
    .replace(/:\d+$/, "")
    .toLowerCase();
  const masked = fragment ? `#${MASK}` : "";
  if (RPC_PROVIDER_HOSTS.some((h) => host === h || host.endsWith(`.${h}`))) {
    return `${origin}${path.length > 1 ? `/${MASK}` : path}${query ? `?${MASK}` : ""}${masked}`;
  }
  return `${origin}${path.split("/").map(maskPathSegment).join("/")}${sanitizeQuery(query)}${masked}`;
}

const SECRET_KEY_NAMES =
  "x-api-key|api[_-]?key|apikey|secret|client[_-]?secret|password|passwd|pwd|private[_-]?key|privkey|mnemonic|seed[_-]?phrase|master[_-]?key|maintenance[_-]?key|session[_-]?token|access[_-]?token|refresh[_-]?token|id[_-]?token|auth[_-]?token|token|authorization|x-parse-master-key|x-parse-session-token|x-parse-maintenance-key";
const KEY_PREFIX = `(?<![A-Za-z0-9_-])(\\\\?["']?(?:${SECRET_KEY_NAMES})\\\\?["']?\\s*[:=]\\s*)`;

type Rule = [RegExp, string | ((match: string, ...groups: string[]) => string)];

const STRING_RULES: Rule[] = [
  // ethers v5 error messages embed the JSON-RPC request and response bodies verbatim
  [/\b(requestBody|body)=("(?:[^"\\]|\\.)*"|'[^']*')/g, `$1="${MASK}"`],
  [/\b[a-z][a-z0-9+.-]{1,15}:\/\/[^\s"'<>`]+/gi, (url) => sanitizeUrl(url)],
  [/\b(Bearer|Basic|Token)\s+[A-Za-z0-9._~+/=-]{6,}/g, `$1 ${MASK}`],
  [new RegExp(`${KEY_PREFIX}"[^"]*"`, "gi"), `$1"${MASK}"`],
  [new RegExp(`${KEY_PREFIX}'[^']*'`, "gi"), `$1'${MASK}'`],
  [new RegExp(`${KEY_PREFIX}(\\\\?["']?)[^\\s"'\\\\,;&}\\]]+`, "gi"), `$1$2${MASK}`],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, `eyJ${MASK}`],
  [/\bmk_[0-9a-f]{48}\b/gi, `mk_${MASK}`],
  [/\br:[0-9a-f]{32}\b/gi, `r:${MASK}`],
  [/\b(live|test|access)_[A-Za-z0-9]{20,}\b/g, `$1_${MASK}`],
  [/\b(AKIA|ASIA)[0-9A-Z]{16}\b/g, `$1${MASK}`],
  // AWS secret access keys: exactly 40 base64 characters mixing upper case, lower case and digits
  [
    /(?<![A-Za-z0-9/+=])(?=[A-Za-z0-9/+]{0,39}[a-z])(?=[A-Za-z0-9/+]{0,39}[A-Z])(?=[A-Za-z0-9/+]{0,39}\d)[A-Za-z0-9/+]{40}(?![A-Za-z0-9/+=])/g,
    (key) => maskSecret(key),
  ],
  [/\bgh[pousr]_[A-Za-z0-9]{30,}\b/g, `gh_${MASK}`],
];
const HEX64_RULE: Rule = [
  /\b(0x)?([0-9a-fA-F]{64})\b/g,
  (_m, prefix = "", hex = "") => `${prefix}${hex.slice(0, MASKED_PREFIX_CHARS)}${MASK}`,
];
// customer API keys are 16 random bytes in hex
const API_KEY_RULE: Rule = [/\b[0-9a-fA-F]{32}\b/g, (key) => maskSecret(key)];

export interface SanitizeStringOptions {
  keepHashes?: boolean;
}

export function sanitizeString(value: string, options: SanitizeStringOptions = {}): string {
  if (value.length < MIN_KNOWN_SECRET_LENGTH) return value;
  let out = value.length > MAX_SCAN_LENGTH ? value.slice(0, MAX_SCAN_LENGTH) : value;
  const known = getKnownSecretsPattern();
  if (known)
    out = out.replace(known, (match) => `[REDACTED:${knownSecrets.get(match) ?? "secret"}]`);
  for (const [pattern, replacement] of STRING_RULES) {
    out = out.replace(pattern, replacement as any);
  }
  if (!options.keepHashes) out = out.replace(HEX64_RULE[0], HEX64_RULE[1] as any);
  out = out.replace(API_KEY_RULE[0], API_KEY_RULE[1] as any);
  if (out.length > MAX_STRING_LENGTH) {
    out = `${out.slice(0, MAX_STRING_LENGTH)}...[truncated ${value.length - MAX_STRING_LENGTH} chars]`;
  }
  return out;
}

export function sanitizeValue(
  value: unknown,
  key?: string,
  depth = 0,
  seen?: WeakSet<object>
): unknown {
  if (value === null || value === undefined) return value;
  if (key !== undefined && isSensitiveKey(key)) return REDACTED;
  switch (typeof value) {
    case "string":
      return sanitizeString(value, { keepHashes: key !== undefined && isHashKey(key) });
    case "number":
    case "boolean":
      return value;
    case "bigint":
      return value.toString();
    case "symbol":
    case "function":
      return undefined;
  }
  if (value instanceof Error) return serializeError(value, depth + 1);
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  if (Buffer.isBuffer(value)) return `[Buffer ${value.length} bytes]`;
  if (depth >= MAX_DEPTH) return "[Truncated]";
  const visited = seen ?? new WeakSet<object>();
  if (visited.has(value as object)) return "[Circular]";
  visited.add(value as object);
  if (Array.isArray(value) || value instanceof Set) {
    const items = [...value];
    const out = items
      .slice(0, MAX_ARRAY_ITEMS)
      .map((item) => sanitizeValue(item, key, depth + 1, visited));
    if (items.length > MAX_ARRAY_ITEMS) out.push(`[${items.length - MAX_ARRAY_ITEMS} more]`);
    return out;
  }
  if (value instanceof Map) {
    return sanitizeObject(Object.fromEntries(value), depth, visited);
  }
  const toJSON = (value as { toJSON?: unknown }).toJSON;
  if (typeof toJSON === "function") {
    return sanitizeValue(toJSON.call(value), key, depth + 1, visited);
  }
  return sanitizeObject(value as Record<string, unknown>, depth, visited);
}

function sanitizeObject(
  value: Record<string, unknown>,
  depth: number,
  seen: WeakSet<object>
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const keys = Object.keys(value);
  for (const k of keys.slice(0, MAX_OBJECT_KEYS)) {
    const v = sanitizeValue(value[k], k, depth + 1, seen);
    if (v !== undefined) out[k] = v;
  }
  if (keys.length > MAX_OBJECT_KEYS) out._truncatedKeys = keys.length - MAX_OBJECT_KEYS;
  return out;
}

// top-level pass for a log line; keys in `skip` are left to their pino serializer
export function sanitizeFields(
  fields: Record<string, unknown>,
  skip: ReadonlySet<string>
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(fields)) {
    const v = skip.has(k) ? fields[k] : sanitizeValue(fields[k], k);
    if (v !== undefined) out[k] = v;
  }
  return out;
}
