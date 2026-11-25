// The chain executor's gas limit cap, the failure reason its callbacks get and the context its failure listeners get
// (src/services/chain-executor.service.ts): no database, no chain. The network's provider is a fake, the signer a random
// key, and the gas helper (populateTxGasPricesAndLimits) answers the gas limits each test sets.
import {ethers} from "ethers";
import {Network} from "../src/models/network";
import {Signers} from "../src/models/signer/signers";
import {Signer} from "../src/models/signer/signer";
import {ChainExecutor, ChainExecutorFailureReason, FailedTransaction} from "../src/services/chain-executor.service";

// The gas limit of each populated transaction, in order; the last one is reused.
let mockGasLimits: number[] = [];
const mockPopulate = jest.fn();
jest.mock("../src/utils", () => ({
  ...jest.requireActual("../src/utils"),
  populateTxGasPricesAndLimits: (...args: unknown[]) => mockPopulate(...args),
}));

// Every log line, as {level, fields, message}.
const mockLogLines: {level: string, fields: Record<string, unknown>, message?: string}[] = [];
jest.mock("../src/utils/logger", () => {
  const make = (bindings: Record<string, unknown>): unknown => {
    const write = (level: string) => (fields: Record<string, unknown> | string, message?: string) => {
      mockLogLines.push(typeof fields === "string" ? {level, fields: {...bindings}, message: fields} : {level, fields: {...bindings, ...fields}, message});
    };
    return {
      child: (more: Record<string, unknown>) => make({...bindings, ...more}),
      trace: write("trace"), debug: write("debug"), info: write("info"), warn: write("warn"), error: write("error"), fatal: write("fatal"),
      flush: () => undefined,
    };
  };
  return {__esModule: true, default: make({})};
});

const CHAIN_ID = 11155111;
const NONCE = 5;
const wallet = ethers.Wallet.createRandom();
const TO = ethers.Wallet.createRandom().address.toLowerCase();
const CALL_DATA = "0x1688f0b9" + "cd".repeat(64);

type Receipt = {status: number, transactionHash: string};
// What waitForTransaction does for the n-th broadcast (by order of broadcast).
let waits: ((hash: string) => Promise<Receipt>)[] = [];
const sendTransaction = jest.fn(async (_signed: string) => ({}));
const provider = {
  getTransactionCount: jest.fn(async () => NONCE),
  sendTransaction,
  getTransactionReceipt: jest.fn(async () => null),
  waitForTransaction: jest.fn(async (hash: string): Promise<Receipt> => {
    const index: number = sendTransaction.mock.calls.findIndex(([signed]: [string]) => ethers.utils.keccak256(signed) === hash);
    return (waits[index] ?? mined)(hash);
  }),
};
const mined = async (hash: string): Promise<Receipt> => ({status: 1, transactionHash: hash});
const reverted = async (hash: string): Promise<Receipt> => ({status: 0, transactionHash: hash});
const timeout = async (): Promise<Receipt> => {
  throw Object.assign(new Error("timeout exceeded"), {code: ethers.errors.TIMEOUT});
};

// A network without its constructor (which starts an indexer), and the signer.
Network.instances.add(Object.assign(Object.create(Network.prototype) as Network, {chainId: CHAIN_ID, name: "test", jsonRPCProvider: provider}));
let signers = 0;
const newSigner = () => {
  const id = `signer-${++signers}`;
  Signers.instance().addSigner({
    id,
    signer: async () => wallet.address,
    sign: async (hash: string) => ethers.utils.joinSignature(wallet._signingKey().signDigest(hash)),
    healthCheck: async () => true,
  } as unknown as Signer);
  return id;
};

const failures: FailedTransaction[] = [];
ChainExecutor.addFailureListener((failure) => failures.push(failure));

type Outcome = [boolean, string, ChainExecutorFailureReason | undefined];
// Adds a transaction and resolves with what its callback received.
const send = (signerId: string, extra: {maxGasLimit?: number, context?: {action: string, account?: string}} = {}) =>
  new Promise<Outcome>((resolve) => {
    ChainExecutor.instance().addTransaction({
      to: TO,
      callData: CALL_DATA,
      value: 0n,
      chainId: CHAIN_ID,
      signerId,
      ...extra,
      callback: async (success, transactionHash, reason) => resolve([success, transactionHash, reason]),
    });
  });
const broadcastHash = (n: number) => ethers.utils.keccak256(provider.sendTransaction.mock.calls[n][0]);

beforeEach(() => {
  mockGasLimits = [100_000];
  mockPopulate.mockReset().mockImplementation(async (_network: Network, _sender: string, to: string, value: bigint, data: string, nonce: number) => {
    const gasLimit = mockGasLimits.length > 1 ? mockGasLimits.shift()! : mockGasLimits[0];
    return {
      type: 2, to, data, chainId: CHAIN_ID, nonce, value: ethers.utils.hexValue(value),
      gasLimit: ethers.utils.hexValue(gasLimit), maxFeePerGas: "0x3b9aca00", maxPriorityFeePerGas: "0x3b9aca00",
    };
  });
  provider.sendTransaction.mockClear();
  waits = [];
  failures.length = 0;
  mockLogLines.length = 0;
});

describe("chain executor", () => {
  test("a first broadcast that is mined calls back (true, hash) with no reason", async () => {
    const [success, hash, reason] = await send(newSigner(), {maxGasLimit: 200_000});
    expect(success).toBe(true);
    expect(hash).toBe(broadcastHash(0));
    expect(reason).toBeUndefined();
    expect(provider.sendTransaction).toHaveBeenCalledTimes(1);
    expect(failures).toEqual([]);
  });

  test("a gas limit above maxGasLimit fails as gas-limit-exceeded, unsent, and the queue moves on", async () => {
    const signerId = newSigner();
    mockGasLimits = [200_001, 100_000];
    const context = {action: "deploy", account: TO};
    const capped = send(signerId, {maxGasLimit: 200_000, context});
    const next = send(signerId, {maxGasLimit: 200_000});
    expect(await capped).toEqual([false, "", "gas-limit-exceeded"]);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({reason: "gas-limit-exceeded", nonceResolved: true, nonce: undefined, hashes: undefined, context});
    // the transaction queued behind it is sent
    const [success, hash] = await next;
    expect(success).toBe(true);
    expect(provider.sendTransaction).toHaveBeenCalledTimes(1);
    expect(hash).toBe(broadcastHash(0));
  });

  test("a limit at maxGasLimit is sent", async () => {
    mockGasLimits = [200_000];
    expect((await send(newSigner(), {maxGasLimit: 200_000}))[0]).toBe(true);
  });

  test("a replacement is not checked against the cap: it reuses the first limit", async () => {
    // the first broadcast times out and is replaced at the same nonce; the gas helper would answer a higher limit
    mockGasLimits = [150_000, 250_000];
    waits = [timeout, mined];
    const [success, hash] = await send(newSigner(), {maxGasLimit: 200_000});
    expect(success).toBe(true);
    expect(provider.sendTransaction).toHaveBeenCalledTimes(2);
    expect(hash).toBe(broadcastHash(1));
    // the replacement was populated with the first broadcast's limit as its override
    expect(mockPopulate.mock.calls[1][7]).toBe(ethers.utils.hexValue(150_000));
    expect(mockPopulate.mock.calls[1][5]).toBe(NONCE);
  });

  test("the callback gets the reason of a would-revert", async () => {
    mockPopulate.mockReset().mockRejectedValue(
      Object.assign(new Error("cannot estimate gas"), {code: ethers.errors.UNPREDICTABLE_GAS_LIMIT})
    );
    expect(await send(newSigner())).toEqual([false, "", "would-revert"]);
    expect(provider.sendTransaction).not.toHaveBeenCalled();
    expect(failures[0].context).toBeUndefined();
  });

  test("the callback gets the reason and hash of a mined revert, and the listener the context", async () => {
    waits = [reverted];
    const context = {action: "deploy", account: TO};
    const [success, hash, reason] = await send(newSigner(), {context});
    expect([success, reason]).toEqual([false, "reverted"]);
    expect(hash).toBe(broadcastHash(0));
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({reason: "reverted", nonce: NONCE, nonceResolved: true, hashes: [hash], context});
  });

  test("the executor's own log lines carry neither the destination nor the call data", async () => {
    mockGasLimits = [300_000];
    await send(newSigner(), {maxGasLimit: 200_000, context: {action: "deploy", account: TO}});
    waits = [reverted];
    await send(newSigner());
    expect(mockLogLines.length).toBeGreaterThan(0);
    const logged = JSON.stringify(mockLogLines, (_key, value) => value instanceof Error ? value.message : value).toLowerCase();
    expect(logged).not.toContain(TO.slice(2));
    expect(logged).not.toContain(CALL_DATA.slice(10, 40));
  });
});
