import supertest from "supertest";
import {ethers} from "ethers";
import type {Express} from "express";
import type {PrismaClient} from "@prisma/client";

// POST /v1/auth/accounts/request and /v1/auth/accounts/submit on the real app, against Postgres and Mailpit
// (./test.sh). config.json is replaced by the config below (two enabled networks and a disabled one, email through
// Mailpit) and the boot step that assigns legacy rows never resolves, so the app never listens and no chain is
// called. Registrations are written straight to the database. test/account-lookup-rules.test.ts covers the same
// rules without Docker.

jest.setTimeout(120000);

const CHAIN_A = 11155111;
const CHAIN_B = 11155420;
const CHAIN_DISABLED = 84532;
const V0_1_0_3_MINUTES = "0x949d01d424bE050D09C16025dd007CB59b3A8c66";

const lookupNetwork = (chainId: number, enabled: boolean) => ({
    enabled,
    chainId,
    jsonRpcEndpoint: "http://127.0.0.1:1",
    recoveryModules: [{address: V0_1_0_3_MINUTES, fallback: true, indexer: {enabled: false, startBlock: 0}}],
    guardian: "signer",
    alerts: "alert",
});
const mockRawConfig = {
    options: {env: "development", port: 4337, indexerAlert: "alert", trustProxy: true, rateLimit: 100000},
    signers: [{id: "signer", privateKey: ethers.Wallet.createRandom().privateKey}],
    alerts: [{
        id: "alert",
        channels: {
            email: {
                smtp: {
                    from: "Safe Recovery <recovery@example.com>",
                    host: "localhost",
                    port: 1025,
                    secure: false,
                    auth: {type: "login", user: "test", pass: "test"},
                },
            },
        },
    }],
    networks: {
        sepolia: lookupNetwork(CHAIN_A, true),
        "optimism-sepolia": lookupNetwork(CHAIN_B, true),
        "base-sepolia": lookupNetwork(CHAIN_DISABLED, false),
    },
};
jest.mock("../src/utils/file", () => ({readFile: () => mockRawConfig}));
jest.mock("../src/services/recovery-modules.service", () => ({
    ...jest.requireActual("../src/services/recovery-modules.service"),
    assignLegacyRequestRows: () => new Promise(() => {}),
}));

let app: Express;
let prisma: PrismaClient;
beforeAll(() => {
    app = require("../src/index").app;
    prisma = require("../src/config/prisma-client").prisma;
});

const MAILPIT = "http://localhost:8025/api/v1";
type MailpitMessage = {ID: string, To: {Address: string}[], Subject: string, Snippet: string};
const messagesTo = async (address: string): Promise<MailpitMessage[]> => {
    const response = await fetch(`${MAILPIT}/messages?limit=1000`);
    const {messages} = await response.json() as {messages: MailpitMessage[]};
    return messages.filter((message) => message.To.some((to) => to.Address === address));
};
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
// Codes are sent without being awaited: wait until `count` messages reached the address (newest first).
const waitForMessages = async (address: string, count: number): Promise<MailpitMessage[]> => {
    const deadline = Date.now() + 15000;
    for (;;) {
        const messages = await messagesTo(address);
        if (messages.length >= count) return messages;
        if (Date.now() > deadline) throw new Error(`expected ${count} messages to ${address}, got ${messages.length}`);
        await sleep(250);
    }
};
const latestCode = async (address: string, count = 1): Promise<string> => {
    const [message] = await waitForMessages(address, count);
    expect(message.Subject).toBe("Your Safe account lookup code");
    const code = /\b\d{6}\b/.exec(message.Snippet);
    expect(code).not.toBeNull();
    return code![0];
};
// Long enough for a message sent without being awaited to reach Mailpit.
const expectNoMessages = async (address: string, count = 0) => {
    await sleep(2000);
    expect(await messagesTo(address)).toHaveLength(count);
};

const newTarget = () => `lookup-${ethers.utils.hexlify(ethers.utils.randomBytes(6)).slice(2)}@example.com`;
const newAccount = () => ethers.Wallet.createRandom().address;
const register = (target: string, account: string, chainId: number) => prisma.authRegistration.create({
    data: {account, chainId, channel: "email", target, guardian: "0x0000000000000000000000000000000000000001"},
});
const requestLookup = (target: string, channel = "email") => supertest(app).post("/v1/auth/accounts/request").send({channel, target});
const submitLookup = (challengeId: string, challenge: string) => supertest(app).post("/v1/auth/accounts/submit").send({challengeId, challenge});
const newChallenge = async (target: string): Promise<string> => {
    const response = await requestLookup(target).expect(200);
    expect(Object.keys(response.body)).toEqual(["challengeId"]);
    return response.body.challengeId;
};
const backdate = (challengeId: string, ms: number) => prisma.authAccountLookupRequest.update({
    where: {id: challengeId},
    data: {createdAt: new Date(Date.now() - ms)},
});
const wrongCode = (code: string) => code === "000000" ? "111111" : "000000";
const COOLDOWN_MS = 61 * 1000;

describe("account lookup", () => {
    it("should list every account registered with the target, across chains", async () => {
        const target = newTarget();
        const [first, second] = [newAccount(), newAccount()].sort((a, b) => a.toLowerCase() < b.toLowerCase() ? -1 : 1);
        await register(target, first, CHAIN_B);
        await register(target, first.toLowerCase(), CHAIN_A);
        await register(target, first, CHAIN_A);
        await register(target, second, CHAIN_A);
        await register(newTarget(), newAccount(), CHAIN_A);

        const challengeId = await newChallenge(target);
        const response = await submitLookup(challengeId, await latestCode(target)).expect(200);
        expect(response.body).toEqual({
            accounts: [
                {account: first.toLowerCase(), chainId: CHAIN_A},
                {account: first.toLowerCase(), chainId: CHAIN_B},
                {account: second.toLowerCase(), chainId: CHAIN_A},
            ],
        });
    });

    it("should normalize the target (case and whitespace)", async () => {
        const target = newTarget();
        const account = newAccount();
        await register(target, account, CHAIN_A);
        const challengeId = await newChallenge(`  ${target.toUpperCase()}  `);
        const response = await submitLookup(challengeId, await latestCode(target)).expect(200);
        expect(response.body).toEqual({accounts: [{account: account.toLowerCase(), chainId: CHAIN_A}]});
    });

    it("should answer an unknown target the same way and send nothing", async () => {
        const target = newTarget();
        const challengeId = await newChallenge(target);
        expect(challengeId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
        await expectNoMessages(target);
    });

    it("should fail with 403 on a wrong code and count the try", async () => {
        const target = newTarget();
        await register(target, newAccount(), CHAIN_A);
        const challengeId = await newChallenge(target);
        const code = await latestCode(target);
        await submitLookup(challengeId, wrongCode(code)).expect(403).then((response) => {
            expect(response.body.message).toContain("Invalid challenge");
        });
        expect((await prisma.authAccountLookupRequest.findUnique({where: {id: challengeId}}))?.tries).toBe(1);
        await submitLookup(challengeId, code).expect(200);
    });

    it("should lock a challenge after 5 wrong codes", async () => {
        const target = newTarget();
        await register(target, newAccount(), CHAIN_A);
        const challengeId = await newChallenge(target);
        const code = await latestCode(target);
        for (let i = 0; i < 5; i++) {
            await submitLookup(challengeId, wrongCode(code)).expect(403);
        }
        await submitLookup(challengeId, code).expect(403).then((response) => {
            expect(response.body.message).toContain("Too many invalid challenges");
        });
        expect(await prisma.authAccountLookupRequest.findUnique({where: {id: challengeId}})).toMatchObject({tries: 5, verified: false});
    });

    it("should fail with 403 on an expired code", async () => {
        const target = newTarget();
        await register(target, newAccount(), CHAIN_A);
        const challengeId = await newChallenge(target);
        const code = await latestCode(target);
        await prisma.authAccountLookupRequest.update({where: {id: challengeId}, data: {expiresAt: new Date(Date.now() - 1000)}});
        await submitLookup(challengeId, code).expect(403).then((response) => {
            expect(response.body.message).toContain("expired");
        });
    });

    it("should fail with 400 on a challenge submitted again after success, and 404 on an unknown one", async () => {
        const target = newTarget();
        await register(target, newAccount(), CHAIN_A);
        const challengeId = await newChallenge(target);
        const code = await latestCode(target);
        await submitLookup(challengeId, code).expect(200);
        await submitLookup(challengeId, code).expect(400).then((response) => {
            expect(response.body.message).toContain("already verified");
        });
        await submitLookup("00000000-0000-0000-0000-000000000000", code).expect(404);
    });

    it("should fail with 400 on a channel no network offers", async () => {
        await requestLookup("+15550100000", "sms").expect(400).then((response) => {
            expect(response.body.message).toContain("not supported");
        });
        await requestLookup(newTarget(), "push").expect(400);
    });

    it("should fail with 403 on an invalid target", async () => {
        await requestLookup("not-an-email").expect(403).then((response) => {
            expect(response.body.message).toContain("not compatible");
        });
    });

    it("should leave out registrations on a disabled or unknown chain", async () => {
        const target = newTarget();
        const account = newAccount();
        await register(target, account, CHAIN_A);
        await register(target, newAccount(), CHAIN_DISABLED);
        await register(target, newAccount(), 1);
        const challengeId = await newChallenge(target);
        const response = await submitLookup(challengeId, await latestCode(target)).expect(200);
        expect(response.body).toEqual({accounts: [{account: account.toLowerCase(), chainId: CHAIN_A}]});

        const disabledOnly = newTarget();
        await register(disabledOnly, newAccount(), CHAIN_DISABLED);
        await newChallenge(disabledOnly);
        await expectNoMessages(disabledOnly);
    });

    it("should leave out a deleted registration", async () => {
        const target = newTarget();
        const account = newAccount();
        await register(target, account, CHAIN_A);
        const deleted = await register(target, newAccount(), CHAIN_B);
        await prisma.authRegistration.delete({where: {id: deleted.id}});
        const challengeId = await newChallenge(target);
        const response = await submitLookup(challengeId, await latestCode(target)).expect(200);
        expect(response.body).toEqual({accounts: [{account: account.toLowerCase(), chainId: CHAIN_A}]});
    });

    it("should return the latest challenge and send no code within the cooldown", async () => {
        const target = newTarget();
        await register(target, newAccount(), CHAIN_A);
        const first = await newChallenge(target);
        expect(await newChallenge(target)).toBe(first);
        await latestCode(target);
        await expectNoMessages(target, 1);

        await backdate(first, COOLDOWN_MS);
        const second = await newChallenge(target);
        expect(second).not.toBe(first);
        await submitLookup(second, await latestCode(target, 2)).expect(200);
    });

    it("should refuse every code for a target after 10 wrong codes within 24 hours", async () => {
        const target = newTarget();
        await register(target, newAccount(), CHAIN_A);
        const fail = async (challengeId: string, code: string, times: number) => {
            for (let i = 0; i < times; i++) await submitLookup(challengeId, wrongCode(code)).expect(403);
        };
        const first = await newChallenge(target);
        await fail(first, await latestCode(target, 1), 5);
        await backdate(first, COOLDOWN_MS);
        const second = await newChallenge(target);
        await fail(second, await latestCode(target, 2), 5);
        await backdate(second, COOLDOWN_MS);

        // no code is sent while the target is locked, and a right code is refused
        const third = await newChallenge(target);
        await expectNoMessages(target, 2);
        await submitLookup(third, "123456").expect(403).then((response) => {
            expect(response.body.message).toContain("for this target");
        });
    });
});
