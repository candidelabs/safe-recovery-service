import supertest from 'supertest';
import {app} from '../src/index';
import {SiweMessage} from "siwe";
import * as dotenv from 'dotenv'
import {ethers, hashMessage} from "ethers6";

jest.setTimeout(300000);
import {
    SafeAccountV0_3_0 as SafeAccount,
    CandidePaymaster,
    SocialRecoveryModule,
    SocialRecoveryModuleGracePeriodSelector
} from "abstractionkit";
import { JsonObject } from '@prisma/client/runtime/library';

//get values from .env
dotenv.config()
const chainId = BigInt(process.env.CHAIN_ID as string)
const bundlerUrl = process.env.BUNDLER_URL as string
const jsonRpcNodeProvider = process.env.JSON_RPC_NODE_PROVIDER as string
const paymasterRPC = process.env.PAYMASTER_RPC as string;
const sponsorshipPolicyId = process.env.SPONSORSHIP_POLICY_ID as string;


const owner = ethers.Wallet.createRandom();
const ownerPublicAddress = owner.address
const ownerPrivateKey = owner.privateKey

const secondOwner = ethers.Wallet.createRandom();
const secondOwnerPublicAddress = secondOwner.address
const secondOwnerPrivateKey = secondOwner.privateKey

let smartAccount = SafeAccount.initializeNewAccount(
    [ownerPublicAddress ,secondOwnerPublicAddress],
    {threshold:2}
)

const guardian = ethers.Wallet.createRandom();
const guardian2 = ethers.Wallet.createRandom();
const srm = new SocialRecoveryModule(
    SocialRecoveryModuleGracePeriodSelector.After3Minutes
);
let subscriptionId: string;

describe('alerts', ()=>{
    it('should return a 404 if wrong path', async ()=>{
        await supertest(app).get('/v1/alerts/wrong/').expect(404);
    });
    describe('alerts/subscribe', ()=>{
        it('should fail with 400 to register if wrong message format', async ()=>{
            await supertest(app).post('/v1/alerts/subscribe/')
            .send({
                "account": "0x0000000000000000000000000000000000000000",
                "owner": "0x0000000000000000000000000000000000000000",
                "chainId": 11155111,
                "channel":"email",
                "target":"user@example.com",
                "message":{
                  statement: "invalid format",
                },
                "signature": "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef"
            })
            .expect(400).then((response) => {
                expect(response.body.message).toContain(
                    "failed custom validation"
                )
            });
        });
        it('should fail with 400 to register if wrong message', async ()=>{
            await supertest(app).post('/v1/alerts/subscribe/')
            .send({
                "account": "0x0000000000000000000000000000000000000000",
                "owner": "0x0000000000000000000000000000000000000000",
                "chainId": 11155111,
                "channel":"email",
                "target":"user@example.com",
                "message":{
                  version: "1",
                  address: "0x0000000000000000000000000000000000000000",
                  domain: "service://safe-recovery-service",
                  uri: "service://safe-recovery-service",
                  //statement: "I request to retrieve all authentication methods currently registered to my account with Safe Recovery Service",
                  statement: "invalid message",
                  chainId: 11155111,
                  nonce: 0, 
                },
                "signature": "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef"
            })
            .expect(400).then((response) => {
                expect(response.body.message).toContain(
                    "invalid message"
                )
            });
        });
        it('should fail with 403 to register if invalid signature', async ()=>{
            await supertest(app).post('/v1/alerts/subscribe/')
            .send({
                "account": "0x0000000000000000000000000000000000000000",
                "owner": "0x0000000000000000000000000000000000000000",
                "chainId": 11155111,
                "channel":"email",
                "target":"user@example.com",
                "message":{
                  version: "1",
                  address: "0x0000000000000000000000000000000000000000",
                  domain: "service://safe-recovery-service",
                  uri: "service://safe-recovery-service",
                  statement: "I agree to receive Social Recovery Module alert notifications for my account address on all supported chains sent to user@example.com (via email)",
                  chainId: 11155111,
                  nonce: 0, 
                },
                "signature": "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef"
            })
            .expect(403).then((response) => {
                expect(response.body.message).toContain(
                    "invalid signature"
                )
            });
        });

        it('should succeed with 200 to register if valid owner signature', async ()=>{
            const chainId = 11155111;
            let userOperation = await smartAccount.createUserOperation(
                [
                    srm.createEnableModuleMetaTransaction(smartAccount.accountAddress),
                    srm.createAddGuardianWithThresholdMetaTransaction(
                       guardian.address, 1n
                   ),
                   srm.createAddGuardianWithThresholdMetaTransaction(
                       guardian2.address, 2n
                   )
                ],
                jsonRpcNodeProvider, //the node rpc is used to fetch the current nonce and fetch gas prices.
                bundlerUrl, //the bundler rpc is used to estimate the gas limits.
            )

            let paymaster: CandidePaymaster = new CandidePaymaster(
                paymasterRPC
            )

            let [paymasterUserOperation, _sponsorMetadata] = await paymaster.createSponsorPaymasterUserOperation(
                userOperation, bundlerUrl, sponsorshipPolicyId) // sponsorshipPolicyId will have no effect if empty
            userOperation = paymasterUserOperation; 

            userOperation.signature = smartAccount.signUserOperation(
                userOperation,
                [ownerPrivateKey, secondOwnerPrivateKey],
                BigInt(chainId),
            )

            const sendUserOperationResponse = await smartAccount.sendUserOperation(
                userOperation, bundlerUrl
            )

            console.log("Useroperation sent. Waiting to be included ......")
            let userOperationReceiptResult = await sendUserOperationResponse.included()

            // 2️⃣ Create a SIWE Message
            const domain = "example.com";
            const statement = "I agree to receive Social Recovery Module alert notifications for my account address on all supported chains sent to user@example.com (via email)";
            const uri = "https://example.com";
            const version = "1";
            const nonce = Math.random().toString(36).substring(2); // Generate a random nonce
            const issuedAt = new Date().toISOString();

            const siweMessage = new SiweMessage({
                domain,
                address: ownerPublicAddress,
                statement,
                uri,
                chainId,
                version, //optional
                nonce, //optional
                issuedAt, //optional
            });
            const message = siweMessage.prepareMessage();
            const signature = await owner.signMessage(message);
            const challengeIdRes = await supertest(app).post('/v1/alerts/subscribe/')
            .send({
                "account": smartAccount.accountAddress,
                "owner": ownerPublicAddress,
                "chainId": chainId,
                "channel":"email",
                "target":"user@example.com",
                "message":siweMessage,
                "signature": signature
            })
            .expect(200);
            subscriptionId = challengeIdRes.body.subscriptionId;
        });
    });

    describe('alerts/activate', ()=>{
        it('should fail with 404 to register if wrong id', async ()=>{
            await supertest(app).post('/v1/alerts/activate/')
            .send({
                "subscriptionId": "wrongid",
                "challenge": "wrongchallenge",
            })
            .expect(404).then((response) => {
                expect(response.body.message).toContain(
                    "Alert subscription not found"
                )
            });
        });
        it('should fail with 403 to register if challenge is wrong', async ()=>{
            await supertest(app).post('/v1/alerts/activate/')
            .send({
                "subscriptionId": subscriptionId,
                "challenge": "wrongchallenge",
            })
            .expect(403).then((response) => {
                expect(response.body.message).toContain(
                    "Invalid challenge"
                )
            });
        });

        it('should succeed with 200 to if correct subscriptionId and challenge', async ()=>{
            const fetchResponse = await fetch('http://localhost:8025/api/v1/messages')
            const responseJson = await fetchResponse.json() as JsonObject;
            const emails = responseJson['messages'] as JsonObject[];
            const lastEmail = emails[0] as JsonObject;
            const regex = /-?\d{6}/gm;
            const otpRes = regex.exec(lastEmail['Snippet'] as string)
            if(otpRes == null){
               return 
            }
            const otp = otpRes[0]

            await supertest(app).post('/v1/alerts/activate/')
            .send({
                "subscriptionId": subscriptionId,
                "challenge": otp,
            })
            .expect(200);
        });
    });

    describe('alerts/subscriptions', ()=>{
        it('should fail with 400 to register if wrong message format', async ()=>{
            await supertest(app).get('/v1/alerts/subscriptions/')
            .query({
                "account": "0x0000000000000000000000000000000000000000",
                "owner": "0x0000000000000000000000000000000000000000",
                "chainId": 11155111,
                "message":{
                  statement: "invalid format",
                },
                "signature": "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef"
            })
            .expect(400).then((response) => {
                expect(response.body.message).toContain(
                    "failed custom validation"
                )
            });
        });
        it('should fail with 400 to register if wrong message', async ()=>{
            await supertest(app).get('/v1/alerts/subscriptions/')
            .query({
                "account": "0x0000000000000000000000000000000000000000",
                "owner": "0x0000000000000000000000000000000000000000",
                "chainId": 11155111,
                "message":{
                  version: "1",
                  address: "0x0000000000000000000000000000000000000000",
                  domain: "service://safe-recovery-service",
                  uri: "service://safe-recovery-service",
                  //statement: "I request to retrieve all authentication methods currently registered to my account with Safe Recovery Service",
                  statement: "invalid message",
                  chainId: 11155111,
                  nonce: 0, 
                },
                "signature": "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef"
            })
            .expect(400).then((response) => {
                expect(response.body.message).toContain(
                    "message"
                )
            });
        });
        it('should fail with 403 to register if invalid signature', async ()=>{
            await supertest(app).get('/v1/alerts/subscriptions/')
            .query({
                account: "0x0000000000000000000000000000000000000000",
                owner: "0x0000000000000000000000000000000000000000",
                chainId: 11155111,
                message:{
                  version: "1",
                  address: "0x0000000000000000000000000000000000000000",
                  domain: "service://safe-recovery-service",
                  uri: "service://safe-recovery-service",
                  statement: "I request to retrieve all Social Recovery Module alert subscriptions linked to my account",
                  chainId: 11155111,
                },
                signature: "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef"
            })
            .expect(403).then((response) => {
                expect(response.body.message).toContain(
                    "invalid signature"
                )
            });
        });

        it('should succeed with 200 to if correct signature', async ()=>{
            const domain = "example.com";
            const statement = "I request to retrieve all Social Recovery Module alert subscriptions linked to my account";
            const uri = "https://example.com";
            const version = "1";
            const nonce = Math.random().toString(36).substring(2); // Generate a random nonce
            const issuedAt = new Date().toISOString();

            const siweMessage = new SiweMessage({
                domain,
                address: ownerPublicAddress,
                statement,
                uri,
                chainId: Number(chainId),
                version, //optional
                nonce, //optional
                issuedAt, //optional
            });

            const message = siweMessage.prepareMessage();
            const signature = await owner.signMessage(message);

            const subscriptionsRes = await supertest(app).get('/v1/alerts/subscriptions/')
            .query({
                account: smartAccount.accountAddress,
                owner: ownerPublicAddress,
                chainId: 11155111,
                message:siweMessage,
                signature
            })
            .expect(200);
            const subscriptions = subscriptionsRes.body.subscriptions;
            expect(subscriptions.length).toBe(1);
            expect(subscriptions[0].channel).toBe("email");
            expect(subscriptions[0].target).toBe("user@example.com");
        });
    });
    describe('alerts/unsubscribe', ()=>{
        it('should fail with 403 to if wrong owner signature', async ()=>{
            const domain = "example.com";
            const statement = "I request to unsubscribe all Social Recovery Module alert subscriptions linked to my account";
            const uri = "https://example.com";
            const version = "1";
            const nonce = Math.random().toString(36).substring(2); // Generate a random nonce
            const issuedAt = new Date().toISOString();

            const siweMessage = new SiweMessage({
                domain,
                address: ownerPublicAddress,
                statement,
                uri,
                chainId: Number(chainId),
                version, //optional
                nonce, //optional
                issuedAt, //optional
            });

            const message = siweMessage.prepareMessage();
            const signature = await secondOwner.signMessage(message);

            const res = await supertest(app).post('/v1/alerts/unsubscribe/')
            .send({
                subscriptionId,
                chainId: 11155111,
                owner: ownerPublicAddress,
                message:siweMessage,
                signature
            })
            .expect(403).then((response) => {
                expect(response.body.message).toContain(
                    "invalid signature"
                )
            });
        });

        it('should succeed with 200 to if correct owner signature', async ()=>{
            const domain = "example.com";
            const statement = "I request to unsubscribe all Social Recovery Module alert subscriptions linked to my account";
            const uri = "https://example.com";
            const version = "1";
            const nonce = Math.random().toString(36).substring(2); // Generate a random nonce
            const issuedAt = new Date().toISOString();

            const unsubscripeSiweMessage = new SiweMessage({
                domain,
                address: ownerPublicAddress,
                statement,
                uri,
                chainId: Number(chainId),
                version, //optional
                nonce, //optional
                issuedAt, //optional
            });

            let message = unsubscripeSiweMessage.prepareMessage();
            let signature = await owner.signMessage(message);

            const res = await supertest(app).post('/v1/alerts/unsubscribe/')
            .send({
                subscriptionId,
                chainId: 11155111,
                owner: ownerPublicAddress,
                message:unsubscripeSiweMessage,
                signature
            })
            .expect(200);
            expect(res.body.success).toBe(true);

            const fetchSubscriptionsSiweMessage = new SiweMessage({
                domain,
                address: ownerPublicAddress,
                statement: "I request to retrieve all Social Recovery Module alert subscriptions linked to my account",
                uri,
                chainId: Number(chainId),
                version, //optional
                nonce, //optional
                issuedAt, //optional
            });
            message = fetchSubscriptionsSiweMessage.prepareMessage();
            signature = await owner.signMessage(message);

            const subscriptionsRes = await supertest(app).get('/v1/alerts/subscriptions/')
            .query({
                account: smartAccount.accountAddress,
                owner: ownerPublicAddress,
                chainId: 11155111,
                message:fetchSubscriptionsSiweMessage,
                signature
            })
            .expect(200);
            const subscriptions = subscriptionsRes.body.subscriptions;
            expect(subscriptions.length).toBe(0); //no subscriptions
        });
    });
});
