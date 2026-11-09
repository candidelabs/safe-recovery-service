// Unit tests of ERC-6492 support: no database, no chain (a fake JSON-RPC provider), no app boot.
import {ethers} from "ethers";
import {SiweMessage} from "siwe";
import {
  AccountDeployment,
  CodeAndCallProvider,
  EIP1271_MAGIC,
  ERC6492_MAGIC,
  Erc6492Error,
  hasCode,
  isErc6492Signature,
  isMulticall3Deployed,
  MULTICALL3_ADDRESS,
  simulateGetOwners,
  simulateIsValidSignature,
  unwrapErc6492Signature,
  wrapErc6492Signature,
} from "../src/utils/erc6492";
import {validateOwnerSIWEMessage, validateSIWEMessage} from "../src/utils/utilities";
import {fetchAccountOwners, requireAccountOwner} from "../src/utils/account-owners";
import {Network} from "../src/models/network";

const MULTICALL3 = new ethers.utils.Interface([
  "function aggregate3((address target, bool allowFailure, bytes callData)[] calls) payable returns ((bool success, bytes returnData)[] returnData)",
]);
const EIP1271 = new ethers.utils.Interface(["function isValidSignature(bytes32 hash, bytes signature) view returns (bytes4)"]);
const SAFE_OWNERS = new ethers.utils.Interface(["function getOwners() view returns (address[])"]);

const CHAIN_ID = 11155111;
const account = ethers.Wallet.createRandom().address; // stands in for a counterfactual Safe
const factory = ethers.Wallet.createRandom().address;
const factoryCalldata = "0x1688f0b9" + "ab".repeat(100); // any bytes: the factory call only runs in simulation
const deployment: AccountDeployment = {factory, factoryCalldata};
const innerSignature = "0x" + "11".repeat(130); // e.g. two owner signatures of a Safe
const hash = ethers.utils.keccak256(ethers.utils.toUtf8Bytes("message"));

const aggregate3Result = (calls: [boolean, string][]) =>
  MULTICALL3.encodeFunctionResult("aggregate3", [calls.map(([success, returnData]) => ({success, returnData}))]);
const magicResult = EIP1271.encodeFunctionResult("isValidSignature", [EIP1271_MAGIC]);

// a JSON-RPC error answered by the node, as ethers' send() rejects with it
const nodeError = (message: string) =>
  Object.assign(new Error("processing response error"), {code: "SERVER_ERROR", error: Object.assign(new Error(message), {code: 3})});

const expectErc6492Error = async (promise: Promise<unknown>, reason: string) => {
  const error = await promise.then(() => undefined, (e) => e);
  expect(error).toBeInstanceOf(Erc6492Error);
  expect(error.reason).toBe(reason);
};

describe("erc6492 wrapper", () => {
  it("round-trips factory, calldata and inner signature", () => {
    const wrapped = wrapErc6492Signature({factory: factory.toLowerCase(), factoryCalldata}, innerSignature);
    expect(wrapped.endsWith(ERC6492_MAGIC.slice(2))).toBe(true);
    expect(isErc6492Signature(wrapped)).toBe(true);
    expect(isErc6492Signature(wrapped.toUpperCase().replace("0X", "0x"))).toBe(true);
    const unwrapped = unwrapErc6492Signature(wrapped);
    expect(unwrapped.deployment.factory).toBe(ethers.utils.getAddress(factory)); // checksummed
    expect(unwrapped.deployment.factoryCalldata).toBe(factoryCalldata);
    expect(unwrapped.signature).toBe(innerSignature);
  });

  it("does not detect plain signatures", async () => {
    const ecdsa = await ethers.Wallet.createRandom().signMessage("hello");
    expect(ethers.utils.hexDataLength(ecdsa)).toBe(65);
    expect(isErc6492Signature(ecdsa)).toBe(false);
    expect(isErc6492Signature("0x")).toBe(false);
    expect(isErc6492Signature(innerSignature)).toBe(false);
    expect(isErc6492Signature("not hex" + ERC6492_MAGIC.slice(2))).toBe(false);
  });

  it("rejects a magic suffix on data that is not a wrapper", () => {
    for (const signature of [ERC6492_MAGIC, "0x1234" + ERC6492_MAGIC.slice(2), "0x123" + ERC6492_MAGIC.slice(2)]) {
      expect(isErc6492Signature(signature)).toBe(true);
      expect(() => unwrapErc6492Signature(signature)).toThrow(Erc6492Error);
      try {
        unwrapErc6492Signature(signature);
      } catch (e) {
        expect((e as Erc6492Error).reason).toBe("malformed");
      }
    }
  });
});

describe("erc6492 simulation", () => {
  const multicall3 = "0x000000000000000000000000000000000000ca11";
  let sent: {method: string; params: unknown[]}[];
  let answer: () => Promise<unknown>;
  const provider: CodeAndCallProvider = {
    getCode: async (address: string) => (address.toLowerCase() === multicall3 ? "0x6080" : "0x"),
    send: async (method: string, params: unknown[]) => {
      sent.push({method, params});
      return answer();
    },
  };

  beforeEach(() => {
    sent = [];
    answer = async () => aggregate3Result([[true, "0x"], [true, magicResult]]);
  });

  it("detects code", async () => {
    expect(await hasCode(provider, multicall3)).toBe(true);
    expect(await hasCode(provider, account)).toBe(false);
    expect(await hasCode({...provider, getCode: async () => "0x0"}, account)).toBe(false);
    expect(await isMulticall3Deployed(provider, multicall3)).toBe(true);
    expect(await isMulticall3Deployed(provider, MULTICALL3_ADDRESS)).toBe(false);
  });

  it("deploys then calls isValidSignature in one aggregate3 eth_call", async () => {
    expect(await simulateIsValidSignature(provider, multicall3, deployment, account, hash, innerSignature)).toBe(true);
    expect(sent).toHaveLength(1);
    expect(sent[0].method).toBe("eth_call");
    const [tx, blockTag] = sent[0].params as [{to: string; data: string}, string];
    expect(tx.to).toBe(multicall3);
    expect(blockTag).toBe("latest");
    const [calls] = MULTICALL3.decodeFunctionData("aggregate3", tx.data);
    expect(calls).toHaveLength(2);
    expect(calls[0].target).toBe(factory);
    expect(calls[0].allowFailure).toBe(false);
    expect(calls[0].callData).toBe(factoryCalldata);
    expect(calls[1].target).toBe(account);
    expect(calls[1].allowFailure).toBe(true);
    const [callHash, callSignature] = EIP1271.decodeFunctionData("isValidSignature", calls[1].callData);
    expect(callHash).toBe(hash);
    expect(callSignature).toBe(innerSignature);
  });

  it("answers false unless the account returns the EIP-1271 magic value", async () => {
    const wrong = EIP1271.encodeFunctionResult("isValidSignature", ["0xffffffff"]);
    answer = async () => aggregate3Result([[true, "0x"], [true, wrong]]);
    expect(await simulateIsValidSignature(provider, multicall3, deployment, account, hash, innerSignature)).toBe(false);
    answer = async () => aggregate3Result([[true, "0x"], [false, "0x"]]); // isValidSignature reverted
    expect(await simulateIsValidSignature(provider, multicall3, deployment, account, hash, innerSignature)).toBe(false);
  });

  it("reports an account left without code (empty answer) as no-result", async () => {
    answer = async () => aggregate3Result([[true, "0x"], [true, "0x"]]);
    await expectErc6492Error(simulateIsValidSignature(provider, multicall3, deployment, account, hash, innerSignature), "no-result");
  });

  it("reports a reverted factory call as deploy-failed", async () => {
    answer = async () => { throw nodeError("execution reverted: Multicall3: call failed"); };
    await expectErc6492Error(simulateIsValidSignature(provider, multicall3, deployment, account, hash, innerSignature), "deploy-failed");
    await expectErc6492Error(simulateGetOwners(provider, multicall3, deployment, account), "deploy-failed");
  });

  it("lets transport failures and unexpected answers through as plain errors", async () => {
    const timeout = Object.assign(new Error("timeout"), {code: "TIMEOUT"});
    answer = async () => { throw timeout; };
    await expect(simulateIsValidSignature(provider, multicall3, deployment, account, hash, innerSignature)).rejects.toBe(timeout);
    answer = async () => "0x1234";
    const error = await simulateIsValidSignature(provider, multicall3, deployment, account, hash, innerSignature).catch((e) => e);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(Erc6492Error);
  });

  it("reads the owners of the deployed account, lower case", async () => {
    const owners = [ethers.Wallet.createRandom().address, ethers.Wallet.createRandom().address];
    answer = async () => aggregate3Result([[true, "0x"], [true, SAFE_OWNERS.encodeFunctionResult("getOwners", [owners])]]);
    expect(await simulateGetOwners(provider, multicall3, deployment, account)).toEqual(owners.map((o) => o.toLowerCase()));
    const [calls] = MULTICALL3.decodeFunctionData("aggregate3", (sent[0].params[0] as {data: string}).data);
    expect(calls[1].target).toBe(account);
    expect(calls[1].callData).toBe(SAFE_OWNERS.getSighash("getOwners"));
  });

  it("reports no owners answer as no-result", async () => {
    answer = async () => aggregate3Result([[true, "0x"], [true, "0x"]]);
    await expectErc6492Error(simulateGetOwners(provider, multicall3, deployment, account), "no-result");
    answer = async () => aggregate3Result([[true, "0x"], [false, "0x"]]);
    await expectErc6492Error(simulateGetOwners(provider, multicall3, deployment, account), "no-result");
    answer = async () => aggregate3Result([[true, "0x"], [true, "0x1234"]]);
    await expectErc6492Error(simulateGetOwners(provider, multicall3, deployment, account), "no-result");
  });
});

// A JSON-RPC provider answering from in-memory state, so ethers (and siwe's EIP-1271 check) run unchanged.
class FakeChain extends ethers.providers.StaticJsonRpcProvider {
  public code = new Map<string, string>();
  public calls: {to: string; data: string}[] = [];
  public onCall: (tx: {to: string; data: string}) => Promise<string> = async () => "0x";

  constructor() {
    super("http://fake-chain.invalid", {chainId: CHAIN_ID, name: "sepolia"});
  }

  async send(method: string, params: any[]): Promise<any> {
    switch (method) {
      case "eth_chainId":
        return ethers.utils.hexValue(CHAIN_ID);
      case "net_version":
        return CHAIN_ID.toString();
      case "eth_getCode":
        return this.code.get(params[0].toLowerCase()) ?? "0x";
      case "eth_call":
        this.calls.push(params[0]);
        return this.onCall(params[0]);
      default:
        throw new Error(`unexpected ${method}`);
    }
  }
}

describe("SIWE verification and owner lookup", () => {
  const chain = new FakeChain();
  const network = Object.assign(Object.create(Network.prototype), {
    name: "sepolia",
    chainId: CHAIN_ID,
    jsonRPCProvider: chain,
    multicall3: MULTICALL3_ADDRESS,
  }) as Network;
  Network.instances.add(network);

  const owner = ethers.Wallet.createRandom();
  const stranger = ethers.Wallet.createRandom();
  const fetchStatement = "I request to retrieve all Social Recovery Module alert subscriptions linked to my account";

  const siweMessage = (address: string, statement: string) => new SiweMessage({
    domain: "example.com",
    address,
    statement,
    uri: "https://example.com",
    chainId: CHAIN_ID,
    version: "1",
    nonce: Math.random().toString(36).substring(2),
    issuedAt: new Date().toISOString(),
  });

  beforeEach(() => {
    chain.code = new Map([[MULTICALL3_ADDRESS.toLowerCase(), "0x6080"]]);
    chain.calls = [];
    chain.onCall = async () => "0x";
    (network as unknown as {counterfactualSupport?: Promise<boolean>}).counterfactualSupport = undefined;
  });

  const aggregate3Calls = () => chain.calls
    .filter((tx) => tx.to.toLowerCase() === MULTICALL3_ADDRESS.toLowerCase())
    .map((tx) => MULTICALL3.decodeFunctionData("aggregate3", tx.data)[0]);

  describe("validateSIWEMessage (self mode)", () => {
    it("verifies an unwrapped signature as before", async () => {
      const message = siweMessage(owner.address, fetchStatement);
      const signature = await owner.signMessage(message.prepareMessage());
      expect(await validateSIWEMessage(message.toMessage(), owner.address, CHAIN_ID, fetchStatement, signature)).toEqual({counterfactual: false});
      expect(chain.calls).toHaveLength(0);
    });

    it("rejects an unwrapped signature of an undeployed account", async () => {
      const message = siweMessage(account, fetchStatement);
      await expect(validateSIWEMessage(message.toMessage(), account, CHAIN_ID, fetchStatement, innerSignature))
        .rejects.toMatchObject({statusCode: 403, message: expect.stringContaining("invalid signature")});
    });

    it("verifies a wrapped signature of an undeployed account in simulation", async () => {
      const message = siweMessage(account, fetchStatement);
      chain.onCall = async () => aggregate3Result([[true, "0x"], [true, magicResult]]);
      const result = await validateSIWEMessage(
        message.toMessage(), account, CHAIN_ID, fetchStatement, wrapErc6492Signature(deployment, innerSignature)
      );
      expect(result).toEqual({counterfactual: true});
      const [calls] = aggregate3Calls();
      expect(calls[0].target).toBe(factory);
      expect(calls[0].callData).toBe(factoryCalldata);
      expect(calls[1].target).toBe(account);
      const [callHash, callSignature] = EIP1271.decodeFunctionData("isValidSignature", calls[1].callData);
      expect(callHash).toBe(ethers.utils.hashMessage(message.prepareMessage())); // what siwe passes for a deployed account
      expect(callSignature).toBe(innerSignature);
    });

    it("answers 403 when the simulated account rejects the signature", async () => {
      chain.onCall = async () => aggregate3Result([[true, "0x"], [false, "0x"]]);
      const message = siweMessage(account, fetchStatement);
      await expect(validateSIWEMessage(
        message.toMessage(), account, CHAIN_ID, fetchStatement, wrapErc6492Signature(deployment, innerSignature)
      )).rejects.toMatchObject({statusCode: 403, message: expect.stringContaining("invalid signature")});
    });

    it("answers 400 when the deployment data does not deploy the account", async () => {
      for (const onCall of [
        async () => { throw nodeError("execution reverted: Multicall3: call failed"); }, // the factory call reverted
        async () => aggregate3Result([[true, "0x"], [true, "0x"]]), // it deployed something else
      ]) {
        chain.onCall = onCall;
        const message = siweMessage(account, fetchStatement);
        await expect(validateSIWEMessage(
          message.toMessage(), account, CHAIN_ID, fetchStatement, wrapErc6492Signature(deployment, innerSignature)
        )).rejects.toMatchObject({
          statusCode: 400,
          message: `SIWE Message: the ERC-6492 deployment data does not deploy ${account} on chain ${CHAIN_ID}`,
        });
      }
    });

    it("answers 400 on a malformed wrapper", async () => {
      const message = siweMessage(account, fetchStatement);
      await expect(validateSIWEMessage(message.toMessage(), account, CHAIN_ID, fetchStatement, "0x1234" + ERC6492_MAGIC.slice(2)))
        .rejects.toMatchObject({statusCode: 400, message: "SIWE Message: malformed ERC-6492 signature"});
    });

    it("answers 400 on a network without Multicall3", async () => {
      chain.code.delete(MULTICALL3_ADDRESS.toLowerCase());
      const message = siweMessage(account, fetchStatement);
      await expect(validateSIWEMessage(
        message.toMessage(), account, CHAIN_ID, fetchStatement, wrapErc6492Signature(deployment, innerSignature)
      )).rejects.toMatchObject({
        statusCode: 400,
        message: `ERC-6492 signatures are not supported on this network (${CHAIN_ID}): Multicall3 is not deployed at ${MULTICALL3_ADDRESS}`,
      });
      expect(aggregate3Calls()).toHaveLength(0);
    });

    it("ignores the deployment data once the account is deployed", async () => {
      chain.code.set(account.toLowerCase(), "0x6080");
      // the deployed account accepts the inner signature through EIP-1271, as siwe checks it
      chain.onCall = async (tx) => {
        const [, signature] = EIP1271.decodeFunctionData("isValidSignature", tx.data);
        return tx.to.toLowerCase() === account.toLowerCase() && signature === innerSignature ? magicResult : "0x";
      };
      const message = siweMessage(account, fetchStatement);
      const result = await validateSIWEMessage(
        message.toMessage(), account, CHAIN_ID, fetchStatement, wrapErc6492Signature(deployment, innerSignature)
      );
      expect(result).toEqual({counterfactual: false});
      expect(aggregate3Calls()).toHaveLength(0); // no factory call against a deployed account
    });

    it("still checks the SIWE message first", async () => {
      const message = siweMessage(account, "another statement");
      await expect(validateSIWEMessage(
        message.toMessage(), account, CHAIN_ID, fetchStatement, wrapErc6492Signature(deployment, innerSignature)
      )).rejects.toMatchObject({statusCode: 400, message: expect.stringContaining("invalid message statement")});
      expect(chain.calls).toHaveLength(0);
    });
  });

  describe("validateOwnerSIWEMessage (owner mode)", () => {
    it("verifies an unwrapped owner signature and returns no deployment", async () => {
      const message = siweMessage(owner.address, fetchStatement);
      const signature = await owner.signMessage(message.prepareMessage());
      expect(await validateOwnerSIWEMessage(message.toMessage(), owner.address, CHAIN_ID, fetchStatement, signature))
        .toEqual({deployment: undefined});
    });

    it("unwraps the account's deployment data and verifies the owner's inner signature", async () => {
      const message = siweMessage(owner.address, fetchStatement);
      const signature = await owner.signMessage(message.prepareMessage());
      const result = await validateOwnerSIWEMessage(
        message.toMessage(), owner.address, CHAIN_ID, fetchStatement, wrapErc6492Signature(deployment, signature)
      );
      expect(result).toEqual({deployment: {factory, factoryCalldata}});
      expect(chain.calls).toHaveLength(0); // the deployment is not simulated here
    });

    it("rejects a wrapped signature of another signer", async () => {
      const message = siweMessage(owner.address, fetchStatement);
      const signature = await stranger.signMessage(message.prepareMessage());
      await expect(validateOwnerSIWEMessage(
        message.toMessage(), owner.address, CHAIN_ID, fetchStatement, wrapErc6492Signature(deployment, signature)
      )).rejects.toMatchObject({statusCode: 403, message: expect.stringContaining("invalid signature")});
    });
  });

  describe("fetchAccountOwners / requireAccountOwner", () => {
    const owners = [owner.address, ethers.Wallet.createRandom().address];
    const ownersResult = SAFE_OWNERS.encodeFunctionResult("getOwners", [owners]);
    const lowerOwners = owners.map((o) => o.toLowerCase());

    it("reads the owners of a deployed account on chain", async () => {
      chain.code.set(account.toLowerCase(), "0x6080");
      chain.onCall = async (tx) => (tx.to.toLowerCase() === account.toLowerCase() ? ownersResult : "0x");
      expect(await fetchAccountOwners(network, account, deployment)).toEqual({owners: lowerOwners, deployed: true});
      expect(aggregate3Calls()).toHaveLength(0);
    });

    it("answers 400 when a deployed account does not answer getOwners()", async () => {
      chain.code.set(account.toLowerCase(), "0x6080");
      await expect(fetchAccountOwners(network, account)).rejects.toMatchObject({
        statusCode: 400,
        message: `Unable to fetch owners for account '${account}' on chain ${CHAIN_ID}: it does not answer getOwners()`,
      });
    });

    it("answers 400 for an undeployed account without deployment data", async () => {
      await expect(fetchAccountOwners(network, account)).rejects.toMatchObject({
        statusCode: 400,
        message: expect.stringContaining("the account is not deployed. Wrap the signature with the account's ERC-6492 deployment data"),
      });
      expect(chain.calls).toHaveLength(0);
    });

    it("reads the owners of an undeployed account in simulation", async () => {
      chain.onCall = async () => aggregate3Result([[true, "0x"], [true, ownersResult]]);
      expect(await requireAccountOwner(network, account, owner.address, deployment)).toEqual({owners: lowerOwners, deployed: false});
      await expect(requireAccountOwner(network, account, stranger.address, deployment)).rejects.toMatchObject({
        statusCode: 403,
        message: "Owner must be a valid owner for the account provided",
      });
    });

    it("answers 400 when the deployment data does not deploy the account", async () => {
      chain.onCall = async () => aggregate3Result([[true, "0x"], [true, "0x"]]);
      await expect(fetchAccountOwners(network, account, deployment)).rejects.toMatchObject({
        statusCode: 400,
        message: `Unable to fetch owners for account '${account}' on chain ${CHAIN_ID}: the ERC-6492 deployment data does not deploy it`,
      });
    });

    it("answers 400 on a network without Multicall3", async () => {
      chain.code.delete(MULTICALL3_ADDRESS.toLowerCase());
      await expect(fetchAccountOwners(network, account, deployment)).rejects.toMatchObject({
        statusCode: 400,
        message: expect.stringContaining("ERC-6492 signatures are not supported on this network"),
      });
    });
  });

  describe("Network.supportsCounterfactual", () => {
    it("checks Multicall3 once, and again after a failed check", async () => {
      const getCode = jest.spyOn(chain, "getCode");
      try {
        expect(await Promise.all([network.supportsCounterfactual(), network.supportsCounterfactual()])).toEqual([true, true]);
        expect(await network.supportsCounterfactual()).toBe(true);
        expect(getCode).toHaveBeenCalledTimes(1);
        expect(getCode).toHaveBeenCalledWith(MULTICALL3_ADDRESS);

        (network as unknown as {counterfactualSupport?: Promise<boolean>}).counterfactualSupport = undefined;
        getCode.mockRejectedValueOnce(new Error("rpc down"));
        await expect(network.supportsCounterfactual()).rejects.toThrow("rpc down");
        expect(await network.supportsCounterfactual()).toBe(true); // retried
        expect(getCode).toHaveBeenCalledTimes(3);
      } finally {
        getCode.mockRestore();
      }
    });
  });
});
