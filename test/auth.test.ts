import supertest from 'supertest';
import {app} from '../src/index';
import * as dotenv from 'dotenv'
import {ethers} from "ethers";

jest.setTimeout(300000);
import {
    SafeAccountV0_3_0 as SafeAccount,
    CandidePaymaster,
    SocialRecoveryModule,
    SocialRecoveryModuleGracePeriodSelector,
    getSafeMessageEip712Data,
} from "abstractionkit";
import { SiweMessage } from 'siwe';

//get values from .env
dotenv.config()
const chainId = BigInt(process.env.CHAIN_ID_1 as string)
const bundlerUrl = process.env.BUNDLER_URL_1 as string
const jsonRpcNodeProvider = process.env.JSON_RPC_NODE_PROVIDER_1 as string
const paymasterRPC = process.env.PAYMASTER_RPC_1 as string;
const sponsorshipPolicyId = process.env.SPONSORSHIP_POLICY_ID_1 as string;


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
const srm = new SocialRecoveryModule(
    SocialRecoveryModuleGracePeriodSelector.After3Minutes
);

beforeAll(async ()=>{
    let userOperation = await smartAccount.createUserOperation(
        [
            srm.createEnableModuleMetaTransaction(smartAccount.accountAddress),
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
});

describe('auth', ()=>{
    it('should return a 404 if wrong path', async ()=>{
        await supertest(app).get('/v1/auth/wrong/').expect(404);
    });
    describe('auth', ()=>{
        it('should fail with 400 to register if wrong message format', async ()=>{
            await supertest(app).post('/v1/auth/register/')
            .send({
                "account": "0x0000000000000000000000000000000000000000",
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
            await supertest(app).post('/v1/auth/register/')
            .send({
                "account": "0x0000000000000000000000000000000000000000",
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
            await supertest(app).post('/v1/auth/register/')
            .send({
                "account": "0x0000000000000000000000000000000000000000",
                "chainId": 11155111,
                "channel":"email",
                "target":"user@example.com",
                "message":{
                  version: "1",
                  address: "0x0000000000000000000000000000000000000000",
                  domain: "service://safe-recovery-service",
                  uri: "service://safe-recovery-service",
                  statement: "I authorize Safe Recovery Service to sign a recovery request for my account after I authenticate using user@example.com (via email)",
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


        it('should fail with 403 to register if only one owner signature', async ()=>{
            const domain = "example.com";
            const statement = "I authorize Safe Recovery Service to sign a recovery request for my account after I authenticate using user@example.com (via email)";
            const uri = "https://example.com";
            const version = "1";
            const nonce = Math.random().toString(36).substring(2); // Generate a random nonce
            const issuedAt = new Date().toISOString();

            const siweMessage = new SiweMessage({
                domain,
                address: smartAccount.accountAddress,
                statement,
                uri,
                chainId: Number(chainId),
                version, //optional
                nonce, //optional
                issuedAt, //optional
            });
            const message = siweMessage.prepareMessage();
            const safeTypedData = getSafeMessageEip712Data(
                smartAccount.accountAddress,
                chainId,
                message
            )
            const owner1signature = await owner._signTypedData(
                safeTypedData.domain,
                safeTypedData.types,
                safeTypedData.messageValue
            );
            await supertest(app).post('/v1/auth/register/')
            .send({
                "account": smartAccount.accountAddress,
                "chainId": 11155111,
                "channel":"email",
                "target":"user@example.com",
                "message":siweMessage,
                "signature": owner1signature
            })
            .expect(403).then((response) => {
                expect(response.body.message).toContain(
                    "invalid signature"
                )
            });
        });

        it('should succeed with 200 to register if correct signature', async ()=>{
            const domain = "example.com";
            const statement = "I authorize Safe Recovery Service to sign a recovery request for my account after I authenticate using user@example.com (via email)";
            const uri = "https://example.com";
            const version = "1";
            const nonce = Math.random().toString(36).substring(2); // Generate a random nonce
            const issuedAt = new Date().toISOString();

            const siweMessage = new SiweMessage({
                domain,
                address: smartAccount.accountAddress,
                statement,
                uri,
                chainId: Number(chainId),
                version, //optional
                nonce, //optional
                issuedAt, //optional
            });
            const message = siweMessage.prepareMessage();
            const safeTypedData = getSafeMessageEip712Data(
                smartAccount.accountAddress,
                chainId,
                message
            )
            const owner1signature = await owner._signTypedData(
                safeTypedData.domain,
                safeTypedData.types,
                safeTypedData.messageValue
            );
            const owner2signature = await secondOwner._signTypedData(
                safeTypedData.domain,
                safeTypedData.types,
                safeTypedData.messageValue
            );

            const signature = SafeAccount.buildSignaturesFromSingerSignaturePairs(
                [
                    {signer: ownerPublicAddress, signature: owner1signature},
                    {signer: secondOwnerPublicAddress, signature: owner2signature},
                ]
            )
            await supertest(app).post('/v1/auth/register/')
            .send({
                "account": smartAccount.accountAddress,
                "chainId": 11155111,
                "channel":"email",
                "target":"user@example.com",
                "message":siweMessage,
                "signature": signature
            })
            .expect(200);
        });
    });
});
