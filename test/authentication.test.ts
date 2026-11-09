import supertest from "supertest";
import {ethers} from "ethers";
import type {Express} from "express";
import {parseAuthentication} from "../src/config/config-manager";
import {percentEncodedPattern, sanitizeSentryEvent} from "../src/utils/sentry";

// options.authentication on the real app (src/index.ts, src/routes/v1/index.ts): an API key as the first path
// segment or a bearer token in the Authorization header. config.json is replaced by the configs below and the
// boot step that reads the database never resolves, so the app is built but never listens: no database and no
// chain (the providers are created, never called). Each config loads fresh singletons with jest.isolateModules.

let mockRawConfig: Record<string, any>;
jest.mock("../src/utils/file", () => ({readFile: () => mockRawConfig}));
jest.mock("../src/services/recovery-modules.service", () => ({
    ...jest.requireActual("../src/services/recovery-modules.service"),
    assignLegacyRequestRows: () => new Promise(() => {}),
}));

const V0_1_0_3_MINUTES = "0x949d01d424bE050D09C16025dd007CB59b3A8c66";
const CHAIN_ID = 11155111;
const API_KEY = "test-api-key-0123456789abcdef";
const BEARER_TOKEN = "test-bearer-token-0123456789abcdef";

const config = (authentication?: unknown): Record<string, any> => ({
    options: {
        env: "development",
        port: 4337,
        indexerAlert: "alert",
        trustProxy: true,
        rateLimit: 1000,
        ...(authentication === undefined ? {} : {authentication}),
    },
    signers: [{id: "signer", privateKey: ethers.Wallet.createRandom().privateKey}],
    alerts: [{id: "alert", channels: {email: {webhook: {endpoint: "https://webhook.example.com/"}}}}],
    networks: {
        sepolia: {
            enabled: true,
            chainId: CHAIN_ID,
            jsonRpcEndpoint: "http://127.0.0.1:1",
            recoveryModules: [{address: V0_1_0_3_MINUTES, fallback: true, indexer: {enabled: false, startBlock: 0}}],
            guardian: "signer",
            alerts: "alert",
        },
    },
});

type Loaded = {
    app: Express;
    routePattern: (req: any) => string | undefined;
    sanitizeString: (value: string) => string;
};

const load = (authentication?: unknown): Loaded => {
    mockRawConfig = config(authentication);
    let loaded: Loaded | undefined;
    jest.isolateModules(() => {
        loaded = {
            app: require("../src/index").app,
            routePattern: require("../src/middlewares/request-logger").routePattern,
            sanitizeString: require("../src/logging").sanitizeString,
        };
    });
    return loaded!;
};

const networkConfig = (path: string) => `${path}/v1/config/getNetworkConfig`;
const preflight = (app: Express, path: string) => supertest(app)
    .options(path)
    .set("Origin", "https://wallet.example.com")
    .set("Access-Control-Request-Method", "POST")
    .set("Access-Control-Request-Headers", "authorization,content-type");

describe("parseAuthentication", () => {
    test.each([
        ["omitted", undefined],
        ["null", null],
        ["~", "~"],
    ])("reads %s as no authentication", (_name, value) => {
        expect(parseAuthentication(value as any)).toEqual({});
    });

    test("takes an API key or a bearer token", () => {
        expect(parseAuthentication({apiKey: API_KEY})).toEqual({apiKey: API_KEY});
        expect(parseAuthentication({bearerToken: BEARER_TOKEN})).toEqual({bearerToken: BEARER_TOKEN});
        expect(parseAuthentication({bearerToken: "abcdefghijklmnop+/012=="})).toEqual({bearerToken: "abcdefghijklmnop+/012=="});
    });

    test("reads a field set to ~ as omitted", () => {
        expect(parseAuthentication({apiKey: "~", bearerToken: BEARER_TOKEN})).toEqual({bearerToken: BEARER_TOKEN});
    });

    test.each([
        ["both", {apiKey: API_KEY, bearerToken: BEARER_TOKEN}, "cannot have both 'apiKey' and 'bearerToken' defined"],
        ["neither", {}, "must have either 'apiKey' or 'bearerToken' defined"],
        ["both set to ~", {apiKey: "~", bearerToken: "~"}, "must have either 'apiKey' or 'bearerToken' defined"],
        ["a string", "short-secret", "must be an object with either 'apiKey' or 'bearerToken', or '~'"],
        ["a list", [API_KEY], "must be an object with either 'apiKey' or 'bearerToken', or '~'"],
        ["a short API key", {apiKey: "0123456789abcde"}, "Options.authentication.apiKey must be a string of at least 16 characters"],
        ["an API key that is not a string", {apiKey: 1234567890123456}, "Options.authentication.apiKey must be a string"],
        ["an API key with a slash", {apiKey: "0123456789/abcdef"}, "Options.authentication.apiKey may only contain"],
        ["an API key with a percent sign", {apiKey: "0123456789%2Fabcdef"}, "Options.authentication.apiKey may only contain"],
        ["a short bearer token", {bearerToken: "0123456789abcde"}, "Options.authentication.bearerToken must be a string of at least 16 characters"],
        ["a bearer token with a space", {bearerToken: "0123456789 abcdef"}, "Options.authentication.bearerToken may only contain"],
        ["a bearer token with '=' inside", {bearerToken: "0123456789=abcdef"}, "Options.authentication.bearerToken may only contain"],
    ])("rejects %s", (_name, value, message) => {
        expect(() => parseAuthentication(value as any)).toThrow(message);
    });

    test("never puts the secret in the error", () => {
        const secret = "0123456789/abcdef";
        expect(() => parseAuthentication({apiKey: secret})).toThrow(expect.objectContaining({
            message: expect.not.stringContaining(secret),
        }));
    });
});

describe("without authentication", () => {
    let loaded: Loaded;
    beforeAll(() => { loaded = load(); });

    test("serves /v1 to anyone", async () => {
        await supertest(loaded.app).get(networkConfig("")).query({chainId: CHAIN_ID}).expect(200);
    });

    test("logs the request path as it is", () => {
        expect(loaded.routePattern({route: {path: "/getNetworkConfig"}, originalUrl: networkConfig(""), baseUrl: ""}))
            .toBe("/v1/config/getNetworkConfig");
    });
});

describe("API key", () => {
    let loaded: Loaded;
    beforeAll(() => { loaded = load({apiKey: API_KEY}); });

    test("serves the routes under /<apiKey>/v1", async () => {
        const response = await supertest(loaded.app).get(networkConfig(`/${API_KEY}`)).query({chainId: CHAIN_ID}).expect(200);
        expect(response.body.name).toBe("sepolia");
    });

    test.each([
        ["no key", ""],
        ["another key", "/test-api-key-0123456789abcdeX"],
        ["a prefix of the key", `/${API_KEY.slice(0, -1)}`],
        ["the key with a suffix", `/${API_KEY}0`],
    ])("answers 401 to %s", async (_name, prefix) => {
        const response = await supertest(loaded.app).get(networkConfig(prefix)).query({chainId: CHAIN_ID}).expect(401);
        expect(response.body).toMatchObject({code: 401, message: "Invalid API key"});
    });

    // Express decodes the path before the key is checked, hence the Sentry redaction below
    test("accepts the key percent-encoded", async () => {
        await supertest(loaded.app).get(networkConfig(`/%74${API_KEY.slice(1)}`)).query({chainId: CHAIN_ID}).expect(200);
    });

    test("does not take the key as a bearer token", async () => {
        await supertest(loaded.app).get(networkConfig("")).set("Authorization", `Bearer ${API_KEY}`).expect(401);
    });

    test("answers 404 to an unknown route under the key", async () => {
        await supertest(loaded.app).get(`/${API_KEY}/v1/unknown`).expect(404);
    });

    test("answers CORS preflights without the key", async () => {
        await preflight(loaded.app, "/v1/auth/register").expect(204);
    });

    test("logs the key segment as :apiKey, whatever the request put there", () => {
        for (const key of [API_KEY, "wrong-key"]) {
            const req = {route: {path: "/getNetworkConfig"}, originalUrl: `${networkConfig(`/${key}`)}?chainId=1`, baseUrl: ""};
            expect(loaded.routePattern(req)).toBe("/:apiKey/v1/config/getNetworkConfig");
        }
    });

    test("redacts the key from every log line", () => {
        expect(loaded.sanitizeString(`GET /${API_KEY}/v1`)).toBe("GET /[REDACTED:options.authentication.apiKey]/v1");
    });
});

describe("bearer token", () => {
    let loaded: Loaded;
    beforeAll(() => { loaded = load({bearerToken: BEARER_TOKEN}); });

    test.each([
        ["Bearer"],
        ["bearer"],
    ])("serves /v1 with '%s <token>'", async (scheme) => {
        await supertest(loaded.app).get(networkConfig("")).query({chainId: CHAIN_ID})
            .set("Authorization", `${scheme} ${BEARER_TOKEN}`).expect(200);
    });

    test.each([
        ["no Authorization header", undefined],
        ["another scheme", `Basic ${BEARER_TOKEN}`],
        ["the token without a scheme", BEARER_TOKEN],
    ])("answers 401 with a challenge to %s", async (_name, authorization) => {
        const request = supertest(loaded.app).get(networkConfig("")).query({chainId: CHAIN_ID});
        const response = await (authorization === undefined ? request : request.set("Authorization", authorization)).expect(401);
        expect(response.headers["www-authenticate"]).toBe("Bearer");
        expect(response.body).toMatchObject({code: 401, message: "Bearer token required"});
    });

    test.each([
        ["another token", "test-bearer-token-0123456789abcdeX"],
        ["a prefix of the token", BEARER_TOKEN.slice(0, -1)],
    ])("answers 401 to %s", async (_name, token) => {
        const response = await supertest(loaded.app).get(networkConfig("")).query({chainId: CHAIN_ID})
            .set("Authorization", `Bearer ${token}`).expect(401);
        expect(response.headers["www-authenticate"]).toBe('Bearer error="invalid_token"');
        expect(response.body).toMatchObject({code: 401, message: "Invalid bearer token"});
    });

    test("answers 401 to an unknown v1 route without the token", async () => {
        await supertest(loaded.app).get("/v1/unknown").expect(401);
    });

    test("does not take the token as a path key", async () => {
        await supertest(loaded.app).get(networkConfig(`/${BEARER_TOKEN}`)).query({chainId: CHAIN_ID}).expect(404);
    });

    test("answers CORS preflights, which carry no Authorization header", async () => {
        const response = await preflight(loaded.app, "/v1/auth/register").expect(204);
        expect(response.headers["access-control-allow-headers"]).toContain("authorization");
    });

    test("redacts the token from every log line", () => {
        expect(loaded.sanitizeString(`got ${BEARER_TOKEN}`)).toBe("got [REDACTED:options.authentication.bearerToken]");
    });
});

describe("Sentry events", () => {
    // letters and '~' only, so no other redaction rule masks it
    const key = "test~api~key~abcdefgh";
    const redacted = "/[REDACTED:options.authentication.apiKey]/v1/config/getNetworkConfig";

    test.each([
        ["literal", key],
        ["percent-encoded", key.replace(/~/g, "%7E")],
        ["percent-encoded in lower case", key.replace(/~/g, "%7e")],
        ["fully percent-encoded", [...key].map((char) => `%${char.charCodeAt(0).toString(16)}`).join("")],
    ])("redact the API key %s", (_name, form) => {
        const event = sanitizeSentryEvent({
            request: {url: `http://localhost:4337/${form}/v1/config/getNetworkConfig`},
            contexts: {trace: {data: {"http.target": `/${form}/v1/config/getNetworkConfig`}}},
        }, percentEncodedPattern(key));
        expect(event.contexts.trace.data["http.target"]).toBe(redacted);
        expect(event.request.url).toBe(`http://localhost:4337${redacted}`);
    });

    test("leave other paths alone", () => {
        const event = sanitizeSentryEvent({request: {url: "/test~api~key~abcdefgX/v1"}}, percentEncodedPattern(key));
        expect(event.request.url).toBe("/test~api~key~abcdefgX/v1");
    });
});
