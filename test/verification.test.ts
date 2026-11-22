import supertest from "supertest";
import {ethers} from "ethers";
import {SiweMessage} from "siwe";
import {randomBytes} from "node:crypto";
import type {Express} from "express";
import type {PrismaClient} from "@prisma/client";

// POST /v1/auth/verification/request and /submit, the verifiedTargetToken on POST /v1/auth/accounts and
// /v1/auth/register, and the account metadata, on the real app, against Postgres and Mailpit (./test.sh). config.json
// is replaced by the config below (two enabled networks and a disabled one, email through Mailpit) and the boot step
// that assigns legacy rows never resolves, so the app never listens and no chain is called: the signed requests are
// signed by a random wallet (ECDSA). Registrations for the lookup are also written straight to the database.
// test/verification-rules.test.ts covers the same rules without Docker; subscribing with a token needs a chain and is
// in test/alerts.test.ts.

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
const listAccounts = (verifiedTargetToken: unknown) => supertest(app).post("/v1/auth/accounts").send({verifiedTargetToken});
const newChallenge = async (target: string): Promise<string> => {
    const response = await requestVerification(target).expect(200);
    expect(Object.keys(response.body)).toEqual(["challengeId"]);
    return response.body.challengeId;
};
// A token for the target, with the code of its `count`th message.
const verify = async (target: string, count = 1): Promise<string> => {
    const challengeId = await newChallenge(target);
    const response = await submitVerification(challengeId, await latestCode(target, count)).expect(200);
    return response.body.verifiedTargetToken;
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
const REFUSED = "Invalid or expired verifiedTargetToken";
const MALFORMED = `"verifiedTargetToken" must be a valid token`;

// A request signed by the account itself (a random wallet: ECDSA, no chain call), with the statement of its endpoint.
const signedBody = async (wallet: ethers.Wallet, chainId: number, statement: string) => {
    const message = new SiweMessage({
        domain: "example.com",
        address: wallet.address,
        statement,
        uri: "https://example.com",
        chainId,
        version: "1",
        nonce: Math.random().toString(36).substring(2),
        issuedAt: new Date().toISOString(),
    }).prepareMessage();
    return {account: wallet.address, chainId, message, signature: await wallet.signMessage(message)};
};
// POST /v1/auth/register
const registerBody = async (wallet: ethers.Wallet, chainId: number, target: string) => {
    const statement = `I authorize Safe Recovery Service to sign a recovery request for my account after I authenticate using ${target} (via email)`;
    const {account, message, signature} = await signedBody(wallet, chainId, statement);
    return {account, chainId, channel: "email", target, message, signature};
};
const register = (body: object) => supertest(app).post("/v1/auth/register").send(body);
const FETCH_STATEMENT = "I request to retrieve all authentication methods currently registered to my account with Safe Recovery Service";
const DELETE_STATEMENT = "I request to remove the authentication method with registration ID {{id}} from my account on Safe Recovery Service";
const fetchRegistrations = (query: object) => supertest(app).get("/v1/auth/registrations").query(query);
const deleteBody = async (wallet: ethers.Wallet, chainId: number, registrationId: string) => {
    const {message, signature} = await signedBody(wallet, chainId, DELETE_STATEMENT.replace("{{id}}", registrationId));
    return {registrationId, message, signature};
};
const deleteRegistration = (body: object) => supertest(app).post("/v1/auth/delete").send(body);
// An entry of the lookup.
const entry = (account: string, chainId: number, metadata: Record<string, string> = {}) => ({account, chainId, registeredAt: expect.any(String), metadata});

describe("verification", () => {
    it("should send a code to any target and return a short-lived token for it", async () => {
        const target = newTarget();
        const challengeId = await newChallenge(target);
        expect(challengeId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
        const code = await latestCode(target);

        const before = Date.now();
        const response = await submitVerification(challengeId, code).expect(200);
        expect(response.headers["cache-control"]).toBe("no-store");
        expect(Object.keys(response.body)).toEqual(["verifiedTargetToken", "verifiedTargetTokenExpiresAt"]);
        expect(response.body.verifiedTargetToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
        const expiresAt = Date.parse(response.body.verifiedTargetTokenExpiresAt);
        expect(expiresAt).toBeGreaterThan(before + 9 * 60 * 1000);
        expect(expiresAt).toBeLessThanOrEqual(Date.now() + 10 * 60 * 1000);

        const row = await prisma.targetVerification.findUniqueOrThrow({where: {id: challengeId}});
        expect(row).toMatchObject({channel: "email", target, verified: true, tries: 0});
        expect(row.tokenHash).toMatch(/^[0-9a-f]{64}$/);
        expect(Object.values(row)).not.toContain(response.body.verifiedTargetToken);
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

describe("account lookup with a verified-target token", () => {
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
                entry(first.toLowerCase(), CHAIN_A),
                entry(first.toLowerCase(), CHAIN_B),
                entry(second.toLowerCase(), CHAIN_A),
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

describe("register with a verified-target token", () => {
    it("should register the target on two chains with one token, sending no further code", async () => {
        const target = newTarget();
        const token = await verify(target);
        const wallet = ethers.Wallet.createRandom();

        for (const chainId of [CHAIN_A, CHAIN_B]) {
            const response = await register({...await registerBody(wallet, chainId, target), verifiedTargetToken: token}).expect(200);
            expect(Object.keys(response.body)).toEqual(["registrationId", "guardianAddress"]);
            expect(response.body.guardianAddress.toLowerCase()).toBe(mockGuardian.address.toLowerCase());
        }
        await expectNoMessages(target, 1);
        expect(await prisma.authRegistrationRequest.count({where: {target}})).toBe(0);
        await listAccounts(token).expect(200).then((response) => {
            expect(response.body).toEqual({
                accounts: [
                    entry(wallet.address.toLowerCase(), CHAIN_A),
                    entry(wallet.address.toLowerCase(), CHAIN_B),
                ],
            });
        });
        // the same registration again
        await register({...await registerBody(wallet, CHAIN_A, target), verifiedTargetToken: token}).expect(409);
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
        await register({...body, verifiedTargetToken: otherToken}).expect(403).then((response) => {
            expect(response.body.message).toBe(REFUSED);
        });
        await register(body).expect(200).then((response) => {
            expect(Object.keys(response.body)).toEqual(["challengeId"]);
        });
        await latestCode(target, 1, REGISTRATION_SUBJECT);

        const expiredBody = await registerBody(wallet, CHAIN_B, expiredTarget);
        await register({...expiredBody, verifiedTargetToken: expiredToken}).expect(403).then((response) => {
            expect(response.body.message).toBe(REFUSED);
        });
        await register(expiredBody).expect(200);

        const malformedBody = await registerBody(wallet, CHAIN_A, newTarget());
        await register({...malformedBody, verifiedTargetToken: "not a token"}).expect(400).then((response) => {
            expect(response.body.message).toBe(MALFORMED);
        });
    });
});

describe("account metadata", () => {
    const metadataRow = (wallet: ethers.Wallet, chainId: number) =>
        prisma.authAccountMetadata.findUnique({where: {account_chainId: {account: wallet.address.toLowerCase(), chainId}}});
    const METADATA_STATEMENT = "I request to update the metadata stored for my account with Safe Recovery Service";
    const setMetadata = (body: object) => supertest(app).post("/v1/auth/metadata").send(body);

    it("should store the metadata sent with a token, per chain, and return it with an ISO registeredAt", async () => {
        const target = newTarget();
        const token = await verify(target);
        const wallet = ethers.Wallet.createRandom();
        await register({...await registerBody(wallet, CHAIN_A, target), verifiedTargetToken: token, metadata: {label: "On A"}}).expect(200);
        await register({...await registerBody(wallet, CHAIN_B, target), verifiedTargetToken: token, metadata: {label: "On B", "app:id": "42"}}).expect(200);

        const response = await listAccounts(token).expect(200);
        expect(response.body).toEqual({
            accounts: [
                entry(wallet.address.toLowerCase(), CHAIN_A, {label: "On A"}),
                entry(wallet.address.toLowerCase(), CHAIN_B, {label: "On B", "app:id": "42"}),
            ],
        });
        for (const {registeredAt} of response.body.accounts) {
            expect(new Date(registeredAt).toISOString()).toBe(registeredAt);
        }
        expect((await metadataRow(wallet, CHAIN_A))?.metadata).toEqual({label: "On A"});
    });

    it("should keep the metadata sent with a code on the request until /submit, then store it", async () => {
        const target = newTarget();
        const wallet = ethers.Wallet.createRandom();
        const response = await register({...await registerBody(wallet, CHAIN_A, target), metadata: {label: "Savings"}}).expect(200);
        const {challengeId} = response.body;
        expect((await prisma.authRegistrationRequest.findUniqueOrThrow({where: {id: challengeId}})).metadata).toEqual({label: "Savings"});
        expect(await metadataRow(wallet, CHAIN_A)).toBeNull();

        const code = await latestCode(target, 1, REGISTRATION_SUBJECT);
        const submitted = await supertest(app).post("/v1/auth/submit").send({challengeId, challenge: code}).expect(200);
        expect((await prisma.authRegistrationRequest.findUniqueOrThrow({where: {id: challengeId}})).metadata).toBeNull();
        // the same code again answers with the same registration, and creates no other
        const again = await supertest(app).post("/v1/auth/submit").send({challengeId, challenge: code}).expect(200);
        expect(again.body).toEqual(submitted.body);
        expect(await prisma.authRegistration.count({where: {target}})).toBe(1);
        await listAccounts(await verify(target, 2)).expect(200).then((lookup) => {
            expect(lookup.body).toEqual({accounts: [entry(wallet.address.toLowerCase(), CHAIN_A, {label: "Savings"})]});
        });
    });

    it("should return the metadata with the registrations", async () => {
        const target = newTarget();
        const token = await verify(target);
        const wallet = ethers.Wallet.createRandom();
        const {body} = await register({...await registerBody(wallet, CHAIN_A, target), verifiedTargetToken: token, metadata: {label: "Savings"}}).expect(200);

        await fetchRegistrations(await signedBody(wallet, CHAIN_A, FETCH_STATEMENT)).expect(200).then((response) => {
            expect(response.body).toEqual({registrations: [{id: body.registrationId, channel: "email", target}], metadata: {label: "Savings"}});
        });
        await fetchRegistrations(await signedBody(wallet, CHAIN_B, FETCH_STATEMENT)).expect(200).then((response) => {
            expect(response.body).toEqual({registrations: [], metadata: {}});
        });
    });

    it("should delete the metadata with the last registration on the chain", async () => {
        const [first, second] = [newTarget(), newTarget()];
        const wallet = ethers.Wallet.createRandom();
        const firstResponse = await register({...await registerBody(wallet, CHAIN_A, first), verifiedTargetToken: await verify(first), metadata: {label: "Savings"}}).expect(200);
        const secondResponse = await register({...await registerBody(wallet, CHAIN_A, second), verifiedTargetToken: await verify(second)}).expect(200);

        await deleteRegistration(await deleteBody(wallet, CHAIN_A, firstResponse.body.registrationId)).expect(200);
        expect((await metadataRow(wallet, CHAIN_A))?.metadata).toEqual({label: "Savings"});
        await deleteRegistration(await deleteBody(wallet, CHAIN_A, secondResponse.body.registrationId)).expect(200);
        expect(await metadataRow(wallet, CHAIN_A)).toBeNull();
    });

    it("should return non-Latin text and emoji sequences unchanged", async () => {
        const target = newTarget();
        const token = await verify(target);
        const wallet = ethers.Wallet.createRandom();
        // built from code points: CJK, Cyrillic, an emoji ZWJ sequence and a flag
        const metadata = {
            label: String.fromCodePoint(0x50a8, 0x84c4, 0x8d26, 0x6237),
            other: String.fromCodePoint(0x0421, 0x0431, 0x0435, 0x0440),
            emoji: String.fromCodePoint(0x1f469, 0x200d, 0x1f4bb, 0x20, 0x1f1ef, 0x1f1f5),
        };
        await register({...await registerBody(wallet, CHAIN_A, target), verifiedTargetToken: token, metadata}).expect(200);
        await listAccounts(token).expect(200).then((response) => {
            expect(response.body.accounts).toEqual([entry(wallet.address.toLowerCase(), CHAIN_A, metadata)]);
        });
    });

    it("should replace and clear the metadata at POST /v1/auth/metadata, signed by the account", async () => {
        const target = newTarget();
        const token = await verify(target);
        const wallet = ethers.Wallet.createRandom();
        await register({...await registerBody(wallet, CHAIN_A, target), verifiedTargetToken: token, metadata: {label: "Savings", "app:id": "1"}}).expect(200);

        await setMetadata({...await signedBody(wallet, CHAIN_A, METADATA_STATEMENT), metadata: {label: "Spending"}}).expect(200).then((response) => {
            expect(response.body).toEqual({metadata: {label: "Spending"}});
        });
        await listAccounts(token).expect(200).then((response) => {
            expect(response.body).toEqual({accounts: [entry(wallet.address.toLowerCase(), CHAIN_A, {label: "Spending"})]});
        });

        await setMetadata({...await signedBody(wallet, CHAIN_A, METADATA_STATEMENT), metadata: {}}).expect(200).then((response) => {
            expect(response.body).toEqual({metadata: {}});
        });
        expect(await metadataRow(wallet, CHAIN_A)).toBeNull();
        await listAccounts(token).expect(200).then((response) => {
            expect(response.body).toEqual({accounts: [entry(wallet.address.toLowerCase(), CHAIN_A)]});
        });
    });

    it("should keep the service's reserved keys when the app writes its metadata", async () => {
        const target = newTarget();
        const token = await verify(target);
        const wallet = ethers.Wallet.createRandom();
        const account = wallet.address.toLowerCase();
        await register({...await registerBody(wallet, CHAIN_A, target), verifiedTargetToken: token, metadata: {label: "Savings"}}).expect(200);
        // a key the service stored
        await prisma.authAccountMetadata.update({
            where: {account_chainId: {account, chainId: CHAIN_A}},
            data: {metadata: {label: "Savings", _service: "s"}},
        });

        await setMetadata({...await signedBody(wallet, CHAIN_A, METADATA_STATEMENT), metadata: {label: "Spending"}}).expect(200).then((response) => {
            expect(response.body).toEqual({metadata: {_service: "s", label: "Spending"}});
        });
        await setMetadata({...await signedBody(wallet, CHAIN_A, METADATA_STATEMENT), metadata: {}}).expect(200).then((response) => {
            expect(response.body).toEqual({metadata: {_service: "s"}});
        });
        expect((await metadataRow(wallet, CHAIN_A))?.metadata).toEqual({_service: "s"});
        await listAccounts(token).expect(200).then((response) => {
            expect(response.body).toEqual({accounts: [entry(account, CHAIN_A, {_service: "s"})]});
        });
    });

    it("should refuse POST /v1/auth/metadata without a registration (404), invalid metadata (400) and another key's signature (403)", async () => {
        const wallet = ethers.Wallet.createRandom();
        await setMetadata({...await signedBody(wallet, CHAIN_A, METADATA_STATEMENT), metadata: {label: "x"}}).expect(404).then((response) => {
            expect(response.body.message).toBe("No registrations found for this account on this chainId");
        });

        const target = newTarget();
        await register({...await registerBody(wallet, CHAIN_A, target), verifiedTargetToken: await verify(target)}).expect(200);
        await setMetadata({...await signedBody(wallet, CHAIN_A, METADATA_STATEMENT), metadata: {label: "x".repeat(257)}}).expect(400).then((response) => {
            expect(response.body.message).toBe(`"metadata" values must be at most 256 characters long`);
        });
        await setMetadata(await signedBody(wallet, CHAIN_A, METADATA_STATEMENT)).expect(400).then((response) => {
            expect(response.body.message).toBe(`"metadata" is required`);
        });

        // a message for the account, signed by another key
        const forged = await signedBody(wallet, CHAIN_A, METADATA_STATEMENT);
        forged.signature = await ethers.Wallet.createRandom().signMessage(forged.message);
        await setMetadata({...forged, metadata: {label: "x"}}).expect(403);
        expect(await metadataRow(wallet, CHAIN_A)).toBeNull();
    });

    it("should refuse invalid metadata on register with a message that quotes nothing", async () => {
        const target = newTarget();
        const wallet = ethers.Wallet.createRandom();
        await register({...await registerBody(wallet, CHAIN_A, target), metadata: {"Secret Key": "Secret-Value"}}).expect(400).then((response) => {
            expect(response.body.message).toBe(`"metadata" keys must be 1 to 32 characters of letters, digits, underscore, dot, colon or hyphen, and start with a letter or a digit`);
        });
        // a key reserved for the service
        await register({...await registerBody(wallet, CHAIN_A, target), metadata: {"_Secret-Key": "Secret-Value"}}).expect(400).then((response) => {
            expect(response.body.message).toBe(`"metadata" keys starting with an underscore are reserved`);
        });
        expect(await prisma.authRegistrationRequest.count({where: {target}})).toBe(0);
    });
});
