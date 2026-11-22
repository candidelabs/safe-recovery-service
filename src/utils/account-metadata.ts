// Account metadata (POST /v1/auth/register, POST /v1/auth/metadata): a small flat object of string values that an app
// stores with an account on a chain, so that a user who lost the owner key can tell the accounts of a lookup apart
// (POST /v1/auth/accounts). The rules live here, apart from the database and Joi, so they are tested without either.
//
// Security and privacy notes:
// - Advisory only. Metadata never authorizes, selects or filters anything. A recovery is decided by the registrations'
//   codes and the guardian's signature, exactly as without it.
// - Untrusted text. Whoever can sign for an account and verify a target chooses what its metadata says, and it is shown
//   to whoever proves that target later. Someone talked out of a verification code can therefore find a stranger's
//   account, with a label of the stranger's choosing, in their own lookup. An interface must render values as plain
//   text, never as HTML or a link, truncate them, and present the app's keys as a name the app stored, not as a
//   statement by the service. The reserved keys the service writes (SERVICE_METADATA_KEYS) are its own; their notes are
//   in src/utils/account-init-data.ts.
// - Not a secret. Everyone who controls a target registered for the account can read it, and the operator stores it in
//   plaintext. It must not hold a password, a recovery phrase or anything that grants access; a hint is a reminder, not
//   a second factor. An opaque id that only the app can resolve is the safest content.
// - Not signed. The SIWE message authorizes the request, not the object: a party holding a signed message can pair it
//   with other metadata while the message is still accepted and its nonce is free (on another replica or after a
//   restart, the nonce store being per process). The worst outcome is a wrong label.
// - Never logged, never in an alert. Log lines carry the number of entries (metadataEntries), never the object, a key or
//   a value, and no validation message quotes a key or a value (they reach the request log).
// - Deleted with the account's last registration on the chain, except the pending copy on an AuthRegistrationRequest
//   whose code was never submitted (those rows are kept).
//
// Nothing is trimmed, normalized or case-folded, and key order is not kept (jsonb reorders keys).
//
// Keys starting with an underscore are reserved for the service, and a request that sends one is refused. The service
// stores two: _factory and _factoryData, the init data of an account that registered before it was deployed
// (SERVICE_METADATA_KEYS, src/utils/account-init-data.ts). Reads return them as part of the object, and a write of the
// app's keys keeps them (mergeAccountMetadata): it replaces the app's keys only. The limits apply to what an app sends,
// so reserved keys do not count against them. Relaxing the refusal later (accepting them sent back unchanged, or
// ignoring them) breaks no client, while tightening a looser rule would.

/** An account's metadata: string keys to string values. `{}` means none. */
export type AccountMetadata = Record<string, string>;

/** At most this many entries. */
export const ACCOUNT_METADATA_MAX_ENTRIES = 10;
/** Keys starting with this are reserved for the service: an app cannot send them. */
export const ACCOUNT_METADATA_RESERVED_KEY_PREFIX = "_";
/** A key: 1 to 32 ASCII characters, starting with a letter or a digit (so never `__proto__`). */
export const ACCOUNT_METADATA_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,31}$/;
/** A value: a non-empty string of at most this many UTF-16 code units (`String.length`). */
export const ACCOUNT_METADATA_MAX_VALUE_LENGTH = 256;
/**
 * Characters a value must not contain: control characters (tab, CR and LF included), unpaired surrogates (Postgres
 * jsonb refuses them, as it refuses U+0000), U+2028, U+2029, and the bidi embedding, override and isolate controls,
 * which reorder what is displayed next to an address. The zero-width joiner and non-joiner stay allowed.
 */
export const ACCOUNT_METADATA_FORBIDDEN = /[\p{Cc}\p{Cs}\p{Zl}\p{Zp}\u202A-\u202E\u2066-\u2069]/u;
/**
 * A visible character, which every value must hold: one that is neither white space nor invisible, i.e. a format
 * character (U+200B, U+FEFF, a soft hyphen, a direction mark, a tag character) or another default-ignorable code point
 * (a variation selector, a Hangul filler), nor the braille blank U+2800, a symbol drawn as a space. A value of such
 * characters alone would be shown as an empty name. They stay allowed next to a visible one: an emoji sequence needs
 * the joiner and right-to-left text the direction marks. Best effort: a few rare symbols are drawn blank by most fonts
 * and still count as visible, so an interface must cope with a name that looks empty.
 */
export const ACCOUNT_METADATA_VISIBLE = /[^\p{White_Space}\p{Cf}\p{Default_Ignorable_Code_Point}⠀]/u;
/** The whole object: at most this many bytes as compact JSON in UTF-8, the bound for non-Latin text. */
export const ACCOUNT_METADATA_MAX_BYTES = 2048;

// One fixed text per rule, in the order they are checked. None quotes a key or a value, and none holds `{` or `}`
// (Joi reads those as template markers).
const PROBLEMS = {
  type: "must be an object of string values",
  entries: `must have at most ${ACCOUNT_METADATA_MAX_ENTRIES} entries`,
  reservedKey: "keys starting with an underscore are reserved",
  // the length is the one of ACCOUNT_METADATA_KEY_PATTERN
  key: "keys must be 1 to 32 characters of letters, digits, underscore, dot, colon or hyphen, and start with a letter or a digit",
  value: "values must be non-empty strings",
  valueLength: `values must be at most ${ACCOUNT_METADATA_MAX_VALUE_LENGTH} characters long`,
  valueCharacters: "values must not contain control characters",
  valueVisible: "values must contain a visible character",
  bytes: `must be at most ${ACCOUNT_METADATA_MAX_BYTES} bytes as JSON`,
};

/** Whether a key is reserved for the service. */
export const isReservedAccountMetadataKey = (key: string) => key.startsWith(ACCOUNT_METADATA_RESERVED_KEY_PREFIX);

// A JSON object: not null, not an array, not a class instance.
const isPlainObject = (value: unknown): value is Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

/**
 * The first rule `value` breaks, as a fixed text to put after the field's name, or undefined for valid metadata. The
 * rules are checked in this order: type, entries, reserved keys, keys, value type and emptiness, value length, value
 * characters, visible character, total size.
 */
export function accountMetadataProblem(value: unknown): string | undefined {
  if (!isPlainObject(value)) return PROBLEMS.type;
  const entries = Object.entries(value);
  if (entries.length > ACCOUNT_METADATA_MAX_ENTRIES) return PROBLEMS.entries;
  if (entries.some(([key]) => isReservedAccountMetadataKey(key))) return PROBLEMS.reservedKey;
  if (!entries.every(([key]) => ACCOUNT_METADATA_KEY_PATTERN.test(key))) return PROBLEMS.key;
  const values = entries.map(([, entry]) => entry);
  if (!values.every((entry): entry is string => typeof entry === "string" && entry.length > 0)) return PROBLEMS.value;
  if (values.some((entry) => entry.length > ACCOUNT_METADATA_MAX_VALUE_LENGTH)) return PROBLEMS.valueLength;
  if (values.some((entry) => ACCOUNT_METADATA_FORBIDDEN.test(entry))) return PROBLEMS.valueCharacters;
  if (!values.every((entry) => ACCOUNT_METADATA_VISIBLE.test(entry))) return PROBLEMS.valueVisible;
  if (Buffer.byteLength(JSON.stringify(value), "utf8") > ACCOUNT_METADATA_MAX_BYTES) return PROBLEMS.bytes;
  return undefined;
}

/**
 * Metadata as read from the database: `{}` for anything that is not a plain object, else its string values. The limits
 * are not applied again, so tightening one later cannot blank stored rows.
 */
export function storedAccountMetadata(value: unknown): AccountMetadata {
  if (!isPlainObject(value)) return {};
  // Object.fromEntries defines own properties, whatever the key
  return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
}

/**
 * The object a write stores: the reserved keys of the stored object, which an app cannot change, overridden by the
 * reserved keys of `service` (what the service writes itself), and the app's keys from `sent`, which replace all the
 * app's keys stored before (no merge between them). `sent` undefined means the app sent nothing: its stored keys are
 * kept. A reserved key in `sent`, which validation refuses, and a key of `service` that is not reserved are dropped.
 * `{}` as the result means the row is deleted.
 */
export function mergeAccountMetadata(stored: AccountMetadata, sent: AccountMetadata | undefined, service: AccountMetadata = {}): AccountMetadata {
  return Object.fromEntries([
    ...Object.entries(stored).filter(([key]) => isReservedAccountMetadataKey(key)),
    ...Object.entries(service).filter(([key]) => isReservedAccountMetadataKey(key)),
    ...Object.entries(sent ?? stored).filter(([key]) => !isReservedAccountMetadataKey(key)),
  ]);
}

/** The reserved keys the service stores: the init data of an account registered before it was deployed. */
export const SERVICE_METADATA_KEYS: readonly string[] = ["_factory", "_factoryData"];

/**
 * An internal marker of the pending copy on AuthRegistrationRequest.metadata: the app sent no metadata with register,
 * only the service has something to write. It never reaches AuthAccountMetadata or a response.
 */
export const PENDING_NO_APP_METADATA_KEY = "_noAppMetadata";

const serviceEntries = (metadata: AccountMetadata): AccountMetadata =>
  Object.fromEntries(Object.entries(metadata).filter(([key]) => SERVICE_METADATA_KEYS.includes(key)));
const appEntries = (metadata: AccountMetadata): AccountMetadata =>
  Object.fromEntries(Object.entries(metadata).filter(([key]) => !isReservedAccountMetadataKey(key)));

/**
 * What register keeps on the pending AuthRegistrationRequest until /submit: undefined (a null column) when there is
 * nothing, the app's object as sent when the service has nothing to add, else both, with the marker when the app sent
 * nothing (without it, init data alone would read as an app that sent `{}`, and its /submit would remove the app's keys).
 */
export function pendingRegistrationMetadata(sent: AccountMetadata | undefined, service: AccountMetadata): AccountMetadata | undefined {
  const kept = serviceEntries(service);
  if (Object.keys(kept).length === 0) return sent;
  if (sent === undefined) return {...kept, [PENDING_NO_APP_METADATA_KEY]: "1"};
  return {...appEntries(sent), ...kept};
}

/**
 * The pending copy as /submit reads it: `sent`, the app's object (undefined for a null column or when the marker is
 * set, so the stored app keys are kept), and `service`, the service's keys only (never the marker). A row written
 * before the service kept init data has no reserved key and reads as it did then.
 */
export function splitPendingRegistrationMetadata(value: unknown): {sent: AccountMetadata | undefined, service: AccountMetadata} {
  // == null: a column that was never written reads as null, or undefined in the tests' in-memory tables
  if (value == null) return {sent: undefined, service: {}};
  const pending = storedAccountMetadata(value);
  const noAppMetadata = Object.prototype.hasOwnProperty.call(pending, PENDING_NO_APP_METADATA_KEY);
  return {sent: noAppMetadata ? undefined : appEntries(pending), service: serviceEntries(pending)};
}
