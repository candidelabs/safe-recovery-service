import supertest from 'supertest';
import {app} from '../src/index';
import * as dotenv from 'dotenv'
import * as ethers from 'ethers'
import {prisma} from "../src/config/prisma-client";

jest.setTimeout(300000);
import {
    SafeAccountV0_3_0 as SafeAccount,
    CandidePaymaster,
    SocialRecoveryModule,
    SocialRecoveryModuleGracePeriodSelector
} from "abstractionkit";

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
let smartAccount = SafeAccount.initializeNewAccount(
    [ownerPublicAddress],
)

const guardian = ethers.Wallet.createRandom();
const guardian2 = ethers.Wallet.createRandom();
const srm = new SocialRecoveryModule(
    SocialRecoveryModuleGracePeriodSelector.After3Minutes
);

const newOwners = [
    "0x41153290c995c8c4410d50f95D87ee86A1B07eeC".toLowerCase(),
    "0xB97A1C3993A551f0Febf030539630ACb77E6832D".toLowerCase()
];
let signedHash = "";
describe('recoveries', ()=>{
    it('should return a 404 if wrong path', async ()=>{
        await supertest(app).get('/v1/recoveries/wrong/').expect(404);
    });
    
    describe('create recovery', ()=>{
        it('should return a 400 if wrong chain id', async ()=>{
            await supertest(app).post('/v1/recoveries/create/')
            .send({
                "account": "0x0000000000000000000000000000000000000000",
                "newOwners": newOwners,
                "newThreshold": 2,
                "chainId": 1,
                "signer": "0x795B9cD1E5419C54B07768d4AD09809407dfAF5b",
                "signature": "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef"
            })
            .expect(400).then((response) => {
                expect(response.body.message).toContain(
                    "\"chainId\" must be"
                )
            });
        });

        it('should return a 400 if account is not a safe smart contract', async ()=>{
            await supertest(app).post('/v1/recoveries/create/')
            .send({
                "account": "0x0000000000000000000000000000000000000000",
                "newOwners": newOwners, 
                "newThreshold": 2,
                "chainId": 11155111,
                "signer": "0x795B9cD1E5419C54B07768d4AD09809407dfAF5b",
                "signature": "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef"
            })
            .expect(400).then((response) => {
                expect(response.body.message).toBe(
                    "Account address is not a safe smart contract account"
                )
            });

            await supertest(app).get(
                '/v1/recoveries/fetchByAddress/?' +
                'account=0xD422B9d638a7BA4eBeF9e33Af9456007eAB4ccba&' +
                'chainId=11155111&' +
                'nonce=0x0'
            )
            .expect(200);
        });
        
        it('should return a 400 if newThreshold is less than one', async ()=>{
            await supertest(app).post('/v1/recoveries/create/')
            .send({
                "account": "0x874B11D3A2E44C161F83eD2fb4bBA1fbE277446a",
                "newOwners": newOwners,
                "newThreshold": 0,
                "chainId": 11155111,
                "signer": "0x795B9cD1E5419C54B07768d4AD09809407dfAF5b",
                "signature": "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef"
            })
            .expect(400).then((response) => {
                expect(response.body.message).toBe(
                    "\"newThreshold\" must be greater than or equal to 1"
                )
            });
        });


        it('should return a 400 if newThreshold is more than number of new owners', 
           async ()=>{
            await supertest(app).post('/v1/recoveries/create/')
            .send({
                "account": "0x874B11D3A2E44C161F83eD2fb4bBA1fbE277446a",
                "newOwners": newOwners,
                "newThreshold": 3,
                "chainId": 11155111,
                "signer": "0x795B9cD1E5419C54B07768d4AD09809407dfAF5b",
                "signature": "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef"
            })
            .expect(400).then((response) => {
                expect(response.body.message).toBe(
                    "\"newThreshold\" must be less than or equal to ref:newOwners.length"
                )
            });
        });
        
        it('should return a 400 if newOwners is empty', async ()=>{
            await supertest(app).post('/v1/recoveries/create/')
            .send({
                "account": "0x874B11D3A2E44C161F83eD2fb4bBA1fbE277446a",
                "newOwners": [],
                "newThreshold": 2,
                "chainId": 11155111,
                "signer": "0x795B9cD1E5419C54B07768d4AD09809407dfAF5b",
                "signature": "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef"
            })
            .expect(400).then((response) => {
                expect(response.body.message).toContain(
                    "\"newOwners\" does not contain 1 required value(s)"
                )
            });
        });


        it('should return a 400 if signer is not a guardian', async ()=>{
            await supertest(app).post('/v1/recoveries/create/')
            .send({
                "account": "0x874B11D3A2E44C161F83eD2fb4bBA1fbE277446a",
                "newOwners": newOwners,
                "newThreshold": 2,
                "chainId": 11155111,
                "signer": "0x795B9cD1E5419C54B07768d4AD09809407dfAF5b",
                "signature": "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef"
            })
            .expect(400).then((response) => {
                expect(response.body.message).toBe(
                    "Signer not a guardian"
                )
            });
        });
        
        it('should return a 400 if invalid signer signature', async ()=>{
            await supertest(app).post('/v1/recoveries/create/')
            .send({
                "account": "0xdc6f8499d102100cafa6a6cf2e7af31fb5b14871",
                "newOwners": newOwners,
                "newThreshold": 2,
                "chainId": 11155111,
                "signer": "0xa71c4260f2a157408ef997b9f7e5cf40f77a143a",
                "signature": "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef"
            })
            .expect(400).then((response) => {
                expect(response.body.message).toBe(
                    "Invalid signature"
                )
            });
            expect(await prisma.recoveryRequest.count()).toBe(0);
        });
        
        it('should succeed with 200 if valid guardian and signature and ', async ()=>{
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
                [ownerPrivateKey],
                chainId,
            )

            const sendUserOperationResponse = await smartAccount.sendUserOperation(
                userOperation, bundlerUrl
            )

            console.log("Useroperation sent. Waiting to be included ......")
            let userOperationReceiptResult = await sendUserOperationResponse.included()
            const recoveryHash = await srm.getRecoveryHash(
                jsonRpcNodeProvider,
                smartAccount.accountAddress,
                newOwners, 
                2,
                0n
            ) 
           signedHash = ethers.utils.joinSignature(
               guardian._signingKey().signDigest(recoveryHash)
           )
           await supertest(app).post('/v1/recoveries/create/')
            .send({
                "account": smartAccount.accountAddress,
                "newOwners": newOwners,
                "newThreshold": 2,
                "chainId": 11155111,
                "signer": guardian.address,
                "signature": signedHash 
            })
            .expect(200);
            expect(await prisma.recoveryRequest.count()).toBe(1);

            const recoveryRequest = await prisma.recoveryRequest.findFirstOrThrow();
            expect(recoveryRequest.account).toBe(
                smartAccount.accountAddress.toLowerCase()
            );
            expect(recoveryRequest.chainId).toBe(11155111);
            expect(recoveryRequest.newOwners).toStrictEqual(newOwners);
            expect(recoveryRequest.newThreshold).toBe(2);
            expect(recoveryRequest.nonce).toBe(0n);
            expect(recoveryRequest.signatures).toStrictEqual(
                [[guardian.address, signedHash]]
            );
            expect(recoveryRequest.status).toBe("PENDING");
         });
         it(
            'should fail with 429 if guardian sent more than 1 create recovery request' +
            'every 5 minutes', async ()=>{
            
            const recoveryHash = await srm.getRecoveryHash(
                jsonRpcNodeProvider,
                smartAccount.accountAddress,
                newOwners,
                2,
                0n
            ) 
           signedHash = ethers.utils.joinSignature(
               guardian._signingKey().signDigest(recoveryHash)
           )

            await supertest(app).post('/v1/recoveries/create/')
            .send({
                "account": smartAccount.accountAddress,
                "newOwners": newOwners,
                "newThreshold": 2,
                "chainId": 11155111,
                "signer": guardian.address,
                "signature": signedHash 
            })
            .expect(429).then((response) => {
                expect(response.body.message).toBe(
                    "You can only create 1 recovery request every 5 minutes"
                )
            });
            expect(await prisma.recoveryRequest.count()).toBe(1);
        });
    });

    describe('fetch recovery by id', ()=>{
        it('should fail with 404 if invalid id', async ()=>{
            await supertest(app).get(
                '/v1/recoveries/fetchById?id=' + 'invalid-id'
            ).expect(404);
        });

        it('should succeed with 200 if valid id', async ()=>{
            const recoveryRequest = await prisma.recoveryRequest.findFirstOrThrow();
            await supertest(app).get(
                '/v1/recoveries/fetchById?id=' + recoveryRequest.id.toString()
            ).expect(200).then((response) => {
                response.body.createdAt = new Date(
                    Date.parse(response.body.createdAt)
                );
                response.body.updatedAt = new Date(
                    Date.parse(response.body.updatedAt)
                );
                response.body.nonce = BigInt(response.body.nonce)
                expect(response.body).toStrictEqual(recoveryRequest);
            });
        });
    });

    describe('fetch recovery by address', ()=>{
        it('should fail with 404 if invalide ethereum address', async ()=>{
            await supertest(app).get(
                '/v1/recoveries/fetchByAddress?' +
                'account=' + 'invalid' +
                '&chainId=11155111' +
                '&nonce=0x0'
            ).expect(400).then((response) => {
                expect(response.body.message).toContain(
                    "\"account\" must be a valid ethereum address"
                )
            });
        });

        it('should fail with 404 if address does not exist', async ()=>{
            await supertest(app).get(
                '/v1/recoveries/fetchByAddress?' +
                'account=' + ethers.Wallet.createRandom().address +
                '&chainId=11155111' +
                '&nonce=0x0'
            ).expect(200);
        });

        it('should succeed with 200 if valid account address', async ()=>{
            const recoveryRequest = await prisma.recoveryRequest.findFirstOrThrow();
            await supertest(app).get(
                '/v1/recoveries/fetchByAddress?' +
                'account=' + smartAccount.accountAddress +
                '&chainId=11155111' +
                '&nonce=0x0'
            ).expect(200).then((response) => {
                response.body[0].createdAt = new Date(
                    Date.parse(response.body[0].createdAt)
                );
                response.body[0].updatedAt = new Date(
                    Date.parse(response.body[0].updatedAt)
                );
                response.body[0].nonce = BigInt(response.body[0].nonce)
                expect(response.body).toStrictEqual([recoveryRequest]);
            });
        });
    });

    describe('collect guardian signature', ()=>{
        it('should succeed with 200 if adding the same guardian and the same signature', async ()=>{
            const recoveryRequest = await prisma.recoveryRequest.findFirstOrThrow();
            await supertest(app).post('/v1/recoveries/sign')
            .send({
                'id': recoveryRequest.id,
                'signer': guardian.address,
                'signature': signedHash
            }).expect(200);

            expect(await prisma.recoveryRequest.count()).toBe(1);
            const recoveryRequest2 = await prisma.recoveryRequest.findFirstOrThrow();
            expect(recoveryRequest2.signatures).toStrictEqual(
                [[guardian.address, signedHash]]
            );
        });

        it('should fail with 400 if signer is not a guardian', async ()=>{
            const recoveryRequest = await prisma.recoveryRequest.findFirstOrThrow();
            await supertest(app).post('/v1/recoveries/sign')
            .send({
                'id': recoveryRequest.id,
                'signer': ethers.Wallet.createRandom().address,
                'signature': signedHash
            }).expect(400).then((response) => {
                expect(response.body.message).toBe(
                    "Signer not a guardian"
                )
            });

            expect(await prisma.recoveryRequest.count()).toBe(1);
            const recoveryRequest2 = await prisma.recoveryRequest.findFirstOrThrow();
            expect(recoveryRequest2.signatures).toStrictEqual(
                [[guardian.address, signedHash]]
            );
        });

        it('should fail with 400 if invalid signature', async ()=>{
            const recoveryRequest = await prisma.recoveryRequest.findFirstOrThrow();
            await supertest(app).post('/v1/recoveries/sign')
            .send({
                'id': recoveryRequest.id,
                'signer': guardian.address,
                'signature': guardian._signingKey().signDigest("0x51c0f964f4e3bcbd933ee1b6ddb553abdf870472a17caa0da58255caabc3643a")
            }).expect(400).then((response) => {
                expect(response.body.message).toContain(
                    "\"signature\" failed custom validation"
                )
            });

            expect(await prisma.recoveryRequest.count()).toBe(1);
        });
   });

    describe('execute recovery', ()=>{
        it('should fail with 404 to execute a recovery with invalid id', async ()=>{
            const recoveryRequest = await prisma.recoveryRequest.findFirstOrThrow();
            await supertest(app).post('/v1/recoveries/execute')
            .send({
                'id': 'invalid',
            }).expect(404);
        });
        
        it('should fail with 403 to execute a recovery with insuffeciant signatures', async ()=>{
            const recoveryRequest = await prisma.recoveryRequest.findFirstOrThrow();
            await supertest(app).post('/v1/recoveries/execute')
            .send({
                'id': recoveryRequest.id,
            }).expect(403).then((response) => {
                expect(response.body.message).toBe(
                    "This recovery request has insufficient signatures (collected 1 signatures, account threshold is 2)"
                )
            });
        });

        it('should succeed with 200 if adding another valid signature', async ()=>{
            const recoveryRequest = await prisma.recoveryRequest.findFirstOrThrow();
            const recoveryHash = await srm.getRecoveryHash(
                jsonRpcNodeProvider,
                smartAccount.accountAddress,
                newOwners, 
                2,
                0n
            ) 
           const signedHash2 = ethers.utils.joinSignature(
               guardian2._signingKey().signDigest(recoveryHash)
           )

            await supertest(app).post('/v1/recoveries/sign')
            .send({
                'id': recoveryRequest.id,
                'signer': guardian2.address,
                'signature': signedHash2
            }).expect(200);

            expect(await prisma.recoveryRequest.count()).toBe(1);
            const recoveryRequest2 = await prisma.recoveryRequest.findFirstOrThrow();
            //expect(recoveryRequest2.signatures).toStrictEqual(
            //    [[guardian.address, signedHash], [guardian2.address, signedHash2]]
            //);
        });

        it('should succeed with 200 to execute a recovery with suffeciant signatures', async ()=>{
            const recoveryRequest = await prisma.recoveryRequest.findFirstOrThrow();
            await supertest(app).post('/v1/recoveries/execute')
            .send({
                'id': recoveryRequest.id,
            }).expect(200);

            console.log("start waiting for executing the recovery");
            await new Promise(resolve => setTimeout(resolve, 1*60*1000)); //1 minute
            console.log("stop waiting for executing the recovery");

            const recoveryRequest2 = await prisma.recoveryRequest.findFirstOrThrow();
            expect(recoveryRequest2.status).toBe("EXECUTED");
        });
    });

    describe('finalize recovery', ()=>{
        it('should fail with 404 to finalize a recovery with invalid id', async ()=>{
            await supertest(app).post('/v1/recoveries/finalize')
            .send({
                'id': 'invalid',
            }).expect(404);
        });

        it('should fail with 400 to finalize a recovery before grace period', async ()=>{
            const recoveryRequest = await prisma.recoveryRequest.findFirstOrThrow();
            await supertest(app).post('/v1/recoveries/finalize')
            .send({
                'id': recoveryRequest.id,
            }).expect(403).then((response) => {
                expect(response.body.message).toBe(
                    "Recovery request is not yet ready for finalization"
                )
            });
        });
        
        it('should succeed with 200 to finalize a recovery after the grace period', async ()=>{
            console.log("start waiting for recovery grace period");
            await new Promise(resolve => setTimeout(resolve, 3*60*1000)); //3 minutes
            console.log("stop waiting for recovery grace period");

            const recoveryRequest = await prisma.recoveryRequest.findFirstOrThrow();
            await supertest(app).post('/v1/recoveries/finalize')
            .send({
                'id': recoveryRequest.id,
            }).expect(200);

            console.log("start waiting for executing the finalization transaction");
            await new Promise(resolve => setTimeout(resolve, 1*60*1000)); //1 minute
            console.log("stop waiting for executing the finalization transaction");
            
            const recoveryRequest2 = await prisma.recoveryRequest.findFirstOrThrow();
            expect(recoveryRequest2.status).toBe("FINALIZED");
            let owners = await smartAccount.getOwners(jsonRpcNodeProvider) as string[];
            owners = owners.map(owner => owner.toLowerCase());
            expect(owners.sort()).toStrictEqual(newOwners.sort());
        });
    });
});
