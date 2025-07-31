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

function getMessageHashForSafe(
    accountAddress: string, payload: string, chainId: number
){
    const SAFE_MSG_TYPEHASH = "0x60b3cbf8b4a223d68d641b3b6ddf9a298e7f33710cf3d3a9d1146b5a6150fbca";
    const DOMAIN_SEPARATOR_TYPEHASH = "0x47e79534a245952e8b16893a336b85a3d9ea9fa8c573f3d803afb92a79469218";
    const domainSeparator = ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(
      ["bytes32", "uint256", "address"],
      [DOMAIN_SEPARATOR_TYPEHASH, chainId, accountAddress]
    ));
    const encodedMessage = ethers.AbiCoder.defaultAbiCoder().encode(
      ["bytes32", "bytes32"],
      [SAFE_MSG_TYPEHASH, ethers.keccak256(payload)]
    );
    const messageHash = ethers.keccak256(ethers.solidityPacked(
      ["bytes1", "bytes1", "bytes32", "bytes32",],
      [Uint8Array.from([0x19]), Uint8Array.from([0x01]), domainSeparator, ethers.keccak256(encodedMessage)]
    ));
    return messageHash;
}

function personalSign(
    accountAddress: string, payload: string, chainId: number, privateKey: string
){
    payload = hashMessage(payload);
    const messageHash = getMessageHashForSafe(accountAddress, payload, chainId);
    const signer = new ethers.Wallet(privateKey);
    return signer.signingKey.sign(messageHash).serialized;
}

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
        it('should succeed with 200 to register if valid', async ()=>{
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
                [ownerPrivateKey],
                BigInt(chainId),
            )

            const sendUserOperationResponse = await smartAccount.sendUserOperation(
                userOperation, bundlerUrl
            )

            console.log("Useroperation sent. Waiting to be included ......")
            let userOperationReceiptResult = await sendUserOperationResponse.included()

            // 2️⃣ Create a SIWE Message
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
                chainId,
                version, //optional
                nonce, //optional
                issuedAt, //optional
            });
            const message = siweMessage.prepareMessage();
            const payload = hashMessage(message);
            const messageHash = getMessageHashForSafe(
                smartAccount.accountAddress, payload, chainId);
            const signature = owner.signingKey.sign(messageHash).serialized;
                        
            await supertest(app).post('/v1/auth/register/')
            .send({
                "account": smartAccount.accountAddress,
                "chainId": chainId,
                "channel":"email",
                "target":"user@example.com",
                "message":message,
                "signature": signature
            })
            .expect(200);
        });
    });
});
