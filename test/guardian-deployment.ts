// Not a test: the stand-in deployments of the init-data tests (test/account-init-data.test.ts against a chain,
// test/auth.test.ts over HTTP). A wallet installs the guardian from the initializer (setup() delegate-calls a contract
// of its choosing), which the service treats like any other deployment: it only reads the state the deployment leaves.
// guardianDeployment builds the same state with what ethers alone can sign: the ERC-6492 "factory" is Multicall3,
// batching createProxyWithNonce and then a Safe transaction, pre-signed by the owner, that enables the module and adds
// the guardian.
import {ethers} from "ethers";
import {AccountDeployment, MULTICALL3_ADDRESS} from "../src/utils/erc6492";
import moduleSource from "../src/utils/source/SocialRecoveryModule.v0.2.0.json";

export const SAFE_PROXY_FACTORY_1_4_1 = "0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67";
export const SAFE_L2_SINGLETON_1_4_1 = "0x29fcB43b46531BcA003ddC8FCB67FFE91900C762";
export const COMPATIBILITY_FALLBACK_HANDLER_1_4_1 = "0xfd0732Dc9E303f09fCEf3a7388Ad10A83459Ec99";
export const MULTI_SEND_CALL_ONLY_1_4_1 = "0x9641d764fc13c8B624c04430C7356C1C7C8102e2";
// every contract a stand-in deployment calls, besides the module
export const STAND_IN_CONTRACTS = [
  SAFE_PROXY_FACTORY_1_4_1,
  SAFE_L2_SINGLETON_1_4_1,
  COMPATIBILITY_FALLBACK_HANDLER_1_4_1,
  MULTI_SEND_CALL_ONLY_1_4_1,
  MULTICALL3_ADDRESS,
];

const ZERO = ethers.constants.AddressZero;
const factoryInterface = new ethers.utils.Interface([
  "function createProxyWithNonce(address _singleton, bytes initializer, uint256 saltNonce) returns (address proxy)",
]);
const safeInterface = new ethers.utils.Interface([
  "function setup(address[] _owners, uint256 _threshold, address to, bytes data, address fallbackHandler, address paymentToken, uint256 payment, address paymentReceiver)",
  "function execTransaction(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, bytes signatures) payable returns (bool)",
  "function enableModule(address module)",
]);
const multiSendInterface = new ethers.utils.Interface(["function multiSend(bytes transactions) payable"]);
// addGuardianWithThreshold(guardian, threshold) is the same on v0.1.0 and v0.2.0
const moduleInterface = new ethers.utils.Interface(moduleSource.abi);
const multicall3Interface = new ethers.utils.Interface([
  "function aggregate3((address target, bool allowFailure, bytes callData)[] calls) payable returns ((bool success, bytes returnData)[] returnData)",
]);

export type StandInDeployment = {account: string; deployment: AccountDeployment};

// a one-owner Safe 1.4.1 with the compatibility fallback handler, as abstractionkit-free as it gets: its
// createProxyWithNonce call (a random salt) and the address that call deploys, as the factory answers it
const createProxy = async (provider: ethers.providers.Provider, owner: string): Promise<{account: string; callData: string}> => {
  const callData = factoryInterface.encodeFunctionData("createProxyWithNonce", [
    SAFE_L2_SINGLETON_1_4_1,
    safeInterface.encodeFunctionData("setup", [[owner], 1, ZERO, "0x", COMPATIBILITY_FALLBACK_HANDLER_1_4_1, ZERO, 0, ZERO]),
    ethers.BigNumber.from(ethers.utils.randomBytes(16)),
  ]);
  const answer = await provider.call({to: SAFE_PROXY_FACTORY_1_4_1, data: callData});
  return {account: factoryInterface.decodeFunctionResult("createProxyWithNonce", answer)[0] as string, callData};
};

// the Safe alone: deploying it enables no module
export const plainDeployment = async (provider: ethers.providers.Provider, owner: string): Promise<StandInDeployment> => {
  const {account, callData} = await createProxy(provider, owner);
  return {account, deployment: {factory: SAFE_PROXY_FACTORY_1_4_1, factoryCalldata: callData}};
};

// the Safe, then its first transaction: deploying it enables `module` and adds `guardian` to it, with threshold 1
export const guardianDeployment = async (
  provider: ethers.providers.Provider,
  owner: ethers.Wallet,
  module: string,
  guardian: string,
): Promise<StandInDeployment> => {
  const {chainId} = await provider.getNetwork();
  const {account, callData} = await createProxy(provider, owner.address);
  // the Safe transaction: delegatecall MultiSendCallOnly, which calls enableModule on the Safe, then
  // addGuardianWithThreshold on the module (whose wallet is the caller, the Safe)
  const packed = (to: string, data: string) => ethers.utils.solidityPack(
    ["uint8", "address", "uint256", "uint256", "bytes"], [0, to, 0, ethers.utils.hexDataLength(data), data]
  );
  const transactions = ethers.utils.hexConcat([
    packed(account, safeInterface.encodeFunctionData("enableModule", [module])),
    packed(module, moduleInterface.encodeFunctionData("addGuardianWithThreshold", [guardian, 1])),
  ]);
  const safeTx = {
    to: MULTI_SEND_CALL_ONLY_1_4_1,
    value: 0,
    data: multiSendInterface.encodeFunctionData("multiSend", [transactions]),
    operation: 1,
    safeTxGas: 0,
    baseGas: 0,
    gasPrice: 0,
    gasToken: ZERO,
    refundReceiver: ZERO,
    nonce: 0,
  };
  const signature = await owner._signTypedData({chainId, verifyingContract: account}, {
    SafeTx: [
      {name: "to", type: "address"},
      {name: "value", type: "uint256"},
      {name: "data", type: "bytes"},
      {name: "operation", type: "uint8"},
      {name: "safeTxGas", type: "uint256"},
      {name: "baseGas", type: "uint256"},
      {name: "gasPrice", type: "uint256"},
      {name: "gasToken", type: "address"},
      {name: "refundReceiver", type: "address"},
      {name: "nonce", type: "uint256"},
    ],
  }, safeTx);
  const execTransaction = safeInterface.encodeFunctionData("execTransaction", [
    safeTx.to, safeTx.value, safeTx.data, safeTx.operation, safeTx.safeTxGas, safeTx.baseGas, safeTx.gasPrice,
    safeTx.gasToken, safeTx.refundReceiver, signature,
  ]);
  return {
    account,
    deployment: {
      factory: MULTICALL3_ADDRESS,
      factoryCalldata: multicall3Interface.encodeFunctionData("aggregate3", [[
        {target: SAFE_PROXY_FACTORY_1_4_1, allowFailure: false, callData},
        {target: account, allowFailure: false, callData: execTransaction},
      ]]),
    },
  };
};
