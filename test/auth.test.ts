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
import {Configuration, CounterfactualAccounts, StoreInitDataPolicy} from '../src/config/config-manager';
import {Network} from '../src/models/network';
import {Signers} from '../src/models/signer/signers';
import {MULTICALL3_ADDRESS} from '../src/utils/erc6492';
import {guardianDeployment, STAND_IN_CONTRACTS} from './guardian-deployment';

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

// An account that is not deployed yet signs with its Safe signature (the owners' SafeMessage signatures, as
// above), wrapped with ERC-6492: abi.encode(factory, factoryCalldata, signature) followed by the magic suffix.
describe('auth (counterfactual account)', ()=>{
    const registerStatement = "I authorize Safe Recovery Service to sign a recovery request for my account after I authenticate using user@example.com (via email)";
    const fetchStatement = "I request to retrieve all authentication methods currently registered to my account with Safe Recovery Service";
    const erc6492Magic = "0x6492649264926492649264926492649264926492649264926492649264926492";

    const cfOwner = ethers.Wallet.createRandom();
    const cfSecondOwner = ethers.Wallet.createRandom();
    const cfOwners = [cfOwner.address, cfSecondOwner.address];
    const cfAccount = SafeAccount.initializeNewAccount(cfOwners, {threshold: 2});
    const [cfFactory, cfFactoryCalldata] = SafeAccount.createFactoryAddressAndData(cfOwners, {threshold: 2});

    const wrap = (factory: string, factoryCalldata: string, signature: string) => ethers.utils.hexConcat([
        ethers.utils.defaultAbiCoder.encode(["address", "bytes", "bytes"], [factory, factoryCalldata, signature]),
        erc6492Magic,
    ]);

    // a SIWE message for the counterfactual account (cfAccount unless another is given), with its Safe signature by `signers`
    const signAsSafe = async (statement: string, signers: ethers.Wallet[], accountAddress = cfAccount.accountAddress): Promise<[SiweMessage, string]> => {
        const siweMessage = new SiweMessage({
            domain: "example.com",
            address: accountAddress,
            statement,
            uri: "https://example.com",
            chainId: Number(chainId),
            version: "1",
            nonce: Math.random().toString(36).substring(2),
            issuedAt: new Date().toISOString(),
        });
        const safeTypedData = getSafeMessageEip712Data(accountAddress, chainId, siweMessage.prepareMessage());
        const pairs = await Promise.all(signers.map(async (signer) => ({
            signer: signer.address,
            signature: await signer._signTypedData(safeTypedData.domain, safeTypedData.types, safeTypedData.messageValue),
        })));
        return [siweMessage, SafeAccount.buildSignaturesFromSingerSignaturePairs(pairs)];
    };

    const register = (siweMessage: SiweMessage, signature: string) => supertest(app).post('/v1/auth/register/').send({
        "account": cfAccount.accountAddress,
        "chainId": Number(chainId),
        "channel": "email",
        "target": "user@example.com",
        "message": siweMessage,
        "signature": signature,
    });

    const registrations = (siweMessage: SiweMessage, signature: string) => supertest(app).get('/v1/auth/registrations/').query({
        account: cfAccount.accountAddress,
        chainId: Number(chainId),
        message: siweMessage,
        signature,
    });

    it('should fail with 403 to register an undeployed account with an unwrapped Safe signature', async ()=>{
        const [siweMessage, signature] = await signAsSafe(registerStatement, [cfOwner, cfSecondOwner]);
        await register(siweMessage, signature).expect(403).then((response) => {
            expect(response.body.message).toContain("invalid signature");
        });
    });

    it('should fail with 403 to register an undeployed account with one owner signature only', async ()=>{
        const [siweMessage, signature] = await signAsSafe(registerStatement, [cfOwner]);
        await register(siweMessage, wrap(cfFactory, cfFactoryCalldata, signature)).expect(403).then((response) => {
            expect(response.body.message).toContain("invalid signature");
        });
    });

    it('should fail with 400 to register with deployment data that does not deploy the account', async ()=>{
        const [, otherCalldata] = SafeAccount.createFactoryAddressAndData(
            [ethers.Wallet.createRandom().address, ethers.Wallet.createRandom().address], {threshold: 2}
        );
        const [siweMessage, signature] = await signAsSafe(registerStatement, [cfOwner, cfSecondOwner]);
        await register(siweMessage, wrap(cfFactory, otherCalldata, signature)).expect(400).then((response) => {
            expect(response.body.message).toContain("does not deploy");
        });
    });

    it('should fail with 400 to register with a malformed ERC-6492 signature', async ()=>{
        const [siweMessage] = await signAsSafe(registerStatement, [cfOwner, cfSecondOwner]);
        await register(siweMessage, "0x1234" + erc6492Magic.slice(2)).expect(400).then((response) => {
            expect(response.body.message).toContain("malformed ERC-6492 signature");
        });
    });

    it('should succeed with 200 to register and fetch registrations of an undeployed account', async ()=>{
        expect(await new ethers.providers.JsonRpcProvider(jsonRpcNodeProvider).getCode(cfAccount.accountAddress)).toBe("0x");
        const [siweMessage, signature] = await signAsSafe(registerStatement, [cfOwner, cfSecondOwner]);
        const registerRes = await register(siweMessage, wrap(cfFactory, cfFactoryCalldata, signature)).expect(200);
        expect(registerRes.body.challengeId).toBeDefined();

        const [fetchMessage, fetchSignature] = await signAsSafe(fetchStatement, [cfOwner, cfSecondOwner]);
        const fetchRes = await registrations(fetchMessage, wrap(cfFactory, cfFactoryCalldata, fetchSignature)).expect(200);
        expect(fetchRes.body.registrations).toEqual([]); // the registration is active once its OTP is submitted
    });

    // options.counterfactualAccounts.storeInitData decides whether the deployment call of an undeployed account that
    // registers is kept, as _factory and _factoryData in the account's metadata. The service reads the option on each
    // request, so every case sets the policy itself and none depends on the config.json the suite runs with.
    describe('init data (storeInitData)', ()=>{
        type Undeployed = {account: string, owners: ethers.Wallet[], factory: string, factoryCalldata: string};
        const provider = new ethers.providers.JsonRpcProvider(jsonRpcNodeProvider);
        let configured: CounterfactualAccounts;
        beforeAll(()=>{
            configured = Configuration.instance().counterfactualAccounts;
        });
        afterEach(()=>{
            Configuration.instance().counterfactualAccounts = configured;
        });

        const networkConfig = async () =>
            (await supertest(app).get('/v1/config/getNetworkConfig').query({chainId: Number(chainId)}).expect(200)).body;

        // abstractionkit's default initializer enables the 4337 module only: deploying it does not install the guardian
        const plainAccount = (): Undeployed => {
            const owners = [ethers.Wallet.createRandom(), ethers.Wallet.createRandom()];
            const addresses = owners.map((wallet) => wallet.address);
            const [factory, factoryCalldata] = SafeAccount.createFactoryAddressAndData(addresses, {threshold: 2});
            const {accountAddress} = SafeAccount.initializeNewAccount(addresses, {threshold: 2});
            return {account: accountAddress, owners, factory, factoryCalldata};
        };

        // a deployment that enables the network's first module and adds the service's guardian to it
        // (test/guardian-deployment.ts)
        const guardianAccount = async (): Promise<Undeployed> => {
            for (const address of STAND_IN_CONTRACTS) {
                expect([address, await provider.getCode(address)]).not.toEqual([address, "0x"]);
            }
            const {guardianAddress, modules} = await networkConfig();
            const owner = ethers.Wallet.createRandom();
            const {account, deployment} = await guardianDeployment(provider, owner, modules[0].address, guardianAddress);
            return {account, owners: [owner], factory: deployment.factory, factoryCalldata: deployment.factoryCalldata};
        };

        const kept = ({factory, factoryCalldata}: Undeployed) =>
            ({_factory: ethers.utils.getAddress(factory), _factoryData: factoryCalldata.toLowerCase()});

        // the code mailed to an address; a verification code is sent after its response, so this waits for it
        const codeSentTo = async (target: string): Promise<string> => {
            const deadline = Date.now() + 15000;
            for (;;) {
                const response = await fetch('http://localhost:8025/api/v1/messages?limit=1000');
                const {messages} = await response.json() as {messages: {To: {Address: string}[], Snippet: string}[]};
                const email = messages.find((message) => message.To.some((to) => to.Address === target));
                const code = email ? /\b\d{6}\b/.exec(email.Snippet) : null;
                if (code) return code[0];
                if (Date.now() > deadline) throw new Error(`no code reached ${target}`);
                await new Promise((resolve) => setTimeout(resolve, 250));
            }
        };

        const verifyTarget = async (target: string): Promise<string> => {
            const requested = await supertest(app).post('/v1/auth/verification/request')
                .send({channel: "email", target}).expect(200);
            const submitted = await supertest(app).post('/v1/auth/verification/submit')
                .send({challengeId: requested.body.challengeId, challenge: await codeSentTo(target)}).expect(200);
            return submitted.body.verifiedTargetToken;
        };

        const setPolicy = async (policy: StoreInitDataPolicy) => {
            Configuration.instance().counterfactualAccounts = {erc6492: true, storeInitData: policy};
            expect((await networkConfig()).counterfactualAccounts).toEqual({erc6492: true, storeInitData: policy});
        };

        const newTarget = () => `init-data-${ethers.utils.hexlify(ethers.utils.randomBytes(6)).slice(2)}@example.com`;

        // POST /v1/auth/register for the undeployed account: a new SIWE message signed by its owners, wrapped with its
        // deployment call
        const sendRegister = async ({account, owners, factory, factoryCalldata}: Undeployed, target: string, verifiedTargetToken?: string) => {
            const [siweMessage, signature] = await signAsSafe(registerStatement.replace("user@example.com", target), owners, account);
            return await supertest(app).post('/v1/auth/register/').send({
                "account": account,
                "chainId": Number(chainId),
                "channel": "email",
                "target": target,
                "message": siweMessage,
                "signature": wrap(factory, factoryCalldata, signature),
                ...(verifiedTargetToken === undefined ? {} : {verifiedTargetToken}),
            });
        };

        // the metadata GET /v1/auth/registrations answers for the account, which has one registration
        const storedMetadata = async ({account, owners, factory, factoryCalldata}: Undeployed) => {
            const [fetchMessage, fetchSignature] = await signAsSafe(fetchStatement, owners, account);
            const fetchRes = await supertest(app).get('/v1/auth/registrations/').query({
                account,
                chainId: Number(chainId),
                message: fetchMessage,
                signature: wrap(factory, factoryCalldata, fetchSignature),
            }).expect(200);
            expect(fetchRes.body.registrations).toHaveLength(1);
            return fetchRes.body.metadata;
        };

        // Registers the undeployed account under `policy` with a new email address, verified by the registration's
        // code or by a verifiedTargetToken, and returns the metadata the service then answers for the account.
        const registerUnder = async (policy: StoreInitDataPolicy, undeployed: Undeployed, verification: "otp" | "token" = "otp") => {
            await setPolicy(policy);
            expect(await provider.getCode(undeployed.account)).toBe("0x");
            const target = newTarget();
            const verifiedTargetToken = verification === "token" ? await verifyTarget(target) : undefined;
            const registerRes = await sendRegister(undeployed, target, verifiedTargetToken);
            expect(registerRes.status).toBe(200);
            if (verifiedTargetToken === undefined) {
                await supertest(app).post('/v1/auth/submit/')
                    .send({challengeId: registerRes.body.challengeId, challenge: await codeSentTo(target)}).expect(200);
            } else {
                // registered at once: no code, no challenge
                expect(registerRes.body.registrationId).toBeDefined();
            }
            return storedMetadata(undeployed);
        };

        it('should keep nothing under "never"', async ()=>{
            expect(await registerUnder("never", plainAccount())).toEqual({});
        });

        it('should keep the init data under "always"', async ()=>{
            const undeployed = plainAccount();
            expect(await registerUnder("always", undeployed)).toEqual(kept(undeployed));
        });

        it('should keep the init data under "always" when registering with a verifiedTargetToken', async ()=>{
            const undeployed = plainAccount();
            expect(await registerUnder("always", undeployed, "token")).toEqual(kept(undeployed));
        });

        it('should keep nothing under "with-guardian" when deploying does not install the guardian', async ()=>{
            expect(await registerUnder("with-guardian", plainAccount())).toEqual({});
        });

        it('should keep the init data under "with-guardian" when deploying installs the guardian', async ()=>{
            const undeployed = await guardianAccount();
            expect(await registerUnder("with-guardian", undeployed)).toEqual(kept(undeployed));
        });

        // A register with a verifiedTargetToken keeps no pending request, so when the write of its init data fails the
        // register sent again, with a new SIWE message, is what stores it. Here the first register keeps nothing because
        // of the policy.
        it('should store the init data of a registered target that registers again with a verifiedTargetToken, and answer 409', async ()=>{
            const undeployed = plainAccount();
            const target = newTarget();
            const verifiedTargetToken = await verifyTarget(target);
            await setPolicy("never");
            expect((await sendRegister(undeployed, target, verifiedTargetToken)).status).toBe(200);
            expect(await storedMetadata(undeployed)).toEqual({});

            await setPolicy("always");
            // without the token: 409, and nothing is written
            expect((await sendRegister(undeployed, target)).status).toBe(409);
            expect(await storedMetadata(undeployed)).toEqual({});
            expect((await sendRegister(undeployed, target, verifiedTargetToken)).status).toBe(409);
            expect(await storedMetadata(undeployed)).toEqual(kept(undeployed));
        });

        // POST /v1/auth/accounts/deploy sends a transaction, paid by the network's deployAccounts.signer: config.json must
        // enable deployAccounts on the network, and the signer must hold funds, else the case is skipped with a message.
        // The stand-in's "factory" is Multicall3, which the case adds to the network's factories itself (and takes out
        // afterwards), as the cases above set storeInitData.
        it('should deploy an undeployed account it sponsors, after which signature/request passes', async ()=>{
            const network = Network.instances.get(chainId.toString())!;
            const configuredDeployAccounts = network.deployAccounts;
            if (!configuredDeployAccounts.enabled) {
                console.log("skipped: deployAccounts is not enabled on this network in config.json");
                return;
            }
            const signerAddress = await Signers.instance().getSigner(configuredDeployAccounts.signer)!.signer();
            if ((await provider.getBalance(signerAddress)).isZero()) {
                console.log(`skipped: the deployAccounts signer ${signerAddress} holds no funds`);
                return;
            }
            network.deployAccounts = {
                ...configuredDeployAccounts,
                factories: [...configuredDeployAccounts.factories, MULTICALL3_ADDRESS.toLowerCase()],
                requireGuardian: true,
                rateLimit: undefined,
            };
            try {
                const undeployed = await guardianAccount();
                const account = undeployed.account.toLowerCase();
                await setPolicy("with-guardian");
                const target = newTarget();
                const verifiedTargetToken = await verifyTarget(target);
                expect((await sendRegister(undeployed, target, verifiedTargetToken)).status).toBe(200);
                expect(await storedMetadata(undeployed)).toEqual(kept(undeployed));
                expect((await networkConfig()).sponsorships.deployment).toMatchObject({enabled: true, requireGuardian: true});

                const {modules} = await networkConfig();
                const requestSignature = () => supertest(app).post('/v1/auth/signature/request').send({
                    account: undeployed.account,
                    newOwners: [ethers.Wallet.createRandom().address],
                    newThreshold: 1,
                    chainId: Number(chainId),
                    moduleAddress: modules[0].address,
                });
                // before: no code, so no Safe to read, and the error says a sponsored deployment is available
                const notDeployed = await requestSignature().expect(400);
                expect(notDeployed.body.message).toBe(`Account ${account} is not deployed on this network (${chainId})`);
                expect(notDeployed.body.details).toEqual({reason: "account-not-deployed", sponsoredDeployment: true});

                const deploy = () => supertest(app).post('/v1/auth/accounts/deploy')
                    .send({account: undeployed.account, chainId: Number(chainId), verifiedTargetToken});
                const requested = await deploy().expect(202);
                expect(requested.body).toEqual({account, chainId: Number(chainId), status: "pending"});
                expect(requested.headers["cache-control"]).toBe("no-store");

                // the status read, until the executor's outcome is in
                const deadline = Date.now() + 10 * 60 * 1000;
                let deployment: Record<string, unknown>;
                for (;;) {
                    deployment = (await supertest(app).get('/v1/auth/accounts/deployment')
                        .query({account: undeployed.account, chainId: Number(chainId)}).expect(200)).body;
                    if (deployment.status !== "pending" || Date.now() > deadline) break;
                    await new Promise((resolve) => setTimeout(resolve, 5000));
                }
                expect(deployment).toMatchObject({account, chainId: Number(chainId), status: "deployed", attempts: 1});
                expect(deployment.transactionHash).toMatch(/^0x[0-9a-f]{64}$/);
                expect(await provider.getCode(undeployed.account)).not.toBe("0x");

                // after: a Safe with the guardian on the module
                expect((await requestSignature().expect(200)).body.requestId).toBeDefined();
                expect((await deploy().expect(200)).body)
                    .toEqual({account, chainId: Number(chainId), status: "deployed", transactionHash: deployment.transactionHash});
            } finally {
                network.deployAccounts = configuredDeployAccounts;
            }
        });
    });

    it('should accept plain and still-wrapped signatures once the account is deployed', async ()=>{
        let userOperation = await cfAccount.createUserOperation(
            [srm.createEnableModuleMetaTransaction(cfAccount.accountAddress)],
            jsonRpcNodeProvider,
            bundlerUrl,
        );
        const paymaster = new CandidePaymaster(paymasterRPC);
        const [paymasterUserOperation] = await paymaster.createSponsorPaymasterUserOperation(
            userOperation, bundlerUrl, sponsorshipPolicyId
        );
        userOperation = paymasterUserOperation;
        userOperation.signature = cfAccount.signUserOperation(
            userOperation, [cfOwner.privateKey, cfSecondOwner.privateKey], BigInt(chainId),
        );
        const sendUserOperationResponse = await cfAccount.sendUserOperation(userOperation, bundlerUrl);
        await sendUserOperationResponse.included();
        expect(await new ethers.providers.JsonRpcProvider(jsonRpcNodeProvider).getCode(cfAccount.accountAddress)).not.toBe("0x");

        const [plainMessage, plainSignature] = await signAsSafe(fetchStatement, [cfOwner, cfSecondOwner]);
        await registrations(plainMessage, plainSignature).expect(200);

        // the deployment data is ignored once the account has code
        const [wrappedMessage, wrappedSignature] = await signAsSafe(fetchStatement, [cfOwner, cfSecondOwner]);
        await registrations(wrappedMessage, wrap(cfFactory, cfFactoryCalldata, wrappedSignature)).expect(200);
    });
});
