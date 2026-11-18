import {Network} from "../src/models/network";
import {Alerts} from "../src/models/alert/alerts";
import {AlertChannel} from "../src/models/alert/alert-channel";
import {EmailAlertChannel} from "../src/models/alert/email-alert-channel";
import {SMSAlertChannel} from "../src/models/alert/sms-alert-channel";
import {getTemplate} from "../src/models/alert/message-templates";
import {ApiError} from "../src/utils/error";
import {
    ACCOUNT_LOOKUP_COOLDOWN_MS,
    ACCOUNT_LOOKUP_TARGET_WINDOW_MS,
    ALREADY_VERIFIED,
    EXPIRED,
    TOO_MANY_TRIES,
    lookupAccounts,
    lookupChallengeSeed,
    refusedTry,
    selectLookupChannel,
    targetLocked,
    withinCooldown,
} from "../src/utils/account-lookup";
import {requestAccountLookup, submitAccountLookup} from "../src/services/auth.service";

// Account lookup (POST /v1/auth/accounts/request and /submit) without a database: the rules in
// src/utils/account-lookup.ts, the message templates, and the service against in-memory tables
// (test/account-lookup.test.ts runs the same flow on Postgres and Mailpit).

// In-memory tables for the queries the lookup makes (plain values, equals, in, gt/gte/lt; increment and
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
                return {_sum: {tries: found.length ? found.reduce((sum, row) => sum + row.tries, 0) : null}};
            },
            create: async ({data}: any) => {
                const row = {id: `lookup-${nextId++}`, verifiedAt: null, createdAt: new Date(), updatedAt: new Date(), ...data};
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

const CHAIN_A = 11155111;
const CHAIN_B = 11155420;
const CHAIN_DISABLED = 84532;

// Enabled networks in config order, without the constructor (which starts an indexer).
const addNetwork = (chainId: number, guardian: string | undefined, alert: string) => {
    Network.instances.add(Object.assign(Object.create(Network.prototype) as Network, {chainId, name: `chain-${chainId}`, guardian, alert}));
    Network.supportedChainIds.push(chainId);
};
// email is offered by alert-a (first network) and alert-b; sms by alert-b only; alert-c is on a network without a guardian
const webhook = {endpoint: "https://webhook.example.com/"};
const emailA = new EmailAlertChannel("alert-a", undefined, webhook);
const emailB = new EmailAlertChannel("alert-b", undefined, webhook);
const smsB = new SMSAlertChannel("alert-b", undefined, webhook);
const smsC = new SMSAlertChannel("alert-c", undefined, webhook);
const sent: {templateId: string, alertId: string, channel: string, target: string, otp: string}[] = [];
for (const channel of [emailA, emailB, smsB, smsC] as AlertChannel[]) {
    Alerts.instance().addAlertChannel(channel.alertId, channel);
    jest.spyOn(channel, "sendMessage").mockImplementation(async (templateId, target, overrides) => {
        sent.push({templateId, alertId: channel.alertId, channel: channel.channelName, target, otp: overrides!.otp});
        return true;
    });
}
addNetwork(100, undefined, "alert-c");
addNetwork(CHAIN_A, "signer", "alert-a");
addNetwork(CHAIN_B, "signer", "alert-b");

const lookups = () => mockTables.authAccountLookupRequest ?? [];
const lookupRow = (id: string) => lookups().find((row) => row.id === id);
const sentTo = (target: string) => sent.filter((message) => message.target === target);
// sendMessage runs after the response (setImmediate)
const flushSends = () => new Promise((resolve) => setImmediate(resolve));
const statusOf = async (promise: Promise<unknown>) => promise.then(() => undefined, (e: ApiError) => [e.statusCode, e.message]);
const register = (target: string, account: string, chainId: number, channel = "email") => {
    (mockTables.authRegistration ??= []).push({id: `registration-${account}-${chainId}-${(mockTables.authRegistration ?? []).length}`, account, chainId, channel, target, guardian: "0xguardian"});
};
let targets = 0;
const newTarget = () => `user${++targets}@example.com`;
const request = async (target: string, channel = "email") => {
    const challengeId = await requestAccountLookup(channel, target);
    await flushSends();
    return challengeId;
};
const codeFor = (target: string) => {
    const messages = sentTo(target);
    expect(messages.length).toBeGreaterThan(0);
    return messages[messages.length - 1].otp;
};
const wrongCode = (code: string) => code === "000000" ? "111111" : "000000";
const backdate = (id: string, ms: number) => {
    const row = lookupRow(id);
    row.createdAt = new Date(row.createdAt.getTime() - ms);
};

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

    test("a target is locked from 10 tries within the window", () => {
        expect(targetLocked(9)).toBe(false);
        expect(targetLocked(10)).toBe(true);
    });
});

describe("selectLookupChannel", () => {
    const channels: Record<string, string[]> = {a: ["email"], b: ["email", "sms"], c: ["sms", "email"]};
    const getChannel = (alertId: string, channel: string) => channels[alertId]?.includes(channel) ? `${alertId}:${channel}` : undefined;

    test("takes the first network in config order with a guardian whose alert offers the channel", () => {
        const networks = [{alert: "c"}, {guardian: "signer"}, {guardian: "signer", alert: "a"}, {guardian: "signer", alert: "b"}];
        expect(selectLookupChannel("email", networks, getChannel)).toEqual({alertId: "a", alertChannel: "a:email"});
        expect(selectLookupChannel("sms", networks, getChannel)).toEqual({alertId: "b", alertChannel: "b:sms"});
    });

    test("finds nothing when no network with a guardian offers the channel", () => {
        expect(selectLookupChannel("sms", [{alert: "c"}, {guardian: "signer", alert: "a"}], getChannel)).toBeUndefined();
        expect(selectLookupChannel("email", [], getChannel)).toBeUndefined();
    });
});

describe("lookup helpers", () => {
    test("the cooldown lasts 60 seconds", () => {
        const now = new Date("2026-11-18T12:00:00Z");
        expect(withinCooldown(new Date(now.getTime() - 59_999), now)).toBe(true);
        expect(withinCooldown(new Date(now.getTime() - 60_000), now)).toBe(false);
    });

    test("the code is seeded with the channel and the target", () => {
        expect(lookupChallengeSeed("email", "user@example.com")).toBe("email:user@example.com");
    });
});

describe("accountLookupOtp template", () => {
    const render = (body: string, otp: string) => body.replace(/{{otp}}/g, otp);

    test("the email shows the code and is not the registration message", () => {
        const email = getTemplate("email", "accountLookupOtp");
        const body = render(email.body, "123456");
        expect(body).toContain("Someone asked to list the Safe accounts registered with this address");
        expect(body).toContain("123456");
        expect(body).toContain("valid for 10 minutes");
        expect(body.match(/\d{6}/g)).toEqual(["123456"]);
        expect(email.subject).toBe("{{subject}}");
    });

    test("the SMS is plain ASCII and fits one GSM-7 segment", () => {
        const sms = render(getTemplate("sms", "accountLookupOtp").body, "123456");
        expect(sms).toBe("Someone asked to list the Safe accounts registered with this number. Your code is 123456. It is valid for 10 minutes. If this wasn't you, ignore this message.");
        expect(sms).toMatch(/^[\x20-\x7E]+$/);
        expect(sms.length).toBeLessThanOrEqual(160);
    });
});

describe("account lookup service (in-memory tables)", () => {
    test("sends a code and lists every registered account on the enabled chains", async () => {
        const target = newTarget();
        register(target, ACCOUNT_3, CHAIN_B);
        register(target, ACCOUNT_3.toLowerCase(), CHAIN_A);
        register(target, ACCOUNT_3, CHAIN_A);
        register(target, ACCOUNT_1, CHAIN_A);
        register(target, ACCOUNT_2, CHAIN_DISABLED);
        register(target, ACCOUNT_2, CHAIN_A, "sms");
        register("someone@example.com", ACCOUNT_2, CHAIN_A);

        const challengeId = await request(target);
        expect(sentTo(target)).toEqual([
            {templateId: "accountLookupOtp", alertId: "alert-a", channel: "email", target, otp: expect.stringMatching(/^\d{6}$/)},
        ]);
        expect(lookupRow(challengeId)).toMatchObject({channel: "email", target, alertId: "alert-a", verified: false, tries: 0});

        const accounts = await submitAccountLookup(challengeId, codeFor(target));
        expect(accounts).toEqual([
            {account: ACCOUNT_1, chainId: CHAIN_A},
            {account: ACCOUNT_3.toLowerCase(), chainId: CHAIN_A},
            {account: ACCOUNT_3.toLowerCase(), chainId: CHAIN_B},
        ]);
        expect(lookupRow(challengeId)).toMatchObject({verified: true, verifiedAt: expect.any(Date)});
    });

    test("normalizes the target as registration does", async () => {
        register("mixed.case@example.com", ACCOUNT_1, CHAIN_A);
        const challengeId = await request("  Mixed.Case@EXAMPLE.com ");
        expect(lookupRow(challengeId).target).toBe("mixed.case@example.com");
        expect(await submitAccountLookup(challengeId, codeFor("mixed.case@example.com"))).toEqual([{account: ACCOUNT_1, chainId: CHAIN_A}]);

        register("+15550100000", ACCOUNT_2, CHAIN_B, "sms");
        const smsChallengeId = await request("+1 (555) 010-0000", "sms");
        expect(lookupRow(smsChallengeId)).toMatchObject({target: "+15550100000", alertId: "alert-b"});
        expect(sentTo("+15550100000")).toHaveLength(1);
        expect(await submitAccountLookup(smsChallengeId, codeFor("+15550100000"))).toEqual([{account: ACCOUNT_2, chainId: CHAIN_B}]);
    });

    test("answers an unknown target the same way and sends nothing", async () => {
        const target = newTarget();
        const challengeId = await request(target);
        expect(typeof challengeId).toBe("string");
        expect(lookupRow(challengeId)).toMatchObject({channel: "email", target, verified: false, tries: 0});
        expect(sentTo(target)).toEqual([]);
    });

    test("sends nothing when the only registrations are on disabled chains", async () => {
        const target = newTarget();
        register(target, ACCOUNT_1, CHAIN_DISABLED);
        await request(target);
        expect(sentTo(target)).toEqual([]);
    });

    test("refuses a channel no guardian network offers and an invalid target", async () => {
        expect(await statusOf(requestAccountLookup("push", newTarget()))).toEqual([400, "Target channel 'push' is not supported"]);
        expect(await statusOf(requestAccountLookup("email", "not-an-email"))).toEqual([403, "Target is not compatible with the 'email' channel"]);
        expect(await statusOf(requestAccountLookup("sms", "0555 010 0000"))).toEqual([403, "Target is not compatible with the 'sms' channel"]);
    });

    test("counts a wrong code and locks the challenge after 5", async () => {
        const target = newTarget();
        register(target, ACCOUNT_1, CHAIN_A);
        const challengeId = await request(target);
        const code = codeFor(target);
        for (let tries = 1; tries <= 5; tries++) {
            expect(await statusOf(submitAccountLookup(challengeId, wrongCode(code)))).toEqual([403, "Invalid challenge"]);
            expect(lookupRow(challengeId).tries).toBe(tries);
        }
        expect(await statusOf(submitAccountLookup(challengeId, code))).toEqual([403, "Too many invalid challenges, request a new code"]);
        expect(lookupRow(challengeId)).toMatchObject({verified: false, tries: 5});
    });

    test("refuses an expired code", async () => {
        const target = newTarget();
        register(target, ACCOUNT_1, CHAIN_A);
        const challengeId = await request(target);
        lookupRow(challengeId).expiresAt = new Date(Date.now() - 1);
        expect(await statusOf(submitAccountLookup(challengeId, codeFor(target)))).toEqual([403, "challengeId has been expired"]);
    });

    test("refuses a challenge submitted again after success, and an unknown challenge", async () => {
        const target = newTarget();
        register(target, ACCOUNT_1, CHAIN_A);
        const challengeId = await request(target);
        await submitAccountLookup(challengeId, codeFor(target));
        expect(await statusOf(submitAccountLookup(challengeId, codeFor(target)))).toEqual([400, "challengeId already verified"]);
        expect(await statusOf(submitAccountLookup("no-such-challenge", "123456"))).toEqual([404, "challengeId not found"]);
    });

    test("returns the latest challenge within the cooldown and sends one code", async () => {
        const target = newTarget();
        register(target, ACCOUNT_1, CHAIN_A);
        const first = await request(target);
        expect(await request(target)).toBe(first);
        expect(await request(`  ${target.toUpperCase()}`)).toBe(first);
        expect(sentTo(target)).toHaveLength(1);

        backdate(first, ACCOUNT_LOOKUP_COOLDOWN_MS);
        const second = await request(target);
        expect(second).not.toBe(first);
        expect(sentTo(target)).toHaveLength(2);
        expect(await submitAccountLookup(second, codeFor(target))).toEqual([{account: ACCOUNT_1, chainId: CHAIN_A}]);
    });

    test("applies the cooldown to unknown targets too", async () => {
        const target = newTarget();
        const first = await request(target);
        expect(await request(target)).toBe(first);
        expect(lookups().filter((row) => row.target === target)).toHaveLength(1);
    });

    test("refuses every code for a target after 10 wrong codes within 24 hours, and sends no more codes", async () => {
        const target = newTarget();
        register(target, ACCOUNT_1, CHAIN_A);
        const fail = async (challengeId: string, times: number) => {
            for (let i = 0; i < times; i++) await statusOf(submitAccountLookup(challengeId, wrongCode(codeFor(target))));
        };
        const first = await request(target);
        await fail(first, 5);
        backdate(first, ACCOUNT_LOOKUP_COOLDOWN_MS);
        const second = await request(target);
        await fail(second, 4);
        backdate(second, ACCOUNT_LOOKUP_COOLDOWN_MS);
        const third = await request(target);
        expect(sentTo(target)).toHaveLength(3);
        const thirdCode = codeFor(target);
        await statusOf(submitAccountLookup(third, wrongCode(thirdCode)));

        expect(await statusOf(submitAccountLookup(third, thirdCode))).toEqual([403, "Too many invalid challenges for this target, try again later"]);
        backdate(third, ACCOUNT_LOOKUP_COOLDOWN_MS);
        await request(target);
        expect(sentTo(target)).toHaveLength(3);

        // the failures leave the window
        backdate(first, ACCOUNT_LOOKUP_TARGET_WINDOW_MS);
        backdate(second, ACCOUNT_LOOKUP_TARGET_WINDOW_MS);
        expect(await submitAccountLookup(third, thirdCode)).toEqual([{account: ACCOUNT_1, chainId: CHAIN_A}]);
    });

    test("checks at most 5 codes of a challenge when wrong codes arrive at once", async () => {
        const target = newTarget();
        register(target, ACCOUNT_1, CHAIN_A);
        const challengeId = await request(target);
        const wrong = wrongCode(codeFor(target));
        const results = await Promise.all(Array.from({length: 20}, () => statusOf(submitAccountLookup(challengeId, wrong))));
        expect(results.filter((result) => result?.[1] === "Invalid challenge")).toHaveLength(5);
        expect(results.filter((result) => result?.[1] === "Too many invalid challenges, request a new code")).toHaveLength(15);
        expect(lookupRow(challengeId).tries).toBe(5);
    });

    test("checks at most 10 codes of a target when submits arrive at once", async () => {
        const target = newTarget();
        register(target, ACCOUNT_1, CHAIN_A);
        const fail = async (challengeId: string, times: number) => {
            for (let i = 0; i < times; i++) await statusOf(submitAccountLookup(challengeId, wrongCode(codeFor(target))));
        };
        const first = await request(target);
        await fail(first, 5);
        backdate(first, ACCOUNT_LOOKUP_COOLDOWN_MS);
        const second = await request(target);
        await fail(second, 3);
        backdate(second, ACCOUNT_LOOKUP_COOLDOWN_MS);
        const third = await request(target);
        const wrong = wrongCode(codeFor(target));

        const results = await Promise.all(Array.from({length: 10}, () => statusOf(submitAccountLookup(third, wrong))));
        expect(results.every((result) => result?.[0] === 403)).toBe(true);
        expect(results.filter((result) => result?.[1] === "Invalid challenge").length).toBeLessThanOrEqual(2);
        const tries = lookups().filter((row) => row.target === target).reduce((sum, row) => sum + row.tries, 0);
        expect(tries).toBeLessThanOrEqual(10);
    });

    test("accepts a right code once when it arrives twice at once", async () => {
        const target = newTarget();
        register(target, ACCOUNT_1, CHAIN_A);
        const challengeId = await request(target);
        const code = codeFor(target);
        const results = await Promise.all([1, 2].map(() => submitAccountLookup(challengeId, code).then(
            (accounts) => accounts,
            (e: ApiError) => [e.statusCode, e.message],
        )));
        expect(results).toContainEqual([{account: ACCOUNT_1, chainId: CHAIN_A}]);
        expect(results).toContainEqual([400, "challengeId already verified"]);
        expect(lookupRow(challengeId)).toMatchObject({verified: true, tries: 0});
    });
});
