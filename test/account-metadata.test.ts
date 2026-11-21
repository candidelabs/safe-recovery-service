import {ethers} from "ethers";
import {SiweMessage} from "siwe";
import {Network} from "../src/models/network";
import {isSensitiveKey} from "../src/logging";
import {ApiError} from "../src/utils/error";
import {validate} from "../src/middlewares/validate";
import {
    ACCOUNT_METADATA_MAX_BYTES,
    ACCOUNT_METADATA_MAX_ENTRIES,
    ACCOUNT_METADATA_MAX_VALUE_LENGTH,
    accountMetadataProblem,
    storedAccountMetadata,
} from "../src/utils/account-metadata";
import {lookupAccounts} from "../src/utils/account-lookup";

// The rules of account metadata (src/utils/account-metadata.ts), its Joi validator and the account lookup's rule
// (src/utils/account-lookup.ts), without a database. The services that store and return it are in
// test/verification-rules.test.ts (in-memory tables) and test/verification.test.ts (Postgres).

const CHAIN_A = 11155111;
const CHAIN_B = 11155420;
const CHAIN_DISABLED = 84532;
// the auth schemas read Network.supportedChainIds when they load
Network.supportedChainIds.push(CHAIN_A, CHAIN_B);

// Characters are built from their code points, so that this file stays ASCII and every one is explicit.
const char = (...codePoints: number[]) => String.fromCodePoint(...codePoints);
const object = (entries: number, value = "v") => Object.fromEntries(Array.from({length: entries}, (_, i) => [`key${i}`, value]));

const TYPE = "must be an object of string values";
const ENTRIES = "must have at most 10 entries";
const KEYS = "keys must be 1 to 32 characters of letters, digits, underscore, dot, colon or hyphen, and start with a letter or a digit";
const VALUES = "values must be non-empty strings";
const VALUE_LENGTH = "values must be at most 256 characters long";
const VALUE_CHARACTERS = "values must not contain control characters";
const BYTES = "must be at most 2048 bytes as JSON";

describe("accountMetadataProblem", () => {
    test("the limits", () => {
        expect(ACCOUNT_METADATA_MAX_ENTRIES).toBe(10);
        expect(ACCOUNT_METADATA_MAX_VALUE_LENGTH).toBe(256);
        expect(ACCOUNT_METADATA_MAX_BYTES).toBe(2048);
    });

    test.each([
        ["no entry", {}],
        ["one entry", {label: "Savings"}],
        ["10 entries", object(10)],
        ["a 32-character key", {["k".repeat(32)]: "v"}],
        ["keys with dots, colons, underscores and hyphens", {"com.example.profileId": "p-1", "app:id": "42", "a_b-c": "x", "0start": "y"}],
        ["a key named like an Object method", {constructor: "x", toString: "y", hasOwnProperty: "z"}],
        ["a 256-character value", {label: "x".repeat(256)}],
        ["non-Latin text", {label: char(0x50a8, 0x84c4, 0x8d26, 0x6237), other: char(0x0421, 0x0431, 0x0435, 0x0440)}],
        ["an emoji ZWJ sequence", {label: char(0x1f469, 0x200d, 0x1f4bb) + " work"}],
        ["a zero-width non-joiner", {label: "a" + char(0x200c) + "b"}],
        ["a value with spaces", {label: "  My savings account  "}],
    ])("accepts %s", (_name, value) => {
        expect(accountMetadataProblem(value)).toBeUndefined();
    });

    test.each([
        ["null", null, TYPE],
        ["undefined", undefined, TYPE],
        ["an array", [["label", "x"]], TYPE],
        ["a string", "label", TYPE],
        ["a number", 42, TYPE],
        ["a class instance", new Date(), TYPE],
        ["a nested object as a value", {label: {name: "x"}}, VALUES],
        ["a number as a value", {label: 42}, VALUES],
        ["a boolean as a value", {label: true}, VALUES],
        ["null as a value", {label: null}, VALUES],
        ["an empty value", {label: ""}, VALUES],
        ["11 entries", object(11), ENTRIES],
        ["an empty key", {"": "x"}, KEYS],
        ["a 33-character key", {["k".repeat(33)]: "v"}, KEYS],
        ["a key starting with an underscore", {_label: "x"}, KEYS],
        ["a key starting with a dot", {".label": "x"}, KEYS],
        ["a key with a space", {"my label": "x"}, KEYS],
        ["a non-ASCII key", {["caf" + char(0xe9)]: "x"}, KEYS],
        ["__proto__ as parsed from JSON", JSON.parse("{\"__proto__\": \"x\"}"), KEYS],
        ["a 257-character value", {label: "x".repeat(257)}, VALUE_LENGTH],
        ["a line feed", {label: "a" + char(0x0a) + "b"}, VALUE_CHARACTERS],
        ["a tab", {label: "a" + char(0x09) + "b"}, VALUE_CHARACTERS],
        ["U+0000", {label: "a" + char(0x00) + "b"}, VALUE_CHARACTERS],
        ["U+007F", {label: "a" + char(0x7f) + "b"}, VALUE_CHARACTERS],
        ["U+0085", {label: "a" + char(0x85) + "b"}, VALUE_CHARACTERS],
        ["an unpaired surrogate", {label: "a" + String.fromCharCode(0xd83d) + "b"}, VALUE_CHARACTERS],
        ["U+2028", {label: "a" + char(0x2028) + "b"}, VALUE_CHARACTERS],
        ["U+2029", {label: "a" + char(0x2029) + "b"}, VALUE_CHARACTERS],
        ["a right-to-left override", {label: "a" + char(0x202e) + "b"}, VALUE_CHARACTERS],
        ["a left-to-right embedding", {label: "a" + char(0x202a) + "b"}, VALUE_CHARACTERS],
        ["a left-to-right isolate", {label: "a" + char(0x2066) + "b"}, VALUE_CHARACTERS],
        ["a pop directional isolate", {label: "a" + char(0x2069) + "b"}, VALUE_CHARACTERS],
        // ten values of 256 three-byte characters: each within its limits, 7.7 KB in all
        ["more than 2048 bytes", object(10, char(0x50a8).repeat(256)), BYTES],
    ])("refuses %s", (_name, value, problem) => {
        expect(accountMetadataProblem(value)).toBe(problem);
    });

    test("names the first rule broken, in the order of the rules", () => {
        expect(accountMetadataProblem({...object(11), _bad: ""})).toBe(ENTRIES);
        expect(accountMetadataProblem({_bad: "", other: 42})).toBe(KEYS);
        expect(accountMetadataProblem({a: "", b: "x".repeat(300)})).toBe(VALUES);
        expect(accountMetadataProblem({a: "x".repeat(300), b: char(0x0a)})).toBe(VALUE_LENGTH);
    });

    test("counts a value's length in UTF-16 code units and the total in UTF-8 bytes", () => {
        // an emoji is two code units
        expect(accountMetadataProblem({label: char(0x1f600).repeat(128)})).toBeUndefined();
        expect(accountMetadataProblem({label: char(0x1f600).repeat(128) + "x"})).toBe(VALUE_LENGTH);
        // compact JSON: {"key0":"...", ...}; 8 entries of 256 ASCII characters fit, a ninth does not
        expect(accountMetadataProblem(object(7, "x".repeat(256)))).toBeUndefined();
        expect(accountMetadataProblem(object(8, "x".repeat(256)))).toBe(BYTES);
    });
});

describe("storedAccountMetadata", () => {
    test("reads anything that is not an object as no metadata", () => {
        for (const value of [null, undefined, [], ["label"], "label", 42]) {
            expect(storedAccountMetadata(value)).toEqual({});
        }
    });

    test("keeps the string values of an object and drops the others, without checking the limits again", () => {
        expect(storedAccountMetadata({label: "Savings", count: 3, nested: {a: "b"}, none: null})).toEqual({label: "Savings"});
        const long = {["_".repeat(40)]: "x".repeat(1000)};
        expect(storedAccountMetadata(long)).toEqual(long);
    });

    test("keeps a key named __proto__ as a plain property", () => {
        const stored = storedAccountMetadata(JSON.parse("{\"__proto__\": \"x\", \"label\": \"y\"}"));
        expect(Object.getPrototypeOf(stored)).toBe(Object.prototype);
        expect(Object.keys(stored)).toEqual(["__proto__", "label"]);
    });
});

describe("metadata validation (Joi)", () => {
    // required here, not imported: the schemas read Network.supportedChainIds when they load
    const authValidation = require("../src/validations/auth.validation");
    const wallet = ethers.Wallet.createRandom();
    const message = new SiweMessage({
        domain: "example.com",
        address: wallet.address,
        statement: "statement",
        uri: "https://example.com",
        chainId: CHAIN_A,
        version: "1",
        nonce: "abcdefgh1234",
        issuedAt: new Date().toISOString(),
    }).prepareMessage();
    const registerBody = {account: wallet.address, chainId: CHAIN_A, channel: "email", target: "user@example.com", message, signature: "0x1234"};
    const metadataBody = {account: wallet.address, chainId: CHAIN_A, message, signature: "0x1234"};
    const schemas: [string, object, Record<string, unknown>][] = [
        ["register", authValidation.register, registerBody],
        ["setAccountMetadata", authValidation.setAccountMetadata, metadataBody],
    ];
    const validationError = (schema: object, body: Record<string, unknown>): string | undefined => {
        let error: ApiError | undefined;
        validate(schema)({body} as never, {} as never, ((e?: ApiError) => { error = e; }) as never);
        return error?.message;
    };
    // distinctive keys and values, which no message may quote
    const refused: [string, unknown, string][] = [
        ["null", null, TYPE],
        ["an array", ["Secret-Array-Value"], TYPE],
        ["a string", "Secret-String-Value", TYPE],
        ["a nested object", {"Secret-Key": {nested: "Secret-Nested-Value"}}, VALUES],
        ["an empty value", {secretKeyOne: ""}, VALUES],
        ["11 entries", object(11, "Secret-Many-Value"), ENTRIES],
        ["a key starting with an underscore", {"_Secret-Key-Two": "Secret-Value-Two"}, KEYS],
        ["a long value", {secretKeyThree: "Secret-Value-Three-" + "x".repeat(300)}, VALUE_LENGTH],
        ["a line feed", {secretKeyFour: "Secret-Value-Four" + char(0x0a) + "Line"}, VALUE_CHARACTERS],
        ["more than 2048 bytes", object(10, "Secret-Bytes-Value" + char(0x50a8).repeat(200)), BYTES],
    ];

    test("register accepts a body with or without metadata", () => {
        expect(validationError(authValidation.register, registerBody)).toBeUndefined();
        expect(validationError(authValidation.register, {...registerBody, metadata: {label: "Savings"}})).toBeUndefined();
        expect(validationError(authValidation.register, {...registerBody, metadata: {}})).toBeUndefined();
    });

    test("setAccountMetadata requires metadata, and accepts {}", () => {
        expect(validationError(authValidation.setAccountMetadata, metadataBody)).toBe(`"metadata" is required`);
        expect(validationError(authValidation.setAccountMetadata, {...metadataBody, metadata: {}})).toBeUndefined();
        expect(validationError(authValidation.setAccountMetadata, {...metadataBody, metadata: {label: "Savings"}})).toBeUndefined();
    });

    describe.each(schemas)("%s", (_schemaName, schema, body) => {
        test.each(refused)("refuses %s with a fixed message", (_name, metadata, problem) => {
            expect(validationError(schema, {...body, metadata})).toBe(`"metadata" ${problem}`);
        });

        test("no message quotes a key or a value", () => {
            for (const [, metadata] of refused) {
                expect(validationError(schema, {...body, metadata})).not.toMatch(/Secret/i);
            }
        });
    });

    test("register leaves the metadata as sent", () => {
        const body: Record<string, unknown> = {...registerBody, metadata: {label: "Savings", constructor: "x"}};
        const request = {body};
        validate(authValidation.register)(request as never, {} as never, (() => undefined) as never);
        expect(request.body.metadata).toEqual({label: "Savings", constructor: "x"});
    });
});

describe("lookupAccounts", () => {
    const ACCOUNT_1 = "0x1111111111111111111111111111111111111111";
    const ACCOUNT_2 = "0x2222222222222222222222222222222222222222";
    const ACCOUNT_3 = "0xAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAa";
    const AT = new Date("2026-11-20T10:00:00.000Z");
    const registration = (account: string, chainId: number, createdAt = AT) => ({account, chainId, createdAt});
    const entry = (account: string, chainId: number, metadata = {}, registeredAt = AT.toISOString()) => ({account, chainId, registeredAt, metadata});

    test("keeps one lower-case entry per account and chain, on enabled chains, sorted by account then chainId", () => {
        const accounts = lookupAccounts([
            registration(ACCOUNT_3, CHAIN_A),
            registration(ACCOUNT_2, CHAIN_B),
            registration(ACCOUNT_2, CHAIN_A),
            registration(ACCOUNT_3.toLowerCase(), CHAIN_A),
            registration(ACCOUNT_1, CHAIN_DISABLED),
            registration(ACCOUNT_1, CHAIN_B),
        ], [CHAIN_A, CHAIN_B]);
        expect(accounts).toEqual([
            entry(ACCOUNT_1, CHAIN_B),
            entry(ACCOUNT_2, CHAIN_A),
            entry(ACCOUNT_2, CHAIN_B),
            entry(ACCOUNT_3.toLowerCase(), CHAIN_A),
        ]);
    });

    test("returns nothing when no registration is on an enabled chain", () => {
        expect(lookupAccounts([registration(ACCOUNT_1, CHAIN_DISABLED)], [CHAIN_A])).toEqual([]);
        expect(lookupAccounts([], [CHAIN_A], [{account: ACCOUNT_1, chainId: CHAIN_A, metadata: {label: "x"}}])).toEqual([]);
    });

    test("gives each entry the metadata of the same account (any case) and chain, else {}", () => {
        const accounts = lookupAccounts(
            [registration(ACCOUNT_3, CHAIN_A), registration(ACCOUNT_3.toLowerCase(), CHAIN_B), registration(ACCOUNT_1, CHAIN_A), registration(ACCOUNT_2, CHAIN_B)],
            [CHAIN_A, CHAIN_B],
            [
                {account: ACCOUNT_3.toLowerCase(), chainId: CHAIN_A, metadata: {label: "Savings"}},
                {account: ACCOUNT_3, chainId: CHAIN_B, metadata: {label: "Spending", count: 3}},
                {account: ACCOUNT_2, chainId: CHAIN_A, metadata: {label: "Other chain"}},
            ],
        );
        expect(accounts).toEqual([
            entry(ACCOUNT_1, CHAIN_A),
            entry(ACCOUNT_2, CHAIN_B),
            entry(ACCOUNT_3.toLowerCase(), CHAIN_A, {label: "Savings"}),
            entry(ACCOUNT_3.toLowerCase(), CHAIN_B, {label: "Spending"}),
        ]);
    });

    test("ignores a metadata row of a disabled chain", () => {
        expect(lookupAccounts(
            [registration(ACCOUNT_1, CHAIN_A), registration(ACCOUNT_1, CHAIN_DISABLED)],
            [CHAIN_A],
            [{account: ACCOUNT_1, chainId: CHAIN_DISABLED, metadata: {label: "Disabled"}}],
        )).toEqual([entry(ACCOUNT_1, CHAIN_A)]);
    });

    test("reads a stored value that is not an object as {}", () => {
        expect(lookupAccounts([registration(ACCOUNT_1, CHAIN_A)], [CHAIN_A], [{account: ACCOUNT_1, chainId: CHAIN_A, metadata: "x"}]))
            .toEqual([entry(ACCOUNT_1, CHAIN_A)]);
    });

    test("dates the entry with the earliest of its registrations", () => {
        const earliest = new Date("2026-01-02T03:04:05.006Z");
        expect(lookupAccounts([
            registration(ACCOUNT_3.toLowerCase(), CHAIN_A, new Date("2026-06-01T00:00:00.000Z")),
            registration(ACCOUNT_3, CHAIN_A, earliest),
            registration(ACCOUNT_3.toLowerCase(), CHAIN_A, new Date("2026-03-01T00:00:00.000Z")),
        ], [CHAIN_A])).toEqual([entry(ACCOUNT_3.toLowerCase(), CHAIN_A, {}, "2026-01-02T03:04:05.006Z")]);
    });
});

describe("logging", () => {
    test("the number of entries is written, not redacted", () => {
        expect(isSensitiveKey("metadataEntries")).toBe(false);
    });
});

describe("routes", () => {
    test("the auth router has POST /metadata", () => {
        // required here, not imported: the auth schemas read Network.supportedChainIds when they load
        const router = require("../src/routes/v1/auth.route").default;
        const routes = router.stack
            .filter((layer: {route?: unknown}) => layer.route)
            .map(({route}: {route: {path: string, methods: Record<string, boolean>}}) => `${Object.keys(route.methods).join(",")} ${route.path}`);
        expect(routes).toContain("post /metadata");
    });
});
