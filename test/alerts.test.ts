import supertest from 'supertest';
import {app} from '../src/index';
import {SiweMessage} from "siwe";
import * as dotenv from 'dotenv'
import {ethers} from "ethers";

import {
    SafeAccountV0_3_0 as SafeAccount,
    CandidePaymaster,
    SocialRecoveryModule,
    SocialRecoveryModuleGracePeriodSelector
} from "abstractionkit";
import { JsonObject } from '@prisma/client/runtime/library';

jest.setTimeout(1000000);

//get values from .env
dotenv.config()
const chainId_1 = BigInt(process.env.CHAIN_ID_1 as string)
const chainId_2 = BigInt(process.env.CHAIN_ID_2 as string)
const bundlerUrl_1 = process.env.BUNDLER_URL_1 as string
const bundlerUrl_2 = process.env.BUNDLER_URL_2 as string
const jsonRpcNodeProvider_1 = process.env.JSON_RPC_NODE_PROVIDER_1 as string
const jsonRpcNodeProvider_2 = process.env.JSON_RPC_NODE_PROVIDER_2 as string
const paymasterRPC_1 = process.env.PAYMASTER_RPC_1 as string;
const paymasterRPC_2 = process.env.PAYMASTER_RPC_2 as string;


const owner = ethers.Wallet.createRandom();
const ownerPublicAddress = owner.address
const ownerPrivateKey = owner.privateKey

const secondOwner = ethers.Wallet.createRandom();
const secondOwnerPublicAddress = secondOwner.address
const secondOwnerPrivateKey = secondOwner.privateKey

const newOwner = ethers.Wallet.createRandom();
const newOwnerPublicAddress = newOwner.address
const newOwnerPrivateKey = newOwner.privateKey

let smartAccount = SafeAccount.initializeNewAccount(
    [ownerPublicAddress ,secondOwnerPublicAddress],
    {threshold:2}
)

const guardian = ethers.Wallet.createRandom();
const guardian2 = ethers.Wallet.createRandom();
const srm = new SocialRecoveryModule(
    SocialRecoveryModuleGracePeriodSelector.After3Minutes
);
let subscriptionId: string | null = null;
let index = 0;
let hasUnsubscribed = false;

const params :[bigint, string, string, string][] = [
    [chainId_1, bundlerUrl_1, jsonRpcNodeProvider_1, paymasterRPC_1],
    [chainId_2, bundlerUrl_2, jsonRpcNodeProvider_2, paymasterRPC_2],
];
describe('alerts', ()=>{
    it.concurrent.each(params)('should return a 404 if wrong path' + ' for chainid: %d', async (chainId, bundlerUrl, jsonRpcNodeProvider, paymasterRPC) => {
        await supertest(app).get('/v1/alerts/wrong/').expect(404);
    });

    describe('alerts', ()=>{
        it.concurrent.each(params)(
            'chainid: %d',
            async (chainId, bundlerUrl, jsonRpcNodeProvider, paymasterRPC) => 
        {
            console.log('alerts/subscribe should fail with 400 to register if wrong message format')
            await supertest(app).post('/v1/alerts/subscribe/')
            .send({
                "account": "0x0000000000000000000000000000000000000000",
                "owner": "0x0000000000000000000000000000000000000000",
                "chainId": Number(chainId),
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
            console.log('alerts/subscribe should fail should 400 to register if wrong message format')
            await supertest(app).post('/v1/alerts/subscribe/')
            .send({
                "account": "0x0000000000000000000000000000000000000000",
                "owner": "0x0000000000000000000000000000000000000000",
                "chainId": Number(chainId),
                "channel":"email",
                "target":"user@example.com",
                "message":{
                  version: "1",
                  address: "0x0000000000000000000000000000000000000000",
                  domain: "service://safe-recovery-service",
                  uri: "service://safe-recovery-service",
                  //statement: "I request to retrieve all authentication methods currently registered to my account with Safe Recovery Service",
                  statement: "invalid message",
                  chainId: Number(chainId),
                  nonce: 0, 
                },
                "signature": "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef"
            })
            .expect(400).then((response) => {
                expect(response.body.message).toContain(
                    "invalid message"
                )
            });

            console.log('should fail with 403 to register if invalid signature')
            await supertest(app).post('/v1/alerts/subscribe/')
            .send({
                "account": smartAccount.accountAddress,
                "owner": ownerPublicAddress,
                "chainId": Number(chainId),
                "channel":"email",
                "target":"user@example.com",
                "message":{
                  version: "1",
                  address: ownerPublicAddress,
                  domain: "service://safe-recovery-service",
                  uri: "service://safe-recovery-service",
                  statement: "I agree to receive Social Recovery Module alert notifications for " + smartAccount.accountAddress.toLowerCase() + " on all supported chains sent to user@example.com (via email)",
                  chainId: Number(chainId),
                  nonce: 0, 
                },
                "signature": "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef"
            })
            .expect(403).then((response) => {
                expect(response.body.message).toContain(
                    "invalid signature"
                )
            });

            console.log('alerts/subscribe should succeed with 200 to register if valid owner signature')
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
                userOperation, bundlerUrl) // sponsorshipPolicyId will have no effect if empty
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
            let domain = "example.com";
            let statement = "I agree to receive Social Recovery Module alert notifications for " + smartAccount.accountAddress.toLowerCase() + " on all supported chains sent to user@example.com (via email)";
            let uri = "https://example.com";
            let version = "1";
            let nonce = Math.random().toString(36).substring(2); // Generate a random nonce
            let issuedAt = new Date().toISOString();

            let siweMessage = new SiweMessage({
                domain,
                address: ownerPublicAddress,
                statement,
                uri,
                chainId: Number(chainId),
                version, //optional
                nonce, //optional
                issuedAt, //optional
            });
            let message = siweMessage.prepareMessage();
            let signature = await owner.signMessage(message);
            if(subscriptionId == null){
                subscriptionId = "";
                const challengeIdRes = await supertest(app).post('/v1/alerts/subscribe/')
                .send({
                    "account": smartAccount.accountAddress,
                    "owner": ownerPublicAddress,
                    "chainId": Number(chainId),
                    "channel":"email",
                    "target":"user@example.com",
                    "message":siweMessage,
                    "signature": signature
                })
                .expect(200);
                subscriptionId = challengeIdRes.body.subscriptionId;
            }
            
            console.log('alerts/activate should fail with 404 to register if wrong id')
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


            if(index == 0){
                console.log('alerts/activate should fail with 403 to register if challenge is wrong')
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

                console.log('alerts/activate should succeed with 200 to if correct subscriptionId and challenge')
                const fetchResponse = await fetch('http://localhost:8025/api/v1/messages')
                const responseJson = await fetchResponse.json() as JsonObject;
                const emails = responseJson['messages'] as JsonObject[];
                const lastEmail = emails[index++] as JsonObject;
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
            }
            else{
                await supertest(app).post('/v1/alerts/activate/')
                .send({
                    "subscriptionId": subscriptionId,
                    "challenge": "wrongchallenge",
                })
                .expect(400).then((response) => {
                    expect(response.body.message).toContain(
                        "Alert subscription already active"
                    )
                });
            }

            console.log('alerts/execute should receive an email if a guardian initiated a recovery')
            const recoveryHash = await srm.getRecoveryHash(
                jsonRpcNodeProvider,
                smartAccount.accountAddress,
                [newOwnerPublicAddress], 
                1,
                0n
            ) 
            const guardian1Signature = ethers.utils.joinSignature(
                guardian._signingKey().signDigest(recoveryHash)
            );
            const guardian2Signature = ethers.utils.joinSignature(
                guardian2._signingKey().signDigest(recoveryHash)
            );
            await new Promise(resolve => setTimeout(resolve, 4*1000)); //2 minute

            const res = await supertest(app).post('/v1/recoveries/create/')
            .send({
                "account": smartAccount.accountAddress,
                "newOwners": [newOwnerPublicAddress],
                "newThreshold": 1,
                "chainId": Number(chainId),
                "signer": guardian.address,
                "signature": guardian1Signature 
            })
            .expect(200);

            await supertest(app).post('/v1/recoveries/sign')
            .send({
                'id': res.body.id,
                'signer': guardian2.address,
                'signature': guardian2Signature
            }).expect(200);

            await supertest(app).post('/v1/recoveries/execute')
            .send({
                'id': res.body.id,
            }).expect(200);

            console.log("start waiting for recovery email");
            await new Promise(resolve => setTimeout(resolve, 4*60*1000)); //4 minute
            console.log("stop waiting for recovery email");

            const fetchResponse = await fetch('http://localhost:8025/api/v1/messages')
            const responseJson = await fetchResponse.json() as JsonObject;
            const emails = responseJson['messages'] as JsonObject[];
            const lastEmail = emails[0] as JsonObject;
            const emailId = lastEmail['ID'] as string;
            const fetchHtmlResponse = await fetch(`http://localhost:8025/view/${emailId}.html`)
            const htmlContent = await fetchHtmlResponse.text()
            expect(lastEmail["Subject"]).toContain("Security: Changes have been made to your social recovery setting")
            expect(htmlContent).toContain("RECOVERY EXECUTED")

            console.log("start waiting for recovery grace period");
            await new Promise(resolve => setTimeout(resolve, 3*60*1000)); //3 minutes
            console.log("stop waiting for recovery grace period");

            await supertest(app).post('/v1/recoveries/finalize')
            .send({
                'id': res.body.id,
            }).expect(200);

            console.log("start waiting for executing the finalization transaction");
            await new Promise(resolve => setTimeout(resolve, 3*60*1000)); //3 minute
            console.log("stop waiting for executing the finalization transaction");

            const finalizeFetchResponse = await fetch('http://localhost:8025/api/v1/messages')
            const finalizeResponseJson = await finalizeFetchResponse.json() as JsonObject;
            const finalizeEmails = finalizeResponseJson['messages'] as JsonObject[];
            const finalizelastEmail = finalizeEmails[0] as JsonObject;
            const finalizeEmailId = finalizelastEmail['ID'] as string;
            const finalizeFetchHtmlResponse = await fetch(`http://localhost:8025/view/${finalizeEmailId}.html`)
            const finalizehtmlContent = await finalizeFetchHtmlResponse.text()
            expect(finalizelastEmail["Subject"]).toContain("Security: Changes have been made to your social recovery setting")
            expect(finalizehtmlContent).toContain("RECOVERY FINALIZED")

            console.log('alerts/subscriptions should fail with 400 to register if wrong message')
            await supertest(app).get('/v1/alerts/subscriptions/')
            .query({
                "account": "0x0000000000000000000000000000000000000000",
                "owner": "0x0000000000000000000000000000000000000000",
                "chainId": Number(chainId),
                "message":{
                  version: "1",
                  address: "0x0000000000000000000000000000000000000000",
                  domain: "service://safe-recovery-service",
                  uri: "service://safe-recovery-service",
                  //statement: "I request to retrieve all authentication methods currently registered to my account with Safe Recovery Service",
                  statement: "invalid message",
                  chainId: Number(chainId),
                  nonce: 0, 
                },
                "signature": "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef"
            })
            .expect(400).then((response) => {
                expect(response.body.message).toContain(
                    "message"
                )
            });

            console.log('alerts/subscriptions should fail with 403 to register if invalid signature')
            await supertest(app).get('/v1/alerts/subscriptions/')
            .query({
                account: "0x0000000000000000000000000000000000000000",
                owner: "0x0000000000000000000000000000000000000000",
                chainId: Number(chainId),
                message:{
                  version: "1",
                  address: "0x0000000000000000000000000000000000000000",
                  domain: "service://safe-recovery-service",
                  uri: "service://safe-recovery-service",
                  statement: "I request to retrieve all Social Recovery Module alert subscriptions linked to my account",
                  chainId: Number(chainId),
                },
                signature: "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef"
            })
            .expect(403).then((response) => {
                expect(response.body.message).toContain(
                    "invalid signature"
                )
            });

        console.log('alerts/subscriptions should succeed with 200 to if correct signature')
            if(!hasUnsubscribed){
                domain = "example.com";
                statement = "I request to retrieve all Social Recovery Module alert subscriptions linked to my account";
                uri = "https://example.com";
                version = "1";
                nonce = Math.random().toString(36).substring(2); // Generate a random nonce
                issuedAt = new Date().toISOString();

                siweMessage = new SiweMessage({
                    domain,
                    address: ownerPublicAddress,
                    statement,
                    uri,
                    chainId: Number(chainId),
                    version, //optional
                    nonce, //optional
                    issuedAt, //optional
                });

                message = siweMessage.prepareMessage();
                signature = await owner.signMessage(message);

                const subscriptionsRes = await supertest(app).get('/v1/alerts/subscriptions/')
                .query({
                    account: smartAccount.accountAddress,
                    owner: ownerPublicAddress,
                    chainId: Number(chainId),
                    message:siweMessage,
                    signature
                })
                .expect(200);
                const subscriptions = subscriptionsRes.body.subscriptions;
                //expect(subscriptions.length).toBe(1);
                expect(subscriptions[0].channel).toBe("email");
                expect(subscriptions[0].target).toBe("user@example.com");

                console.log('alerts/unsubscribe should fail with 403 to if wrong owner signature')
                hasUnsubscribed = true;
                domain = "example.com";
                statement = "I request to unsubscribe from all Social Recovery Module alert subscriptions linked to my account";
                uri = "https://example.com";
                version = "1";
                nonce = Math.random().toString(36).substring(2); // Generate a random nonce
                issuedAt = new Date().toISOString();

                siweMessage = new SiweMessage({
                    domain,
                    address: ownerPublicAddress,
                    statement,
                    uri,
                    chainId: Number(chainId),
                    version, //optional
                    nonce, //optional
                    issuedAt, //optional
                });

                message = siweMessage.prepareMessage();
                signature = await secondOwner.signMessage(message);

                await supertest(app).post('/v1/alerts/unsubscribe/')
                .send({
                    subscriptionId,
                    chainId: Number(chainId),
                    owner: ownerPublicAddress,
                    message:siweMessage,
                    signature
                })
                .expect(403).then((response) => {
                    expect(response.body.message).toContain(
                        "invalid signature"
                    )
                });

                console.log('alerts/unsubscribe should succeed with 200 to if correct owner signature')
                domain = "example.com";
                statement = "I request to unsubscribe from all Social Recovery Module alert subscriptions linked to my account";
                uri = "https://example.com";
                version = "1";
                nonce = Math.random().toString(36).substring(2); // Generate a random nonce
                issuedAt = new Date().toISOString();

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

                message = unsubscripeSiweMessage.prepareMessage();
                signature = await owner.signMessage(message);

                const res2 = await supertest(app).post('/v1/alerts/unsubscribe/')
                .send({
                    subscriptionId,
                    chainId: Number(chainId),
                    owner: ownerPublicAddress,
                    message:unsubscripeSiweMessage,
                    signature
                })
                .expect(200);
                expect(res2.body.success).toBe(true);

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

                const subscriptionsRes2 = await supertest(app).get('/v1/alerts/subscriptions/')
                .query({
                    account: smartAccount.accountAddress,
                    owner: ownerPublicAddress,
                    chainId: Number(chainId),
                    message:fetchSubscriptionsSiweMessage,
                    signature
                })
                .expect(200);
                const subscriptions2 = subscriptionsRes2.body.subscriptions;
                expect(subscriptions2.length).toBe(0); //no subscriptions
            }
        });
    });
});
