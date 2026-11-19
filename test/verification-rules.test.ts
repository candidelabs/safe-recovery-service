import {ethers} from "ethers";
import {SiweMessage} from "siwe";
import {Network} from "../src/models/network";
import {Alerts} from "../src/models/alert/alerts";
import {AlertChannel} from "../src/models/alert/alert-channel";
import {EmailAlertChannel} from "../src/models/alert/email-alert-channel";
import {SMSAlertChannel} from "../src/models/alert/sms-alert-channel";
import {getTemplate} from "../src/models/alert/message-templates";
import {Signers} from "../src/models/signer/signers";
import {Signer} from "../src/models/signer/signer";
import {AccountEventTracker} from "../src/models/events/account-event-tracker";
import {Configuration} from "../src/config/config-manager";
import {isSensitiveKey} from "../src/logging";
import {ApiError} from "../src/utils/error";
import {validate} from "../src/middlewares/validate";
import {lookupAccounts} from "../src/utils/account-lookup";
import {
    ALREADY_VERIFIED,
    EXPIRED,
    TOO_MANY_TRIES,
    VERIFICATION_COOLDOWN_MS,
    VERIFICATION_TARGET_MAX_CODES,
    VERIFICATION_TARGET_WINDOW_MS,
    VERIFICATION_TOKEN_VALIDITY_MS,
    hashVerificationToken,
    newVerificationToken,
    refusedTry,
    refusedVerificationToken,
    selectVerificationChannel,
    targetCapped,
    targetLocked,
    verificationAlertIds,
    verificationChallengeSeed,
    withinCooldown,
} from "../src/utils/target-verification";
import {requestVerification, submitVerification} from "../src/services/verification.service";
import {createRegistration, listAccounts} from "../src/services/auth.service";
import {createSubscription} from "../src/services/alerts.service";

// Verifying an email address or phone number (POST /v1/auth/verification/request and /submit) and using the token
// (POST /v1/auth/accounts, /v1/auth/register, /v1/alerts/subscribe) without a database: the rules in
// src/utils/target-verification.ts, the Joi rule, the message templates, and the services against in-memory tables.
// The SIWE checks and the owner check are mocked (test/verification.test.ts signs for real on Postgres and Mailpit,
// test/alerts.test.ts subscribes on a chain).

// In-memory tables for the queries the services make (plain values, equals, in, gt/gte/lt; increment and
// decrement). Each call runs to completion before the next, like one SQL statement, so parallel submits
// interleave between calls only.
const mockTables: Record<string, any[]> = {};
jest.mock('../src/config/prisma-client', () => {
    const satisfies = (value: any, condition: any): boolean => {
        if (condition === null || typeof condition !== "object" || condition instanceof Date) return value === condition;
        return Object.entries(condition).every(([operator, operand]: [string, any]) => {
            switch (operator) {
                case "equals": return value === operand;
                case "in": return operand.includes(value);
                case "gt": return value > operand;
                case "gte": return value >= operand;
                case "lt": return value < operand;
                default: throw new Error(`unsupported operator ${operator}`);
            }
        });
    };
    const matches = (row: any, where: Record<string, any> = {}) => Object.entries(where).every(([key, condition]) => satisfies(row[key], condition));
    let nextId = 1;
    const table = (name: string) => {
        const rows = () => (mockTables[name] ??= []);
        const filter = (where: any) => rows().filter((row) => matches(row, where));
        return {
            findFirst: async ({where, orderBy}: any) => {
                const found = filter(where);
                if (orderBy?.createdAt === "desc") found.sort((a, b) => b.createdAt - a.createdAt);
                return found[0] ?? null;
            },
            findUnique: async ({where}: any) => filter(where)[0] ?? null,
            findMany: async ({where}: any) => filter(where),
            count: async ({where}: any) => filter(where).length,
            aggregate: async ({where}: any) => {
                const found = filter(where);
                return {
                    _sum: {tries: found.length ? found.reduce((sum, row) => sum + row.tries, 0) : null},
                    _count: {_all: found.length},
                };
            },
            create: async ({data}: any) => {
                const row = {id: `${name}-${nextId++}`, verifiedAt: null, createdAt: new Date(), updatedAt: new Date(), ...data};
                rows().push(row);
                return row;
            },
            update: async ({where, data}: any) => {
                const row = filter(where)[0];
                apply(row, data);
                return row;
            },
            updateMany: async ({where, data}: any) => {
                const found = filter(where);
                for (const row of found) apply(row, data);
                return {count: found.length};
            },
        };
    };
    const apply = (row: any, data: Record<string, any>) => {
        for (const [key, value] of Object.entries(data)) {
            if (value !== null && typeof value === "object" && "increment" in value) row[key] += value.increment;
            else if (value !== null && typeof value === "object" && "decrement" in value) row[key] -= value.decrement;
            else row[key] = value;
        }
    };
    return {prisma: new Proxy({}, {get: (_target, name: string) => table(name)})};
});

// The SIWE checks (self mode for register, owner mode for subscribe) and the owner check.
const mockSiwe = {
    validateSIWEMessage: jest.fn(),
    validateOwnerSIWEMessage: jest.fn(),
    requireAccountOwner: jest.fn(),
};
jest.mock("../src/utils", () => ({
    ...jest.requireActual("../src/utils"),
    validateSIWEMessage: (...args: unknown[]) => mockSiwe.validateSIWEMessage(...args),
    validateOwnerSIWEMessage: (...args: unknown[]) => mockSiwe.validateOwnerSIWEMessage(...args),
    requireAccountOwner: (...args: unknown[]) => mockSiwe.requireAccountOwner(...args),
}));

// Every log line, as {level, bindings of the child logger, fields, message}.
const mockLogLines: {level: string, bindings: Record<string, unknown>, fields: Record<string, unknown>, message?: string}[] = [];
jest.mock("../src/utils/logger", () => {
    const make = (bindings: Record<string, unknown>): unknown => {
        const write = (level: string) => (fields: Record<string, unknown> | string, message?: string) => {
            mockLogLines.push(typeof fields === "string" ? {level, bindings, fields: {}, message: fields} : {level, bindings, fields, message});
        };
        return {
            child: (more: Record<string, unknown>) => make({...bindings, ...more}),
            trace: write("trace"),
            debug: write("debug"),
            info: write("info"),
            warn: write("warn"),
            error: write("error"),
            fatal: write("fatal"),
            flush: () => undefined,
        };
    };
    return {__esModule: true, default: make({})};
});

const CHAIN_A = 11155111;
const CHAIN_B = 11155420;
const CHAIN_DISABLED = 84532;
const INDEXER_ALERT = "alert-d";
const GUARDIAN = "0x9999999999999999999999999999999999999999";
const OWNER = "0x4444444444444444444444444444444444444444";

jest.spyOn(Configuration, "instance").mockReturnValue({indexerAlert: INDEXER_ALERT} as unknown as Configuration);
Signers.instance().addSigner({id: "signer", signer: async () => GUARDIAN} as unknown as Signer);
const addSubscription = jest.spyOn(AccountEventTracker.instance(), "addSubscription");

// Enabled networks in config order, without the constructor (which starts an indexer).
const addNetwork = (chainId: number, guardian: string | undefined, alert: string) => {
    Network.instances.add(Object.assign(Object.create(Network.prototype) as Network, {chainId, name: `chain-${chainId}`, guardian, alert}));
    Network.supportedChainIds.push(chainId);
};
// email is offered by alert-a (first guardian network), alert-b and alert-d (options.indexerAlert); sms by alert-b
// and alert-d; alert-c is on a network without a guardian
const webhook = {endpoint: "https://webhook.example.com/"};
const channels: AlertChannel[] = [
    new EmailAlertChannel("alert-a", undefined, webhook),
    new EmailAlertChannel("alert-b", undefined, webhook),
    new SMSAlertChannel("alert-b", undefined, webhook),
    new SMSAlertChannel("alert-c", undefined, webhook),
    new EmailAlertChannel(INDEXER_ALERT, undefined, webhook),
    new SMSAlertChannel(INDEXER_ALERT, undefined, webhook),
];
const sent: {templateId: string, alertId: string, channel: string, target: string, subject?: string, otp: string}[] = [];
for (const channel of channels) {
    Alerts.instance().addAlertChannel(channel.alertId, channel);
    jest.spyOn(channel, "sendMessage").mockImplementation(async (templateId, target, overrides) => {
        sent.push({templateId, alertId: channel.alertId, channel: channel.channelName, target, subject: overrides!.subject, otp: overrides!.otp});
        return true;
    });
}
addNetwork(100, undefined, "alert-c");
addNetwork(CHAIN_A, "signer", "alert-a");
addNetwork(CHAIN_B, "signer", "alert-b");

beforeEach(() => {
    mockSiwe.validateSIWEMessage.mockReset().mockResolvedValue({counterfactual: false});
    mockSiwe.validateOwnerSIWEMessage.mockReset().mockResolvedValue({deployment: undefined});
    mockSiwe.requireAccountOwner.mockReset().mockResolvedValue({owners: [OWNER.toLowerCase()], deployed: true});
    addSubscription.mockClear();
});

const verifications = () => mockTables.targetVerification ?? [];
const verificationRow = (id: string) => verifications().find((row) => row.id === id);
const rowsFor = (target: string) => verifications().filter((row) => row.target === target);
const tokenRow = (token: string) => verifications().find((row) => row.tokenHash === hashVerificationToken(token));
const registrationsOf = (target: string) => (mockTables.authRegistration ?? [])
    .filter((row) => row.target === target)
    .map(({account, chainId, channel, guardian}) => ({account, chainId, channel, guardian}));
const subscriptionsOf = (target: string) => (mockTables.alertSubscription ?? []).filter((row) => row.target === target);
const sentTo = (target: string) => sent.filter((message) => message.target === target);
// sendMessage runs after the response (setImmediate)
const flushSends = () => new Promise((resolve) => setImmediate(resolve));
const statusOf = async (promise: Promise<unknown>) => promise.then(() => undefined, (e: ApiError) => [e.statusCode, e.message]);
const registerRow = (target: string, account: string, chainId: number, channel = "email") => {
    (mockTables.authRegistration ??= []).push({id: `registration-${account}-${chainId}-${(mockTables.authRegistration ?? []).length}`, account, chainId, channel, target, guardian: GUARDIAN});
};
let targets = 0;
const newTarget = () => `user${++targets}@example.com`;
const request = async (target: string, channel = "email") => {
    const challengeId = await requestVerification(channel, target);
    await flushSends();
    return challengeId;
};
const codeFor = (target: string) => {
    const messages = sentTo(target);
    expect(messages.length).toBeGreaterThan(0);
    return messages[messages.length - 1].otp;
};
const wrongCode = (code: string) => code === "000000" ? "111111" : "000000";
// A token for a target given in its normalized form.
const verify = async (target: string, channel = "email") => {
    const challengeId = await request(target, channel);
    return (await submitVerification(challengeId, codeFor(target))).verificationToken;
};
const fail = async (challengeId: string, target: string, times: number) => {
    for (let i = 0; i < times; i++) await statusOf(submitVerification(challengeId, wrongCode(codeFor(target))));
};
const backdate = (id: string, ms: number) => {
    const row = verificationRow(id);
    row.createdAt = new Date(row.createdAt.getTime() - ms);
};
// Ages every challenge of a target, so the latest stays the latest (two rows can share a millisecond).
const ageAll = (target: string, ms: number) => rowsFor(target).forEach((row) => backdate(row.id, ms));
const expireToken = (token: string) => {
    tokenRow(token).tokenExpiresAt = new Date(Date.now() - 1);
};
const registerWith = (account: string, chainId: number, target: string, verificationToken?: string, channel = "email") =>
    createRegistration(account, chainId, channel, target, "siwe message", "0x1234", verificationToken);
const subscribeWith = (account: string, target: string, verificationToken?: string, channel = "email") =>
    createSubscription(account, OWNER, CHAIN_A, channel, target, "siwe message", "0x1234", verificationToken);
const REFUSED = [403, "Invalid or expired verificationToken"];

const ACCOUNT_1 = "0x1111111111111111111111111111111111111111";
const ACCOUNT_2 = "0x2222222222222222222222222222222222222222";
const ACCOUNT_3 = "0xAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAa";

describe("lookupAccounts", () => {
    test("keeps one lower-case entry per account and chain, on enabled chains, sorted by account then chainId", () => {
        const accounts = lookupAccounts([
            {account: ACCOUNT_3, chainId: CHAIN_A},
            {account: ACCOUNT_2, chainId: CHAIN_B},
            {account: ACCOUNT_2, chainId: CHAIN_A},
            {account: ACCOUNT_3.toLowerCase(), chainId: CHAIN_A},
            {account: ACCOUNT_1, chainId: CHAIN_DISABLED},
            {account: ACCOUNT_1, chainId: CHAIN_B},
        ], [CHAIN_A, CHAIN_B]);
        expect(accounts).toEqual([
            {account: ACCOUNT_1, chainId: CHAIN_B},
            {account: ACCOUNT_2, chainId: CHAIN_A},
            {account: ACCOUNT_2, chainId: CHAIN_B},
            {account: ACCOUNT_3.toLowerCase(), chainId: CHAIN_A},
        ]);
    });

    test("returns nothing when no registration is on an enabled chain", () => {
        expect(lookupAccounts([{account: ACCOUNT_1, chainId: CHAIN_DISABLED}], [CHAIN_A])).toEqual([]);
        expect(lookupAccounts([], [CHAIN_A])).toEqual([]);
    });
});

describe("refusedTry", () => {
    const now = new Date("2026-11-18T12:00:00Z");
    const live = {verified: false, tries: 0, expiresAt: new Date(now.getTime() + 1000)};

    test("names a verified challenge first, with 400", () => {
        expect(refusedTry({verified: true, tries: 5, expiresAt: now}, now)).toBe(ALREADY_VERIFIED);
        expect(ALREADY_VERIFIED).toEqual({status: 400, message: "challengeId already verified"});
    });

    test("then an expired one", () => {
        expect(refusedTry({...live, tries: 5, expiresAt: now}, now)).toBe(EXPIRED);
        expect(EXPIRED).toEqual({status: 403, message: "challengeId has been expired"});
    });

    test("else a challenge with 5 tries", () => {
        expect(refusedTry({...live, tries: 5}, now)).toBe(TOO_MANY_TRIES);
        expect(TOO_MANY_TRIES).toEqual({status: 403, message: "Too many invalid challenges, request a new code"});
    });

    test("a target is locked from 10 tries within the window, and capped from 10 codes", () => {
        expect(targetLocked(9)).toBe(false);
        expect(targetLocked(10)).toBe(true);
        expect(targetCapped(9)).toBe(false);
        expect(targetCapped(10)).toBe(true);
    });
});

describe("verification channel", () => {
    const offered: Record<string, string[]> = {a: ["email"], b: ["email", "sms"], c: ["sms", "email"], d: ["email", "sms"]};
    const getChannel = (alertId: string, channel: string) => offered[alertId]?.includes(channel) ? `${alertId}:${channel}` : undefined;

    test("lists the alert of each network with a guardian in config order, then options.indexerAlert", () => {
        const networks = [{alert: "c"}, {guardian: "signer"}, {guardian: "signer", alert: "a"}, {guardian: "signer", alert: "b"}];
        expect(verificationAlertIds(networks, "d")).toEqual(["a", "b", "d"]);
        expect(verificationAlertIds(networks, undefined)).toEqual(["a", "b"]);
        expect(verificationAlertIds([], "d")).toEqual(["d"]);
    });

    test("takes the first alert that offers the channel", () => {
        expect(selectVerificationChannel("email", ["a", "b", "d"], getChannel)).toEqual({alertId: "a", alertChannel: "a:email"});
        expect(selectVerificationChannel("sms", ["a", "b", "d"], getChannel)).toEqual({alertId: "b", alertChannel: "b:sms"});
        // a deployment that only serves alerts
        expect(selectVerificationChannel("sms", ["a", "d"], getChannel)).toEqual({alertId: "d", alertChannel: "d:sms"});
    });

    test("finds nothing when no alert offers the channel", () => {
        expect(selectVerificationChannel("sms", ["a"], getChannel)).toBeUndefined();
        expect(selectVerificationChannel("email", [], getChannel)).toBeUndefined();
    });
});

describe("verification helpers", () => {
    test("the cooldown lasts 60 seconds", () => {
        const now = new Date("2026-11-18T12:00:00Z");
        expect(withinCooldown(new Date(now.getTime() - 59_999), now)).toBe(true);
        expect(withinCooldown(new Date(now.getTime() - 60_000), now)).toBe(false);
    });

    test("the code is seeded with the channel and the target", () => {
        expect(verificationChallengeSeed("email", "user@example.com")).toBe("email:user@example.com");
    });
});

describe("verificationToken", () => {
    const now = new Date("2026-11-19T12:00:00Z");
    const row = {channel: "email", target: "user@example.com", tokenExpiresAt: new Date(now.getTime() + 1)};

    test("is 32 random bytes in base64url", () => {
        const token = newVerificationToken();
        expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
        expect(Buffer.from(token, "base64url")).toHaveLength(32);
        expect(newVerificationToken()).not.toBe(token);
    });

    test("is stored as its SHA-256 hash, in hex", () => {
        expect(hashVerificationToken("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    });

    test("is refused when unknown, expired (at exactly now too) or issued for another channel or target", () => {
        expect(refusedVerificationToken(null, undefined, now)).toBe("unknown");
        expect(refusedVerificationToken(undefined, {channel: "email", target: "user@example.com"}, now)).toBe("unknown");
        expect(refusedVerificationToken({...row, tokenExpiresAt: now}, undefined, now)).toBe("expired");
        expect(refusedVerificationToken({...row, tokenExpiresAt: null}, undefined, now)).toBe("expired");
        expect(refusedVerificationToken(row, {channel: "sms", target: "user@example.com"}, now)).toBe("mismatch");
        expect(refusedVerificationToken(row, {channel: "email", target: "other@example.com"}, now)).toBe("mismatch");
    });

    test("is accepted while it lives, with or without an expectation", () => {
        expect(refusedVerificationToken(row, undefined, now)).toBeUndefined();
        expect(refusedVerificationToken(row, {channel: "email", target: "user@example.com"}, now)).toBeUndefined();
    });

    test("is redacted from logs by its key name", () => {
        expect(isSensitiveKey("verificationToken")).toBe(true);
    });
});

describe("verificationToken validation (Joi)", () => {
    // required here, not imported: the schemas read Network.supportedChainIds when they load
    const authValidation = require("../src/validations/auth.validation");
    const alertsValidation = require("../src/validations/alerts.validation");
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
    const cases: [string, object, Record<string, unknown>][] = [
        ["register", authValidation.register, {account: wallet.address, chainId: CHAIN_A, channel: "email", target: "user@example.com", message, signature: "0x1234"}],
        ["subscribe", alertsValidation.subscribe, {account: wallet.address, owner: wallet.address, chainId: CHAIN_A, channel: "email", target: "user@example.com", message, signature: "0x1234"}],
        ["accounts", authValidation.accounts, {}],
    ];
    const validationError = (schema: object, body: Record<string, unknown>): string | undefined => {
        let error: ApiError | undefined;
        validate(schema)({body} as never, {} as never, ((e?: ApiError) => { error = e; }) as never);
        return error?.message;
    };
    const token = newVerificationToken();

    test.each(cases)("%s accepts a well-formed token", (_name, schema, body) => {
        expect(validationError(schema, {...body, verificationToken: token})).toBeUndefined();
    });

    test("register and subscribe accept no token, the lookup requires one", () => {
        expect(validationError(cases[0][1], cases[0][2])).toBeUndefined();
        expect(validationError(cases[1][1], cases[1][2])).toBeUndefined();
        expect(validationError(cases[2][1], cases[2][2])).toBe(`"verificationToken" is required`);
    });

    test.each(cases)("%s refuses anything else with one message that never quotes the value", (_name, schema, body) => {
        for (const value of [token.slice(1), `${token.slice(1)}+`, `${token.slice(1)}/`, `${token.slice(1)}=`, `${token}A`, "", 12345]) {
            const error = validationError(schema, {...body, verificationToken: value});
            expect(error).toBe(`"verificationToken" must be a valid verification token`);
            if (value !== "") expect(error).not.toContain(String(value));
        }
    });
});

describe("routes", () => {
    test("the verification endpoints are auth routes, and the two-step lookup is gone", () => {
        // required here, not imported: the auth schemas read Network.supportedChainIds when they load
        const router = require("../src/routes/v1/auth.route").default;
        const routes = router.stack
            .filter((layer: {route?: unknown}) => layer.route)
            .map(({route}: {route: {path: string, methods: Record<string, boolean>}}) => `${Object.keys(route.methods).join(",")} ${route.path}`);
        expect(routes).toEqual(expect.arrayContaining(["post /verification/request", "post /verification/submit", "post /accounts"]));
        expect(routes).not.toContain("post /accounts/request");
        expect(routes).not.toContain("post /accounts/submit");
    });
});

describe("targetVerificationOtp template", () => {
    const render = (body: string, otp: string) => body.replace(/{{otp}}/g, otp);

    test("the email says what the code does, that it does not approve a recovery, and shows it once", () => {
        const email = getTemplate("email", "targetVerificationOtp");
        const body = render(email.body, "123456");
        expect(body).toContain("<div class=header>Verification code</div>");
        expect(body).toContain("Someone asked to verify this address with Safe Recovery. Your code is:");
        expect(body).toContain("With it, the app can show the accounts that use this address and add this address to an account.");
        expect(body).toContain("This code does not approve a recovery: recovering an account always asks for a code of its own.");
        expect(body).toContain("It is valid for 10 minutes. Do not share this code with anyone.");
        expect(body).toContain("If this wasn't you, ignore this message: nothing changes without the code.");
        expect(body.match(/\d{6}/g)).toEqual(["123456"]);
        expect(email.subject).toBe("{{subject}}");
    });

    test("the SMS is plain ASCII and fits one GSM-7 segment", () => {
        const sms = render(getTemplate("sms", "targetVerificationOtp").body, "123456");
        expect(sms).toBe("123456 is your Safe Recovery code to verify this number for your accounts. It does not approve a recovery. Expires in 10 min. Never share it.");
        expect(sms).toMatch(/^[\x20-\x7E]+$/);
        expect(sms).toHaveLength(141);
    });
});

describe("verification request (in-memory tables)", () => {
    test("sends a code to every valid target, registered or not, through the first guardian network offering the channel", async () => {
        const registered = newTarget();
        registerRow(registered, ACCOUNT_1, CHAIN_A);
        for (const target of [registered, newTarget()]) {
            const challengeId = await request(target);
            expect(sentTo(target)).toEqual([{
                templateId: "targetVerificationOtp",
                alertId: "alert-a",
                channel: "email",
                target,
                subject: "Your Safe Recovery verification code",
                otp: expect.stringMatching(/^\d{6}$/),
            }]);
            expect(verificationRow(challengeId)).toMatchObject({channel: "email", target, alertId: "alert-a", verified: false, tries: 0});
            expect(verificationRow(challengeId).tokenHash).toBeUndefined();
        }
    });

    test("normalizes the target as registration does", async () => {
        const challengeId = await request("  Mixed.Case@EXAMPLE.com ");
        expect(verificationRow(challengeId).target).toBe("mixed.case@example.com");
        expect(sentTo("mixed.case@example.com")).toHaveLength(1);

        const smsChallengeId = await request("+1 (555) 010-0000", "sms");
        expect(verificationRow(smsChallengeId)).toMatchObject({target: "+15550100000", alertId: "alert-b"});
        expect(sentTo("+15550100000")).toHaveLength(1);
    });

    test("falls back to options.indexerAlert when no network with a guardian offers the channel", async () => {
        const enabled = [...Network.supportedChainIds];
        Network.supportedChainIds.splice(0, enabled.length, 100);
        try {
            const target = newTarget();
            const challengeId = await request(target);
            expect(verificationRow(challengeId).alertId).toBe(INDEXER_ALERT);
            expect(sentTo(target)).toMatchObject([{alertId: INDEXER_ALERT, channel: "email"}]);
        } finally {
            Network.supportedChainIds.splice(0, Network.supportedChainIds.length, ...enabled);
        }
    });

    test("refuses a channel no alert offers and an invalid target", async () => {
        expect(await statusOf(requestVerification("push", newTarget()))).toEqual([400, "Target channel 'push' is not supported"]);
        expect(await statusOf(requestVerification("email", "not-an-email"))).toEqual([403, "Target is not compatible with the 'email' channel"]);
        expect(await statusOf(requestVerification("sms", "0555 010 0000"))).toEqual([403, "Target is not compatible with the 'sms' channel"]);
    });

    test("returns the latest challenge within the cooldown and sends one code", async () => {
        const target = newTarget();
        const first = await request(target);
        expect(await request(target)).toBe(first);
        expect(await request(`  ${target.toUpperCase()}`)).toBe(first);
        expect(sentTo(target)).toHaveLength(1);
        expect(rowsFor(target)).toHaveLength(1);

        backdate(first, VERIFICATION_COOLDOWN_MS);
        const second = await request(target);
        expect(second).not.toBe(first);
        expect(sentTo(target)).toHaveLength(2);
    });

    test("sends at most 10 codes to a target within 24 hours, then the latest challengeId and nothing more", async () => {
        const target = newTarget();
        const ids: string[] = [];
        for (let i = 0; i < VERIFICATION_TARGET_MAX_CODES; i++) {
            ids.push(await request(target));
            ageAll(target, VERIFICATION_COOLDOWN_MS);
        }
        expect(new Set(ids).size).toBe(10);
        expect(sentTo(target)).toHaveLength(10);

        expect(await request(target)).toBe(ids[9]);
        expect(rowsFor(target)).toHaveLength(10);
        expect(sentTo(target)).toHaveLength(10);

        // the oldest code leaves the window
        backdate(ids[0], VERIFICATION_TARGET_WINDOW_MS);
        const next = await request(target);
        expect(ids).not.toContain(next);
        expect(rowsFor(target)).toHaveLength(11);
        expect(sentTo(target)).toHaveLength(11);
    });

    test("sends no code and creates no row for a target with 10 wrong codes", async () => {
        const target = newTarget();
        const first = await request(target);
        await fail(first, target, 5);
        ageAll(target, VERIFICATION_COOLDOWN_MS);
        const second = await request(target);
        await fail(second, target, 5);
        ageAll(target, VERIFICATION_COOLDOWN_MS);

        expect(await request(target)).toBe(second);
        expect(rowsFor(target)).toHaveLength(2);
        expect(sentTo(target)).toHaveLength(2);
    });
});

describe("verification submit (in-memory tables)", () => {
    test("returns a token for the right code and stores only its hash", async () => {
        const target = newTarget();
        const challengeId = await request(target);
        const before = Date.now();
        const {verificationToken, verificationTokenExpiresAt} = await submitVerification(challengeId, codeFor(target));
        expect(verificationToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
        expect(verificationTokenExpiresAt.getTime()).toBeGreaterThanOrEqual(before + VERIFICATION_TOKEN_VALIDITY_MS);
        expect(verificationTokenExpiresAt.getTime()).toBeLessThanOrEqual(Date.now() + VERIFICATION_TOKEN_VALIDITY_MS);
        const row = verificationRow(challengeId);
        expect(row).toMatchObject({
            verified: true,
            verifiedAt: expect.any(Date),
            tries: 0,
            tokenHash: hashVerificationToken(verificationToken),
            tokenExpiresAt: verificationTokenExpiresAt,
        });
        expect(Object.values(row)).not.toContain(verificationToken);
    });

    test("counts a wrong code and locks the challenge after 5", async () => {
        const target = newTarget();
        const challengeId = await request(target);
        const code = codeFor(target);
        for (let tries = 1; tries <= 5; tries++) {
            expect(await statusOf(submitVerification(challengeId, wrongCode(code)))).toEqual([403, "Invalid challenge"]);
            expect(verificationRow(challengeId).tries).toBe(tries);
        }
        expect(await statusOf(submitVerification(challengeId, code))).toEqual([403, "Too many invalid challenges, request a new code"]);
        expect(verificationRow(challengeId)).toMatchObject({verified: false, tries: 5});
        expect(verificationRow(challengeId).tokenHash).toBeUndefined();
    });

    test("refuses an expired code", async () => {
        const target = newTarget();
        const challengeId = await request(target);
        verificationRow(challengeId).expiresAt = new Date(Date.now() - 1);
        expect(await statusOf(submitVerification(challengeId, codeFor(target)))).toEqual([403, "challengeId has been expired"]);
    });

    test("refuses a challenge submitted again after success, and an unknown challenge", async () => {
        const target = newTarget();
        const challengeId = await request(target);
        const {verificationToken} = await submitVerification(challengeId, codeFor(target));
        expect(await statusOf(submitVerification(challengeId, codeFor(target)))).toEqual([400, "challengeId already verified"]);
        expect(verificationRow(challengeId).tokenHash).toBe(hashVerificationToken(verificationToken));
        expect(await statusOf(submitVerification("no-such-challenge", "123456"))).toEqual([404, "challengeId not found"]);
    });

    test("refuses every code for a target after 10 wrong codes within 24 hours, until they leave the window", async () => {
        const target = newTarget();
        const first = await request(target);
        await fail(first, target, 5);
        ageAll(target, VERIFICATION_COOLDOWN_MS);
        const second = await request(target);
        await fail(second, target, 4);
        ageAll(target, VERIFICATION_COOLDOWN_MS);
        const third = await request(target);
        expect(sentTo(target)).toHaveLength(3);
        const thirdCode = codeFor(target);
        await statusOf(submitVerification(third, wrongCode(thirdCode)));

        expect(await statusOf(submitVerification(third, thirdCode))).toEqual([403, "Too many invalid challenges for this target, try again later"]);
        ageAll(target, VERIFICATION_COOLDOWN_MS);
        expect(await request(target)).toBe(third);
        expect(sentTo(target)).toHaveLength(3);

        // the failures leave the window
        backdate(first, VERIFICATION_TARGET_WINDOW_MS);
        backdate(second, VERIFICATION_TARGET_WINDOW_MS);
        const {verificationToken} = await submitVerification(third, thirdCode);
        expect(verificationRow(third).tokenHash).toBe(hashVerificationToken(verificationToken));
    });

    test("checks at most 5 codes of a challenge when wrong codes arrive at once", async () => {
        const target = newTarget();
        const challengeId = await request(target);
        const wrong = wrongCode(codeFor(target));
        const results = await Promise.all(Array.from({length: 20}, () => statusOf(submitVerification(challengeId, wrong))));
        expect(results.filter((result) => result?.[1] === "Invalid challenge")).toHaveLength(5);
        expect(results.filter((result) => result?.[1] === "Too many invalid challenges, request a new code")).toHaveLength(15);
        expect(verificationRow(challengeId).tries).toBe(5);
    });

    test("checks at most 10 codes of a target when submits arrive at once", async () => {
        const target = newTarget();
        const first = await request(target);
        await fail(first, target, 5);
        ageAll(target, VERIFICATION_COOLDOWN_MS);
        const second = await request(target);
        await fail(second, target, 3);
        ageAll(target, VERIFICATION_COOLDOWN_MS);
        const third = await request(target);
        const wrong = wrongCode(codeFor(target));

        const results = await Promise.all(Array.from({length: 10}, () => statusOf(submitVerification(third, wrong))));
        expect(results.every((result) => result?.[0] === 403)).toBe(true);
        expect(results.filter((result) => result?.[1] === "Invalid challenge").length).toBeLessThanOrEqual(2);
        const tries = rowsFor(target).reduce((sum, row) => sum + row.tries, 0);
        expect(tries).toBeLessThanOrEqual(10);
    });

    test("gives one token, the stored one, when the right code arrives twice at once", async () => {
        const target = newTarget();
        const challengeId = await request(target);
        const code = codeFor(target);
        const results = await Promise.all([1, 2].map(() => submitVerification(challengeId, code).then(
            ({verificationToken}) => verificationToken,
            (e: ApiError) => [e.statusCode, e.message],
        )));
        const tokens = results.filter((result): result is string => typeof result === "string");
        expect(tokens).toHaveLength(1);
        expect(results).toContainEqual([400, "challengeId already verified"]);
        expect(verificationRow(challengeId)).toMatchObject({verified: true, tries: 0, tokenHash: hashVerificationToken(tokens[0])});
    });
});

describe("account lookup with a token (in-memory tables)", () => {
    test("lists every account registered with the target on the enabled chains", async () => {
        const target = newTarget();
        registerRow(target, ACCOUNT_3, CHAIN_B);
        registerRow(target, ACCOUNT_3.toLowerCase(), CHAIN_A);
        registerRow(target, ACCOUNT_3, CHAIN_A);
        registerRow(target, ACCOUNT_1, CHAIN_A);
        registerRow(target, ACCOUNT_2, CHAIN_DISABLED);
        registerRow(target, ACCOUNT_2, CHAIN_A, "sms");
        registerRow("someone@example.com", ACCOUNT_2, CHAIN_A);

        expect(await listAccounts(await verify(target))).toEqual([
            {account: ACCOUNT_1, chainId: CHAIN_A},
            {account: ACCOUNT_3.toLowerCase(), chainId: CHAIN_A},
            {account: ACCOUNT_3.toLowerCase(), chainId: CHAIN_B},
        ]);
    });

    test("finds the target as normalized when it was verified", async () => {
        registerRow("lookup.case@example.com", ACCOUNT_1, CHAIN_A);
        const challengeId = await request("  Lookup.Case@EXAMPLE.com ");
        const {verificationToken} = await submitVerification(challengeId, codeFor("lookup.case@example.com"));
        expect(await listAccounts(verificationToken)).toEqual([{account: ACCOUNT_1, chainId: CHAIN_A}]);

        registerRow("+15550100009", ACCOUNT_2, CHAIN_B, "sms");
        const smsChallengeId = await request("+1 555 010 0009", "sms");
        const sms = await submitVerification(smsChallengeId, codeFor("+15550100009"));
        expect(await listAccounts(sms.verificationToken)).toEqual([{account: ACCOUNT_2, chainId: CHAIN_B}]);
    });

    test("lists nothing for a target without registrations", async () => {
        expect(await listAccounts(await verify(newTarget()))).toEqual([]);
    });

    test("can be called again while the token lives", async () => {
        const target = newTarget();
        const token = await verify(target);
        expect(await listAccounts(token)).toEqual([]);
        registerRow(target, ACCOUNT_2, CHAIN_A);
        expect(await listAccounts(token)).toEqual([{account: ACCOUNT_2, chainId: CHAIN_A}]);
    });

    test("refuses an unknown or expired token", async () => {
        expect(await statusOf(listAccounts(newVerificationToken()))).toEqual(REFUSED);
        const token = await verify(newTarget());
        expireToken(token);
        expect(await statusOf(listAccounts(token))).toEqual(REFUSED);
    });
});

describe("register with a token (in-memory tables)", () => {
    test("creates the registration at once, on each chain asked, and sends nothing", async () => {
        const target = newTarget();
        const token = await verify(target);
        const requestRows = (mockTables.authRegistrationRequest ?? []).length;

        const first = await registerWith(ACCOUNT_3, CHAIN_A, target, token);
        expect(first).toEqual({registrationId: expect.any(String), guardianAddress: GUARDIAN});
        // a second chain with the same token, the target in another case
        const second = await registerWith(ACCOUNT_3, CHAIN_B, `  ${target.toUpperCase()} `, token);
        expect(second).toEqual({registrationId: expect.any(String), guardianAddress: GUARDIAN});

        expect(registrationsOf(target)).toEqual([
            {account: ACCOUNT_3.toLowerCase(), chainId: CHAIN_A, channel: "email", guardian: GUARDIAN},
            {account: ACCOUNT_3.toLowerCase(), chainId: CHAIN_B, channel: "email", guardian: GUARDIAN},
        ]);
        expect(sentTo(target)).toHaveLength(1); // the verification code only
        expect((mockTables.authRegistrationRequest ?? []).length).toBe(requestRows);
        expect(mockSiwe.validateSIWEMessage).toHaveBeenCalledTimes(2);
        expect(await listAccounts(token)).toEqual([
            {account: ACCOUNT_3.toLowerCase(), chainId: CHAIN_A},
            {account: ACCOUNT_3.toLowerCase(), chainId: CHAIN_B},
        ]);
    });

    test("registers a phone number", async () => {
        const token = await verify("+15550100010", "sms");
        expect(await registerWith(ACCOUNT_1, CHAIN_B, "+1 555 010 0010", token, "sms")).toEqual({registrationId: expect.any(String), guardianAddress: GUARDIAN});
        expect(registrationsOf("+15550100010")).toEqual([{account: ACCOUNT_1, chainId: CHAIN_B, channel: "sms", guardian: GUARDIAN}]);
    });

    test("refuses an unknown, expired, other-target or other-channel token before the SIWE check", async () => {
        const target = newTarget();
        const expiredTarget = newTarget();
        const expiredToken = await verify(expiredTarget);
        expireToken(expiredToken);
        const otherToken = await verify(newTarget());
        const smsToken = await verify("+15550100011", "sms");

        for (const [token, refusedTarget] of [
            [newVerificationToken(), target],
            [expiredToken, expiredTarget],
            [otherToken, target],
            [smsToken, target],
        ]) {
            expect(await statusOf(registerWith(ACCOUNT_1, CHAIN_A, refusedTarget, token))).toEqual(REFUSED);
        }
        expect(await statusOf(registerWith(ACCOUNT_1, CHAIN_B, "+15550100011", otherToken, "sms"))).toEqual(REFUSED);
        expect(mockSiwe.validateSIWEMessage).not.toHaveBeenCalled();
        expect(registrationsOf(target)).toEqual([]);
        expect(registrationsOf(expiredTarget)).toEqual([]);
        expect(registrationsOf("+15550100011")).toEqual([]);
        expect(mockLogLines.slice(-5).map(({bindings, fields, message}) => ({...bindings, ...fields, message}))).toEqual([
            {component: "verification", use: "register", reason: "unknown", verificationId: undefined, statusCode: 403, message: "verification token refused"},
            {component: "verification", use: "register", reason: "expired", verificationId: tokenRow(expiredToken).id, statusCode: 403, message: "verification token refused"},
            {component: "verification", use: "register", reason: "mismatch", verificationId: tokenRow(otherToken).id, statusCode: 403, message: "verification token refused"},
            {component: "verification", use: "register", reason: "mismatch", verificationId: tokenRow(smsToken).id, statusCode: 403, message: "verification token refused"},
            {component: "verification", use: "register", reason: "mismatch", verificationId: tokenRow(otherToken).id, statusCode: 403, message: "verification token refused"},
        ]);
    });

    test("answers 409 for a registration that exists", async () => {
        const target = newTarget();
        const token = await verify(target);
        await registerWith(ACCOUNT_2, CHAIN_A, target, token);
        expect(await statusOf(registerWith(ACCOUNT_2, CHAIN_A, target, token))).toEqual([409, `An active registration already exists for ${ACCOUNT_2} on chainId ${CHAIN_A} on the 'email' channel`]);
        expect(registrationsOf(target)).toHaveLength(1);
    });

    test("stores nothing when the SIWE check fails", async () => {
        const target = newTarget();
        const token = await verify(target);
        mockSiwe.validateSIWEMessage.mockRejectedValue(new ApiError(403, "SIWE Message: invalid signature"));
        expect(await statusOf(registerWith(ACCOUNT_1, CHAIN_A, target, token))).toEqual([403, "SIWE Message: invalid signature"]);
        expect(registrationsOf(target)).toEqual([]);
        expect(sentTo(target)).toHaveLength(1);
    });

    test("without a token, sends the registration code and returns a challengeId as before", async () => {
        const target = newTarget();
        const response = await registerWith(ACCOUNT_1, CHAIN_A, target);
        expect(response).toEqual({challengeId: expect.any(String)});
        const {challengeId} = response as {challengeId: string};
        expect(sentTo(target)).toMatchObject([{templateId: "otpVerification", alertId: "alert-a", otp: expect.stringMatching(/^\d{6}$/)}]);
        expect(mockTables.authRegistrationRequest.find((row) => row.id === challengeId)).toMatchObject({
            account: ACCOUNT_1, chainId: CHAIN_A, channel: "email", target, verified: false,
        });
        expect(registrationsOf(target)).toEqual([]);
    });
});

describe("subscribe with a token (in-memory tables)", () => {
    test("creates an active, verified subscription, registers it for delivery, and sends nothing", async () => {
        const target = newTarget();
        const token = await verify(target);
        const response = await subscribeWith(ACCOUNT_3, `  ${target.toUpperCase()}`, token);
        expect(response).toEqual({subscriptionId: expect.any(String), active: true});

        expect(subscriptionsOf(target)).toEqual([expect.objectContaining({
            id: response.subscriptionId,
            account: ACCOUNT_3.toLowerCase(),
            owner: OWNER.toLowerCase(),
            channel: "email",
            target,
            active: true,
            verified: true,
            verifiedAt: expect.any(Date),
            challengeHash: "-",
            tries: 0,
        })]);
        expect(addSubscription).toHaveBeenCalledWith(ACCOUNT_3.toLowerCase(), response.subscriptionId, "email", target);
        expect(sentTo(target)).toHaveLength(1); // the verification code only
        expect(mockSiwe.validateOwnerSIWEMessage).toHaveBeenCalledTimes(1);
        expect(mockSiwe.requireAccountOwner).toHaveBeenCalledTimes(1);
    });

    test("refuses an unknown, expired, other-target or other-channel token before the SIWE check", async () => {
        const target = newTarget();
        const expiredTarget = newTarget();
        const expiredToken = await verify(expiredTarget);
        expireToken(expiredToken);
        const otherToken = await verify(newTarget());
        const smsToken = await verify("+15550100012", "sms");

        for (const [token, refusedTarget] of [
            [newVerificationToken(), target],
            [expiredToken, expiredTarget],
            [otherToken, target],
            [smsToken, target],
        ]) {
            expect(await statusOf(subscribeWith(ACCOUNT_1, refusedTarget, token))).toEqual(REFUSED);
        }
        expect(mockSiwe.validateOwnerSIWEMessage).not.toHaveBeenCalled();
        expect(mockSiwe.requireAccountOwner).not.toHaveBeenCalled();
        expect(subscriptionsOf(target)).toEqual([]);
        expect(subscriptionsOf(expiredTarget)).toEqual([]);
        expect(addSubscription).not.toHaveBeenCalled();
    });

    test("stores nothing when the owner check fails", async () => {
        const target = newTarget();
        const token = await verify(target);
        mockSiwe.requireAccountOwner.mockRejectedValue(new ApiError(403, "Owner must be a valid owner of the account"));
        expect(await statusOf(subscribeWith(ACCOUNT_1, target, token))).toEqual([403, "Owner must be a valid owner of the account"]);
        expect(subscriptionsOf(target)).toEqual([]);
        expect(addSubscription).not.toHaveBeenCalled();
    });

    test("answers 409 for an active subscription that exists", async () => {
        const target = newTarget();
        const token = await verify(target);
        await subscribeWith(ACCOUNT_2, target, token);
        expect(await statusOf(subscribeWith(ACCOUNT_2, target, token))).toEqual([409, `An active subscription already exists for ${OWNER} in ${ACCOUNT_2} on the 'email' channel`]);
        expect(subscriptionsOf(target)).toHaveLength(1);
    });

    test("without a token, sends the subscription code and creates an inactive subscription as before", async () => {
        const target = newTarget();
        const response = await subscribeWith(ACCOUNT_1, target);
        expect(response).toEqual({subscriptionId: expect.any(String)});
        expect(subscriptionsOf(target)).toEqual([expect.objectContaining({id: response.subscriptionId, active: false, verified: false})]);
        expect(sentTo(target)).toMatchObject([{templateId: "otpVerification", alertId: INDEXER_ALERT}]);
        expect(addSubscription).not.toHaveBeenCalled();
    });
});

describe("log lines", () => {
    test("say what happened and never carry the target, the code, the token or its hash", async () => {
        mockLogLines.length = 0;
        const target = newTarget();
        const challengeId = await request(target);
        const code = codeFor(target);
        await statusOf(submitVerification(challengeId, wrongCode(code)));
        const {verificationToken} = await submitVerification(challengeId, code);
        await listAccounts(verificationToken);
        await registerWith(ACCOUNT_1, CHAIN_A, target, verificationToken);
        await subscribeWith(ACCOUNT_1, target, verificationToken);
        await statusOf(listAccounts(newVerificationToken()));

        expect(mockLogLines.map(({level, bindings, fields, message}) => ({level, ...bindings, ...fields, message}))).toEqual([
            {level: "info", component: "verification", challengeId, channel: "email", reused: false, message: "target verification requested"},
            {level: "info", component: "verification", challengeId, channel: "email", statusCode: 403, message: "target verification refused"},
            {level: "info", component: "verification", challengeId, channel: "email", message: "target verification completed"},
            {level: "info", component: "auth", verificationId: challengeId, channel: "email", accountCount: 0, message: "account lookup completed"},
            {
                level: "info", component: "auth", registrationId: expect.any(String), account: ACCOUNT_1, chainId: CHAIN_A, channel: "email",
                verification: "token", verificationId: challengeId, accountDeployed: true, message: "auth registration created",
            },
            {
                level: "info", component: "alerts", subscriptionId: expect.any(String), account: ACCOUNT_1, chainId: CHAIN_A, channel: "email",
                accountDeployed: true, active: true, verification: "token", verificationId: challengeId, message: "alert subscription created",
            },
            {level: "info", component: "verification", use: "lookup", reason: "unknown", verificationId: undefined, statusCode: 403, message: "verification token refused"},
        ]);
        const text = JSON.stringify(mockLogLines);
        for (const secret of [target, code, verificationToken, hashVerificationToken(verificationToken)]) {
            expect(text).not.toContain(secret);
        }
    });
});
