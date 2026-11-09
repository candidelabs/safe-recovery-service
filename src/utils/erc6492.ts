import {ethers} from "ethers";

// ERC-6492 signatures, for accounts that are not deployed yet (counterfactual), and their verification by
// simulation: one eth_call to Multicall3.aggregate3 that runs the account's factory call, then reads the
// account (isValidSignature, or getOwners) in the state that call left. Nothing is broadcast and no key of
// the service is involved.
//
// Security: the deployment data (factory, factoryCalldata) is chosen by the client. CREATE / CREATE2 bind a
// deployed address to the factory's own address, so a factory can only put code at addresses derived from
// itself: the only way to put code at a victim's counterfactual address is the victim's real factory,
// initializer and salt, which deploy the victim's real owners. A fake factory can only "deploy" a fake account
// at an address of its own, and register or subscribe for that address, which belongs to the attacker anyway.
// The factory call only ever runs inside eth_call, and never against an account that has code: once the
// account is deployed, the deployment data is ignored (no ERC-6492 "prepare" call). Never log `signature`,
// `factory` or `factoryCalldata`.

export const ERC6492_MAGIC = "0x6492649264926492649264926492649264926492649264926492649264926492";
export const MULTICALL3_ADDRESS = "0xcA11bde05977b3631167028862bE2a173976CA11";
export const EIP1271_MAGIC = "0x1626ba7e";

export interface AccountDeployment {
  factory: string;
  factoryCalldata: string;
}

export interface UnwrappedSignature {
  deployment: AccountDeployment;
  signature: string; // the inner signature
}

// The provider calls the verifier makes, so tests can pass a fake one (ethers' JsonRpcProvider has both).
export interface CodeAndCallProvider {
  getCode(address: string): Promise<string>;
  send(method: string, params: unknown[]): Promise<unknown>;
}

// malformed: the wrapper does not decode; deploy-failed: the factory call reverted (or the node refused the
// simulation); no-result: the account gave no answer after the factory call (no code at the address).
export type Erc6492ErrorReason = "malformed" | "deploy-failed" | "no-result";

export class Erc6492Error extends Error {
  public readonly reason: Erc6492ErrorReason;

  constructor(reason: Erc6492ErrorReason, message: string) {
    super(message);
    this.name = "Erc6492Error";
    this.reason = reason;
  }
}

const WRAPPER_TYPES = ["address", "bytes", "bytes"];
const MAGIC_SUFFIX = ERC6492_MAGIC.slice(2);
const MULTICALL3 = new ethers.utils.Interface([
  "function aggregate3((address target, bool allowFailure, bytes callData)[] calls) payable returns ((bool success, bytes returnData)[] returnData)",
]);
const EIP1271 = new ethers.utils.Interface([
  "function isValidSignature(bytes32 hash, bytes signature) view returns (bytes4)",
]);
const SAFE_OWNERS = new ethers.utils.Interface([
  "function getOwners() view returns (address[])",
]);

export const isErc6492Signature = (signature: string): boolean =>
  ethers.utils.isHexString(signature) && signature.length >= 2 + MAGIC_SUFFIX.length
  && signature.slice(-MAGIC_SUFFIX.length).toLowerCase() === MAGIC_SUFFIX;

// abi.encode(address factory, bytes factoryCalldata, bytes signature) followed by the magic suffix
export const unwrapErc6492Signature = (signature: string): UnwrappedSignature => {
  if (!isErc6492Signature(signature)) {
    throw new Erc6492Error("malformed", "not an ERC-6492 signature");
  }
  try {
    const wrapper = ethers.utils.hexDataSlice(signature, 0, ethers.utils.hexDataLength(signature) - 32);
    const [factory, factoryCalldata, innerSignature] = ethers.utils.defaultAbiCoder.decode(WRAPPER_TYPES, wrapper);
    return {
      deployment: {
        factory: ethers.utils.getAddress(factory),
        factoryCalldata: ethers.utils.hexlify(factoryCalldata),
      },
      signature: ethers.utils.hexlify(innerSignature),
    };
  } catch (error) {
    throw new Erc6492Error("malformed", "the ERC-6492 wrapper does not decode as (address, bytes, bytes)");
  }
};

export const wrapErc6492Signature = (deployment: AccountDeployment, signature: string): string =>
  ethers.utils.hexConcat([
    ethers.utils.defaultAbiCoder.encode(WRAPPER_TYPES, [deployment.factory, deployment.factoryCalldata, signature]),
    ERC6492_MAGIC,
  ]);

export const hasCode = async (provider: CodeAndCallProvider, address: string): Promise<boolean> => {
  const code = await provider.getCode(address);
  return code !== "0x" && code !== "0x0";
};

export const isMulticall3Deployed = (provider: CodeAndCallProvider, multicall3: string): Promise<boolean> =>
  hasCode(provider, multicall3);

// A JSON-RPC error object (numeric code) somewhere in the error chain: the node ran the call and refused it
// (a revert, out of gas). Transport failures (timeouts, HTTP errors) carry none and are not ours to map.
const isNodeExecutionError = (error: unknown): boolean => {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current !== null && typeof current === "object"; depth++) {
    if (typeof (current as {code?: unknown}).code === "number") return true;
    current = (current as {error?: unknown}).error;
  }
  return false;
};

// [factory.call(factoryCalldata) (must succeed), account.call(callData) (may fail)] in one eth_call;
// returns the second call's result.
const simulateDeployAndCall = async (
  provider: CodeAndCallProvider,
  multicall3: string,
  deployment: AccountDeployment,
  account: string,
  callData: string,
): Promise<{success: boolean; returnData: string}> => {
  const data = MULTICALL3.encodeFunctionData("aggregate3", [[
    {target: deployment.factory, allowFailure: false, callData: deployment.factoryCalldata},
    {target: account, allowFailure: true, callData},
  ]]);
  let result: unknown;
  try {
    // send, not call: ethers' call() reports every failure (transport errors included) as a CALL_EXCEPTION,
    // or answers a revert with its data, which would hide the difference made here
    result = await provider.send("eth_call", [{to: multicall3, data}, "latest"]);
  } catch (error) {
    if (isNodeExecutionError(error)) {
      throw new Erc6492Error("deploy-failed", "the factory call reverted");
    }
    throw error;
  }
  let calls: {success: boolean; returnData: string}[];
  try {
    [calls] = MULTICALL3.decodeFunctionResult("aggregate3", result as string);
  } catch (error) {
    throw new Error(`Multicall3 at ${multicall3} returned data that does not decode as an aggregate3 result`);
  }
  if (calls.length !== 2) {
    throw new Error(`Multicall3 at ${multicall3} returned ${calls.length} results for 2 calls`);
  }
  return {success: calls[1].success, returnData: calls[1].returnData};
};

// Deploys the account in simulation and runs EIP-1271 on it. False when the account answers anything but the
// magic value (or reverts); an empty answer means the factory call put no code at `account` (no-result).
export const simulateIsValidSignature = async (
  provider: CodeAndCallProvider,
  multicall3: string,
  deployment: AccountDeployment,
  account: string,
  hash: string,
  signature: string,
): Promise<boolean> => {
  const callData = EIP1271.encodeFunctionData("isValidSignature", [hash, signature]);
  const {success, returnData} = await simulateDeployAndCall(provider, multicall3, deployment, account, callData);
  if (!success) return false;
  if (ethers.utils.hexDataLength(returnData) === 0) {
    throw new Erc6492Error("no-result", "the account has no code after the factory call");
  }
  return returnData.slice(0, 10).toLowerCase() === EIP1271_MAGIC;
};

// Deploys the account in simulation and reads its owners, lower case.
export const simulateGetOwners = async (
  provider: CodeAndCallProvider,
  multicall3: string,
  deployment: AccountDeployment,
  account: string,
): Promise<string[]> => {
  const callData = SAFE_OWNERS.encodeFunctionData("getOwners");
  const {success, returnData} = await simulateDeployAndCall(provider, multicall3, deployment, account, callData);
  if (!success || ethers.utils.hexDataLength(returnData) === 0) {
    throw new Erc6492Error("no-result", "the account does not answer getOwners() after the factory call");
  }
  let owners: string[];
  try {
    [owners] = SAFE_OWNERS.decodeFunctionResult("getOwners", returnData);
  } catch (error) {
    throw new Erc6492Error("no-result", "the account's getOwners() answer does not decode");
  }
  return owners.map((owner) => owner.toLowerCase());
};
