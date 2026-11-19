import supertest from "supertest";
import {ethers} from "ethers";
import {SiweMessage} from "siwe";
import {randomBytes} from "node:crypto";
import type {Express} from "express";
import type {PrismaClient} from "@prisma/client";

// POST /v1/auth/verification/request and /submit, and the verificationToken on POST /v1/auth/accounts and
// /v1/auth/register, on the real app, against Postgres and Mailpit (./test.sh). config.json is replaced by the config
// below (two enabled networks and a disabled one, email through Mailpit) and the boot step that assigns legacy rows
// never resolves, so the app never listens and no chain is called: register is signed by a random wallet (ECDSA).
// Registrations for the lookup are also written straight to the database. test/verification-rules.test.ts covers the
// same rules without Docker.

jest.setTimeout(180000);

const CHAIN_A = 11155111;
const CHAIN_B = 11155420;
const CHAIN_DISABLED = 84532;
const V0_1_0_3_MINUTES = "0x949d01d424bE050D09C16025dd007CB59b3A8c66";

const verificationNetwork = (chainId: number, enabled: boolean) => ({
    enabled,
    chainId,
    jsonRpcEndpoint: "http://127.0.0.1:1",
    recoveryModules: [{address: V0_1_0_3_MINUTES, fallback: true, indexer: {enabled: false, startBlock: 0}}],
    guardian: "signer",
    alerts: "alert",
});
const mockGuardian = ethers.Wallet.createRandom();
const mockRawConfig = {
    options: {env: "development", port: 4337, indexerAlert: "alert", trustProxy: true, rateLimit: 100000},
    signers: [{id: "signer", privateKey: mockGuardian.privateKey}],
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
        sepolia: verificationNetwork(CHAIN_A, true),
        "optimism-sepolia": verificationNetwork(CHAIN_B, true),
        "base-sepolia": verificationNetwork(CHAIN_DISABLED, false),
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

const VERIFICATION_SUBJECT = "Your Safe Recovery verification code";
const REGISTRATION_SUBJECT = "OTP Verification for Safe Recovery";
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
const latestCode = async (address: string, count = 1, subject = VERIFICATION_SUBJECT): Promise<string> => {
    const [message] = await waitForMessages(address, count);
    expect(message.Subject).toBe(subject);
    const code = /\b\d{6}\b/.exec(message.Snippet);
    expect(code).not.toBeNull();
    return code![0];
};
// Long enough for a message sent without being awaited to reach Mailpit.
const expectNoMessages = async (address: string, count = 0) => {
    await sleep(2000);
    expect(await messagesTo(address)).toHaveLength(count);
};

const newTarget = () => `verify-${ethers.utils.hexlify(ethers.utils.randomBytes(6)).slice(2)}@example.com`;
const newAccount = () => ethers.Wallet.createRandom().address;
const storeRegistration = (target: string, account: string, chainId: number) => prisma.authRegistration.create({
    data: {account, chainId, channel: "email", target, guardian: "0x0000000000000000000000000000000000000001"},
});
const requestVerification = (target: string, channel = "email") => supertest(app).post("/v1/auth/verification/request").send({channel, target});
const submitVerification = (challengeId: string, challenge: string) => supertest(app).post("/v1/auth/verification/submit").send({challengeId, challenge});
const listAccounts = (verificationToken: unknown) => supertest(app).post("/v1/auth/accounts").send({verificationToken});
const newChallenge = async (target: string): Promise<string> => {
    const response = await requestVerification(target).expect(200);
    expect(Object.keys(response.body)).toEqual(["challengeId"]);
    return response.body.challengeId;
};
// A token for the target, with the code of its `count`th message.
const verify = async (target: string, count = 1): Promise<string> => {
    const challengeId = await newChallenge(target);
    const response = await submitVerification(challengeId, await latestCode(target, count)).expect(200);
    return response.body.verificationToken;
};
const backdate = async (challengeId: string, ms: number) => {
    const row = await prisma.targetVerification.findUniqueOrThrow({where: {id: challengeId}});
    await prisma.targetVerification.update({where: {id: challengeId}, data: {createdAt: new Date(row.createdAt.getTime() - ms)}});
};
// Ages every challenge of a target, so the latest stays the latest.
const ageAll = async (target: string, ms: number) => {
    for (const {id} of await prisma.targetVerification.findMany({where: {target}, select: {id: true}})) await backdate(id, ms);
};
const wrongCode = (code: string) => code === "000000" ? "111111" : "000000";
const COOLDOWN_MS = 61 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const REFUSED = "Invalid or expired verificationToken";
const MALFORMED = `"verificationToken" must be a valid verification token`;

// POST /v1/auth/register, signed by the account itself (a random wallet: ECDSA, no chain call).
const registerBody = async (wallet: ethers.Wallet, chainId: number, target: string) => {
    const message = new SiweMessage({
        domain: "example.com",
        address: wallet.address,
        statement: `I authorize Safe Recovery Service to sign a recovery request for my account after I authenticate using ${target} (via email)`,
        uri: "https://example.com",
        chainId,
        version: "1",
        nonce: Math.random().toString(36).substring(2),
        issuedAt: new Date().toISOString(),
    }).prepareMessage();
    return {account: wallet.address, chainId, channel: "email", target, message, signature: await wallet.signMessage(message)};
};
const register = (body: object) => supertest(app).post("/v1/auth/register").send(body);

describe("verification", () => {
    it("should send a code to any target and return a short-lived token for it", async () => {
        const target = newTarget();
        const challengeId = await newChallenge(target);
        expect(challengeId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
        const code = await latestCode(target);

        const before = Date.now();
        const response = await submitVerification(challengeId, code).expect(200);
        expect(response.headers["cache-control"]).toBe("no-store");
        expect(Object.keys(response.body)).toEqual(["verificationToken", "verificationTokenExpiresAt"]);
        expect(response.body.verificationToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
        const expiresAt = Date.parse(response.body.verificationTokenExpiresAt);
        expect(expiresAt).toBeGreaterThan(before + 9 * 60 * 1000);
        expect(expiresAt).toBeLessThanOrEqual(Date.now() + 10 * 60 * 1000);

        const row = await prisma.targetVerification.findUniqueOrThrow({where: {id: challengeId}});
        expect(row).toMatchObject({channel: "email", target, verified: true, tries: 0});
        expect(row.tokenHash).toMatch(/^[0-9a-f]{64}$/);
        expect(Object.values(row)).not.toContain(response.body.verificationToken);
    });

    it("should normalize the target (case and whitespace)", async () => {
        const target = newTarget();
        const challengeId = await newChallenge(`  ${target.toUpperCase()}  `);
        await submitVerification(challengeId, await latestCode(target)).expect(200);
        expect((await prisma.targetVerification.findUniqueOrThrow({where: {id: challengeId}})).target).toBe(target);
    });

    it("should fail with 403 on a wrong code and count the try", async () => {
        const target = newTarget();
        const challengeId = await newChallenge(target);
        const code = await latestCode(target);
        await submitVerification(challengeId, wrongCode(code)).expect(403).then((response) => {
            expect(response.body.message).toContain("Invalid challenge");
        });
        expect((await prisma.targetVerification.findUniqueOrThrow({where: {id: challengeId}})).tries).toBe(1);
        await submitVerification(challengeId, code).expect(200);
    });

    it("should lock a challenge after 5 wrong codes", async () => {
        const target = newTarget();
        const challengeId = await newChallenge(target);
        const code = await latestCode(target);
        for (let i = 0; i < 5; i++) {
            await submitVerification(challengeId, wrongCode(code)).expect(403);
        }
        await submitVerification(challengeId, code).expect(403).then((response) => {
            expect(response.body.message).toContain("Too many invalid challenges");
        });
        expect(await prisma.targetVerification.findUniqueOrThrow({where: {id: challengeId}})).toMatchObject({tries: 5, verified: false, tokenHash: null});
    });

    it("should fail with 403 on an expired code", async () => {
        const target = newTarget();
        const challengeId = await newChallenge(target);
        const code = await latestCode(target);
        await prisma.targetVerification.update({where: {id: challengeId}, data: {expiresAt: new Date(Date.now() - 1000)}});
        await submitVerification(challengeId, code).expect(403).then((response) => {
            expect(response.body.message).toContain("expired");
        });
    });

    it("should fail with 400 on a challenge submitted again after success, and 404 on an unknown one", async () => {
        const target = newTarget();
        const challengeId = await newChallenge(target);
        const code = await latestCode(target);
        await submitVerification(challengeId, code).expect(200);
        await submitVerification(challengeId, code).expect(400).then((response) => {
            expect(response.body.message).toContain("already verified");
        });
        await submitVerification("00000000-0000-0000-0000-000000000000", code).expect(404);
    });

    it("should fail with 400 on a channel no alert offers, and 403 on an invalid target", async () => {
        await requestVerification("+15550100000", "sms").expect(400).then((response) => {
            expect(response.body.message).toBe("Target channel 'sms' is not supported");
        });
        await requestVerification(newTarget(), "push").expect(400);
        await requestVerification("not-an-email").expect(403).then((response) => {
            expect(response.body.message).toContain("not compatible");
        });
    });

    it("should return the latest challenge and send no code within the cooldown", async () => {
        const target = newTarget();
        const first = await newChallenge(target);
        expect(await newChallenge(target)).toBe(first);
        await latestCode(target);
        await expectNoMessages(target, 1);

        await backdate(first, COOLDOWN_MS);
        const second = await newChallenge(target);
        expect(second).not.toBe(first);
        await submitVerification(second, await latestCode(target, 2)).expect(200);
    });

    it("should refuse every code for a target after 10 wrong codes within 24 hours, and send no more codes", async () => {
        const target = newTarget();
        const fail = async (challengeId: string, code: string, times: number) => {
            for (let i = 0; i < times; i++) await submitVerification(challengeId, wrongCode(code)).expect(403);
        };
        const first = await newChallenge(target);
        await fail(first, await latestCode(target, 1), 5);
        await ageAll(target, COOLDOWN_MS);
        const second = await newChallenge(target);
        await fail(second, await latestCode(target, 2), 4);
        await ageAll(target, COOLDOWN_MS);
        const third = await newChallenge(target);
        const thirdCode = await latestCode(target, 3);
        await fail(third, thirdCode, 1);

        await submitVerification(third, thirdCode).expect(403).then((response) => {
            expect(response.body.message).toContain("for this target");
        });
        // no new challenge and no code while the target is locked
        await ageAll(target, COOLDOWN_MS);
        expect(await newChallenge(target)).toBe(third);
        await expectNoMessages(target, 3);
        expect(await prisma.targetVerification.count({where: {target}})).toBe(3);
    });

    it("should send at most 10 codes to a target within 24 hours", async () => {
        const target = newTarget();
        const ids: string[] = [];
        for (let i = 0; i < 10; i++) {
            ids.push(await newChallenge(target));
            await ageAll(target, COOLDOWN_MS);
        }
        await waitForMessages(target, 10);

        expect(await newChallenge(target)).toBe(ids[9]);
        await expectNoMessages(target, 10);
        expect(await prisma.targetVerification.count({where: {target}})).toBe(10);

        // the oldest code leaves the window
        await backdate(ids[0], DAY_MS);
        const next = await newChallenge(target);
        expect(ids).not.toContain(next);
        await waitForMessages(target, 11);
    });
});

describe("account lookup with a verification token", () => {
    it("should list every account registered with the target, across chains, as often as asked", async () => {
        const target = newTarget();
        const [first, second] = [newAccount(), newAccount()].sort((a, b) => a.toLowerCase() < b.toLowerCase() ? -1 : 1);
        await storeRegistration(target, first, CHAIN_B);
        await storeRegistration(target, first.toLowerCase(), CHAIN_A);
        await storeRegistration(target, first, CHAIN_A);
        await storeRegistration(target, second, CHAIN_A);
        await storeRegistration(target, newAccount(), CHAIN_DISABLED);
        await storeRegistration(target, newAccount(), 1);
        await storeRegistration(newTarget(), newAccount(), CHAIN_A);

        const token = await verify(target);
        const expected = {
            accounts: [
                {account: first.toLowerCase(), chainId: CHAIN_A},
                {account: first.toLowerCase(), chainId: CHAIN_B},
                {account: second.toLowerCase(), chainId: CHAIN_A},
            ],
        };
        const response = await listAccounts(token).expect(200);
        expect(response.headers["cache-control"]).toBe("no-store");
        expect(response.body).toEqual(expected);
        await listAccounts(token).expect(200).then((again) => expect(again.body).toEqual(expected));
    });

    it("should list nothing for a target without registrations", async () => {
        await listAccounts(await verify(newTarget())).expect(200).then((response) => {
            expect(response.body).toEqual({accounts: []});
        });
    });

    it("should refuse an unknown or expired token with 403, and a malformed one with 400", async () => {
        await listAccounts(randomBytes(32).toString("base64url"))
            .expect(403).then((response) => expect(response.body.message).toBe(REFUSED));

        const target = newTarget();
        const token = await verify(target);
        await prisma.targetVerification.updateMany({where: {target}, data: {tokenExpiresAt: new Date(Date.now() - 1000)}});
        await listAccounts(token).expect(403).then((response) => expect(response.body.message).toBe(REFUSED));

        for (const malformed of [token.slice(1), `${token.slice(1)}=`, "", 12345]) {
            await listAccounts(malformed).expect(400).then((response) => {
                expect(response.body.message).toBe(MALFORMED);
            });
        }
        await supertest(app).post("/v1/auth/accounts").send({}).expect(400);
    });

    it("should not answer the removed two-step lookup", async () => {
        await supertest(app).post("/v1/auth/accounts/request").send({channel: "email", target: newTarget()}).expect(404);
        await supertest(app).post("/v1/auth/accounts/submit").send({challengeId: "x", challenge: "123456"}).expect(404);
    });
});

describe("register with a verification token", () => {
    it("should register the target on two chains with one token, sending no further code", async () => {
        const target = newTarget();
        const token = await verify(target);
        const wallet = ethers.Wallet.createRandom();

        for (const chainId of [CHAIN_A, CHAIN_B]) {
            const response = await register({...await registerBody(wallet, chainId, target), verificationToken: token}).expect(200);
            expect(Object.keys(response.body)).toEqual(["registrationId", "guardianAddress"]);
            expect(response.body.guardianAddress.toLowerCase()).toBe(mockGuardian.address.toLowerCase());
        }
        await expectNoMessages(target, 1);
        expect(await prisma.authRegistrationRequest.count({where: {target}})).toBe(0);
        await listAccounts(token).expect(200).then((response) => {
            expect(response.body).toEqual({
                accounts: [
                    {account: wallet.address.toLowerCase(), chainId: CHAIN_A},
                    {account: wallet.address.toLowerCase(), chainId: CHAIN_B},
                ],
            });
        });
        // the same registration again
        await register({...await registerBody(wallet, CHAIN_A, target), verificationToken: token}).expect(409);
    });

    it("should refuse a token before the SIWE check, so the same signed message works without it", async () => {
        const target = newTarget();
        const otherToken = await verify(newTarget());
        const expiredTarget = newTarget();
        const expiredToken = await verify(expiredTarget);
        await prisma.targetVerification.updateMany({where: {target: expiredTarget}, data: {tokenExpiresAt: new Date(Date.now() - 1000)}});
        const wallet = ethers.Wallet.createRandom();

        // another target's token, then the same message without a token: the nonce was not used up
        const body = await registerBody(wallet, CHAIN_A, target);
        await register({...body, verificationToken: otherToken}).expect(403).then((response) => {
            expect(response.body.message).toBe(REFUSED);
        });
        await register(body).expect(200).then((response) => {
            expect(Object.keys(response.body)).toEqual(["challengeId"]);
        });
        await latestCode(target, 1, REGISTRATION_SUBJECT);

        const expiredBody = await registerBody(wallet, CHAIN_B, expiredTarget);
        await register({...expiredBody, verificationToken: expiredToken}).expect(403).then((response) => {
            expect(response.body.message).toBe(REFUSED);
        });
        await register(expiredBody).expect(200);

        const malformedBody = await registerBody(wallet, CHAIN_A, newTarget());
        await register({...malformedBody, verificationToken: "not a token"}).expect(400).then((response) => {
            expect(response.body.message).toBe(MALFORMED);
        });
    });
});
