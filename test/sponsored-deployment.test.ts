// The sponsored deployment of undeployed accounts (POST /v1/auth/accounts/deploy, GET /v1/auth/accounts/deployment): the
// configuration (parseDeployAccounts and the boot checks), the rules of src/utils/sponsored-deployment.ts, and the
// service against in-memory tables, a fake chain and a mocked chain executor and fee estimator. No database, no chain,
// no app boot. The last block runs against real contracts (read-only eth_calls) only when JSON_RPC_NODE_PROVIDER_1 is
// set (.env is read); the whole flow over HTTP, which sends a transaction, is in test/auth.test.ts.
import * as dotenv from "dotenv";
import {ethers} from "ethers";
import {DEFAULT_DEPLOY_ACCOUNTS_MAX_GAS, EnabledDeployAccounts, parseDeployAccounts} from "../src/config/config-manager";
import {isSensitiveKey} from "../src/logging";
import {Network} from "../src/models/network";
import {Signers} from "../src/models/signer/signers";
import {Signer} from "../src/models/signer/signer";
import {ApiError} from "../src/utils/error";
import {AccountDeployment, Erc6492Error, MULTICALL3_ADDRESS, SimulatedCall, simulateDeploymentReads} from "../src/utils/erc6492";
import {ACCOUNT_INIT_DATA_MAX_BYTES, guardianSetupModule, guardianSetupReads} from "../src/utils/account-init-data";
import {hashVerifiedTargetToken, newVerifiedTargetToken} from "../src/utils/target-verification";
import {
  deploymentAnswer,
  deploymentProbe,
  deploymentView,
  nextStep,
  probeAnswered,
  reachedLimit,
  requesterHash,
  senderCheck,
  SPONSORED_DEPLOYMENT_GAS_FACTOR,
  SPONSORED_DEPLOYMENT_MAX_ATTEMPTS,
  SPONSORED_DEPLOYMENT_PENDING_MAX_MS,
  SponsoredDeploymentRow,
  storedInitData,
} from "../src/utils/sponsored-deployment";
import {ChainExecutor} from "../src/services/chain-executor.service";
import {GasPriceEstimator} from "../src/services/gas-price-estimator.service";
import {
  countSponsoredDeployments,
  deployAccount,
  fetchDeployment,
  releaseOrphanedDeployments,
  sponsoredDeploymentAvailable,
} from "../src/services/sponsored-deployment.service";
import {guardianDeployment, plainDeployment, SAFE_PROXY_FACTORY_1_4_1, STAND_IN_CONTRACTS} from "./guardian-deployment";

dotenv.config();

// In-memory tables for the queries the services make (plain values, equals, not, in, gt/gte/lt), with the unique
// (account, chainId) of SponsoredDeployment (a second create throws P2002). Each call runs to completion before the
// next, like one SQL statement, so parallel requests interleave between calls only.
const mockTables: Record<string, any[]> = {};
// Queued hooks: the next call of the table's method that matches first runs `before` (a write made by someone else in
// between), then throws `error` when there is one (each entry once).
const mockHooks: {table: string, method: string, before?: () => void, error?: Error}[] = [];
jest.mock("../src/config/prisma-client", () => {
  const {Prisma} = jest.requireActual("@prisma/client");
  const satisfies = (value: any, condition: any): boolean => {
    if (condition === null || typeof condition !== "object" || condition instanceof Date) {
      return condition instanceof Date ? value?.getTime() === condition.getTime() : value === condition;
    }
    return Object.entries(condition).every(([operator, operand]: [string, any]) => {
      switch (operator) {
        case "equals": return value === operand;
        case "not": return value !== operand;
        case "in": return operand.includes(value);
        case "gt": return value > operand;
        case "gte": return value >= operand;
        case "lt": return value < operand;
        default: throw new Error(`unsupported operator ${operator}`);
      }
    });
  };
  const matches = (row: any, where: Record<string, any> = {}) => Object.entries(where).every(([key, condition]) => satisfies(row[key], condition));
  let nextId = 1;
  const unique: Record<string, string[]> = {sponsoredDeployment: ["account", "chainId"]};
  const table = (name: string) => {
    const rows = () => (mockTables[name] ??= []);
    const filter = (where: any) => rows().filter((row) => matches(row, where));
    const methods: Record<string, (args: any) => Promise<any>> = {
      findFirst: async ({where}: any) => filter(where)[0] ?? null,
      findUnique: async ({where}: any) => filter(where)[0] ?? null,
      findMany: async ({where}: any) => filter(where),
      count: async ({where}: any) => filter(where).length,
      create: async ({data}: any) => {
        const keys = unique[name];
        if (keys && rows().some((row) => keys.every((key) => row[key] === data[key]))) {
          throw new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {code: "P2002", clientVersion: "test"});
        }
        const row = {id: `${name}-${nextId++}`, transactionHash: null, failureReason: null, createdAt: new Date(), updatedAt: new Date(), ...data};
        rows().push(row);
        return row;
      },
      updateMany: async ({where, data}: any) => {
        const found = filter(where);
        for (const row of found) Object.assign(row, data, {updatedAt: new Date()});
        return {count: found.length};
      },
    };
    return Object.fromEntries(Object.entries(methods).map(([method, call]) => [method, async (args: any) => {
      const hook = mockHooks.findIndex((h) => h.table === name && h.method === method);
      if (hook >= 0) {
        const {before, error} = mockHooks.splice(hook, 1)[0];
        before?.();
        if (error) throw error;
      }
      return call(args);
    }]));
  };
  return {prisma: new Proxy({}, {get: (_target, name: string) => table(name)})};
});

// Every log line, as {level, bindings of the child logger, fields, message}.
const mockLogLines: {level: string, bindings: Record<string, unknown>, fields: Record<string, unknown>, message?: string}[] = [];
jest.mock("../src/utils/logger", () => {
  const make = (bindings: Record<string, unknown>): unknown => {
    const write = (level: string) => (fields: Record<string, unknown> | string, message?: string) => {
      mockLogLines.push(typeof fields === "string" ? {level, bindings, fields: {}, message: fields} : {level, bindings, fields, message});
    };
    return {
      child: (more: Record<string, unknown>) => make({...bindings, ...more}),
      trace: write("trace"), debug: write("debug"), info: write("info"), warn: write("warn"), error: write("error"), fatal: write("fatal"),
      flush: () => undefined,
    };
  };
  return {__esModule: true, default: make({})};
});

const linesWith = (message: string) => mockLogLines.filter((line) => line.message === message);

const FACTORY = "0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67";
const OTHER_FACTORY = "0xcA11bde05977b3631167028862bE2a173976CA11";

describe("parseDeployAccounts", () => {
  const ENABLED = {enabled: true, signer: "deployer", factories: [FACTORY]};
  const parse = (value: unknown) => parseDeployAccounts("sepolia", value);

  test.each([
    ["omitted", undefined],
    ["null", null],
    ["~", "~"],
    ["enabled false", {enabled: false}],
    ["enabled 'false'", {enabled: "FALSE"}],
    ["enabled omitted", {signer: "deployer"}],
    ["enabled false with nothing else valid", {enabled: false, signer: 1, factories: "nope", maxGas: -1, rateLimit: 5}],
  ])("reads %s as disabled", (_name, value) => {
    expect(parse(value)).toEqual({enabled: false});
  });

  test("takes an enabled block with its defaults: requireGuardian true, maxGas 1000000, no rate limit", () => {
    expect(DEFAULT_DEPLOY_ACCOUNTS_MAX_GAS).toBe(1_000_000);
    expect(parse(ENABLED)).toEqual({
      enabled: true, signer: "deployer", factories: [FACTORY.toLowerCase()], requireGuardian: true, maxGas: 1_000_000,
    });
  });

  test("takes every key, factories in lower case and the period in seconds", () => {
    expect(parse({
      ...ENABLED,
      factories: [FACTORY, OTHER_FACTORY],
      requireGuardian: false,
      maxGas: 600_000,
      rateLimit: {maxPerTarget: 2, maxTotal: 50, period: "1d"},
    })).toEqual({
      enabled: true,
      signer: "deployer",
      factories: [FACTORY.toLowerCase(), OTHER_FACTORY.toLowerCase()],
      requireGuardian: false,
      maxGas: 600_000,
      rateLimit: {maxPerTarget: 2, maxTotal: 50, period: 86400},
    });
  });

  test("takes booleans and numbers as strings (what ${ENV::VAR} yields)", () => {
    expect(parse({
      ...ENABLED,
      enabled: "True",
      requireGuardian: "false",
      maxGas: "750000",
      rateLimit: {maxPerTarget: "3", maxTotal: "40", period: "12h"},
    })).toEqual({
      enabled: true,
      signer: "deployer",
      factories: [FACTORY.toLowerCase()],
      requireGuardian: false,
      maxGas: 750_000,
      rateLimit: {maxPerTarget: 3, maxTotal: 40, period: 43200},
    });
  });

  test.each([
    ["only maxPerTarget", {maxPerTarget: 1, period: "1h"}, {maxPerTarget: 1, period: 3600}],
    ["only maxTotal", {maxTotal: 10, period: "30m"}, {maxTotal: 10, period: 1800}],
  ])("takes a rate limit with %s", (_name, rateLimit, expected) => {
    expect(parse({...ENABLED, rateLimit})).toMatchObject({rateLimit: expected});
  });

  test.each([["~"], [null], [undefined]])("reads rateLimit %p as no limit", (rateLimit) => {
    expect(parse({...ENABLED, rateLimit})).not.toHaveProperty("rateLimit");
  });

  test.each([
    ["a string", "on", "Network 'sepolia' 'deployAccounts' must be an object, or '~'."],
    ["a list", [ENABLED], "Network 'sepolia' 'deployAccounts' must be an object, or '~'."],
    ["a number", 1, "Network 'sepolia' 'deployAccounts' must be an object, or '~'."],
    ["an unknown key", {...ENABLED, factory: FACTORY}, "Network 'sepolia' deployAccounts has an unknown key 'factory'."],
    ["an unknown key while disabled", {enabled: false, maxPerTarget: 1}, "Network 'sepolia' deployAccounts has an unknown key 'maxPerTarget'."],
    ["enabled that is not a boolean", {...ENABLED, enabled: "yes"}, "Network 'sepolia' deployAccounts.enabled must be true or false."],
    ["enabled 1", {...ENABLED, enabled: 1}, "Network 'sepolia' deployAccounts.enabled must be true or false."],
    ["no signer", {...ENABLED, signer: undefined}, "Network 'sepolia' deployAccounts requires a 'signer' when enabled."],
    ["an empty signer", {...ENABLED, signer: " "}, "Network 'sepolia' deployAccounts requires a 'signer' when enabled."],
    ["a signer that is not a string", {...ENABLED, signer: 3}, "Network 'sepolia' deployAccounts requires a 'signer' when enabled."],
    ["no factories", {...ENABLED, factories: undefined}, "Network 'sepolia' deployAccounts.factories must be a non-empty list of factory addresses."],
    ["an empty factory list", {...ENABLED, factories: []}, "Network 'sepolia' deployAccounts.factories must be a non-empty list of factory addresses."],
    ["factories as a string", {...ENABLED, factories: FACTORY}, "Network 'sepolia' deployAccounts.factories must be a non-empty list of factory addresses."],
    ["a factory that is not an address", {...ENABLED, factories: [FACTORY, "0x1234"]}, "Network 'sepolia' deployAccounts.factories[1] must be a valid address."],
    ["a factory that is not a string", {...ENABLED, factories: [42]}, "Network 'sepolia' deployAccounts.factories[0] must be a valid address."],
    ["the zero address", {...ENABLED, factories: [ethers.constants.AddressZero]}, "Network 'sepolia' deployAccounts.factories[0] cannot be the zero address."],
    ["a factory listed twice, in another case", {...ENABLED, factories: [FACTORY, OTHER_FACTORY, FACTORY.toLowerCase()]}, "Network 'sepolia' deployAccounts.factories[2] is listed more than once."],
    ["requireGuardian that is not a boolean", {...ENABLED, requireGuardian: "yes"}, "Network 'sepolia' deployAccounts.requireGuardian must be true or false."],
    ["maxGas zero", {...ENABLED, maxGas: 0}, "Network 'sepolia' deployAccounts.maxGas must be a positive integer."],
    ["maxGas negative", {...ENABLED, maxGas: -1}, "Network 'sepolia' deployAccounts.maxGas must be a positive integer."],
    ["maxGas with a fraction", {...ENABLED, maxGas: 1.5}, "Network 'sepolia' deployAccounts.maxGas must be a positive integer."],
    ["maxGas as words", {...ENABLED, maxGas: "a lot"}, "Network 'sepolia' deployAccounts.maxGas must be a positive integer."],
    ["rateLimit as a number", {...ENABLED, rateLimit: 5}, "Network 'sepolia' deployAccounts.rateLimit must be an object with 'period' and 'maxPerTarget' and / or 'maxTotal', or '~'."],
    ["a rate limit without a period", {...ENABLED, rateLimit: {maxTotal: 5}}, "Network 'sepolia' deployAccounts.rateLimit requires a 'period', e.g. '1d'."],
    ["a rate limit with a bad period", {...ENABLED, rateLimit: {maxTotal: 5, period: "1 day"}}, "Network 'sepolia' deployAccounts.rateLimit.period must be a duration like '30m', '24h' or '1d'."],
    ["a rate limit with a zero period", {...ENABLED, rateLimit: {maxTotal: 5, period: "0s"}}, "Network 'sepolia' deployAccounts.rateLimit.period must be longer than zero."],
    ["a rate limit without a limit", {...ENABLED, rateLimit: {period: "1d"}}, "Network 'sepolia' deployAccounts.rateLimit requires 'maxPerTarget', 'maxTotal' or both."],
    ["a rate limit with maxPerTarget zero", {...ENABLED, rateLimit: {maxPerTarget: 0, period: "1d"}}, "Network 'sepolia' deployAccounts.rateLimit.maxPerTarget must be a positive integer."],
    ["a rate limit with a fractional maxTotal", {...ENABLED, rateLimit: {maxTotal: "2.5", period: "1d"}}, "Network 'sepolia' deployAccounts.rateLimit.maxTotal must be a positive integer."],
    ["a rate limit with an unknown key", {...ENABLED, rateLimit: {maxPerAccount: 2, period: "1d"}}, "Network 'sepolia' deployAccounts.rateLimit has an unknown key 'maxPerAccount'."],
  ])("rejects %s", (_name, value, message) => {
    expect(() => parse(value)).toThrow(message);
  });
});

describe("deployAccounts at boot", () => {
  const GUARDIAN_KEY = ethers.Wallet.createRandom().privateKey;
  const DEPLOYER_KEY = ethers.Wallet.createRandom().privateKey;
  // guardian: the network's guardian, null to leave the key out
  const config = (deployAccounts: unknown, {guardian = "guardian" as string | null, storeInitData = "always"} = {}) => ({
    options: {
      env: "development", port: 4337, indexerAlert: "alert", trustProxy: true, rateLimit: 1000,
      counterfactualAccounts: {storeInitData},
    },
    signers: [{id: "guardian", privateKey: GUARDIAN_KEY}, {id: "deployer", privateKey: DEPLOYER_KEY}],
    alerts: [{id: "alert", channels: {email: {webhook: {endpoint: "https://webhook.example.com/"}}}}],
    networks: {
      sepolia: {
        enabled: true,
        chainId: 11155111,
        jsonRpcEndpoint: "http://127.0.0.1:1",
        recoveryModules: [{address: "0x949d01d424bE050D09C16025dd007CB59b3A8c66", fallback: true, indexer: {enabled: false, startBlock: 0}}],
        ...(guardian === null ? {} : {guardian}),
        alerts: "alert",
        deployAccounts,
      },
    },
  });
  const ENABLED = {
    enabled: true, signer: "deployer", factories: [FACTORY], maxGas: 900000, rateLimit: {maxPerTarget: 2, maxTotal: 50, period: "1d"},
  };
  // a fresh Configuration (and Network) with the given network block; returns the network built
  const boot = (raw: Record<string, any>) => {
    let network: any;
    jest.isolateModules(() => {
      const {Configuration} = require("../src/config/config-manager");
      const {Network} = require("../src/models/network");
      Configuration.instance(raw);
      network = Network.instances.get("11155111");
    });
    return network;
  };

  beforeEach(() => {
    mockLogLines.length = 0;
  });

  test("a network without the block is not sponsored", () => {
    expect(boot(config(undefined)).deployAccounts).toEqual({enabled: false});
    expect(linesWith("account deployment sponsorship configured")).toEqual([]);
  });

  test("an enabled block is kept on the network and logged once, with no warning", () => {
    const network = boot(config(ENABLED));
    expect(network.deployAccounts).toEqual({
      enabled: true, signer: "deployer", factories: [FACTORY.toLowerCase()], requireGuardian: true, maxGas: 900000,
      rateLimit: {maxPerTarget: 2, maxTotal: 50, period: 86400},
    });
    expect(linesWith("account deployment sponsorship configured").map(({level, fields}) => ({level, fields}))).toEqual([{
      level: "info",
      fields: {
        network: "sepolia", chainId: 11155111, signerId: "deployer", factoryCount: 1, requireGuardian: true, maxGas: 900000,
        rateLimit: {maxPerTarget: 2, maxTotal: 50, period: 86400},
      },
    }]);
    expect(mockLogLines.filter((line) => line.level === "warn" && line.message?.startsWith("account deployment"))).toEqual([]);
  });

  test("a signer that is not declared fails the boot", () => {
    expect(() => boot(config({...ENABLED, signer: "nobody"})))
      .toThrow("Network 'sepolia' deployAccounts.signer is not found in declared signers.");
  });

  test.each([["~"], [null]])("a network without a guardian (%p) fails the boot", (guardian) => {
    expect(() => boot(config(ENABLED, {guardian})))
      .toThrow("Network 'sepolia' deployAccounts requires a 'guardian': without one nothing registers, so no init data is stored.");
  });

  test("a disabled block needs neither a declared signer nor a guardian", () => {
    expect(boot(config({enabled: false, signer: "nobody"}, {guardian: "~"})).deployAccounts).toEqual({enabled: false});
  });

  test("the guardian's key as the signer, no rate limit and no init data stored are warned about", () => {
    boot(config({enabled: true, signer: "guardian", factories: [FACTORY]}, {storeInitData: "never"}));
    expect(linesWith("account deployment signer is also the guardian")).toMatchObject([
      {level: "warn", fields: {network: "sepolia", chainId: 11155111, signerId: "guardian"}},
    ]);
    expect(linesWith("account deployment sponsorship has no rate limit")).toMatchObject([
      {level: "warn", fields: {network: "sepolia", chainId: 11155111}},
    ]);
    expect(linesWith("account deployment sponsorship enabled but no init data is stored")).toMatchObject([
      {level: "warn", fields: {network: "sepolia", chainId: 11155111}},
    ]);
    expect(linesWith("account deployment sponsorship configured")).toHaveLength(1);
  });
});

const CHAIN_ID = 11155111;
const MODULE_A = "0x38275826e1933303e508433dd5f289315da2541c"; // v0.1.0, 3 days
const MODULE_B = "0x00480f5ecc008995469fa7e12c70ef3dc9fee7fd"; // v0.2.0, 3 days
const GUARDIAN = "0x9999999999999999999999999999999999999999";
const DEPLOYER = ethers.Wallet.createRandom().address;
const FACTORY_CALLDATA = "0x1688f0b9" + "ab".repeat(100);
const TX_HASH = "0x" + "12".repeat(32);
const TRUE = ethers.utils.defaultAbiCoder.encode(["bool"], [true]);
const FALSE = ethers.utils.defaultAbiCoder.encode(["bool"], [false]);
const ONE = ethers.utils.defaultAbiCoder.encode(["uint256"], [1]);
const ZERO_WORD = ethers.utils.defaultAbiCoder.encode(["uint256"], [0]);
const MULTICALL3 = new ethers.utils.Interface([
  "function aggregate3((address target, bool allowFailure, bytes callData)[] calls) payable returns ((bool success, bytes returnData)[] returnData)",
]);
const encodeAddress = (address: string) => ethers.utils.defaultAbiCoder.encode(["address"], [address.toLowerCase()]);
const newAccount = () => ethers.utils.getAddress(ethers.utils.hexlify(ethers.utils.randomBytes(20)));
const lastOf = <T>(items: T[]): T => items[items.length - 1];

describe("sponsored deployment rules", () => {
  const ACCOUNT = "0xAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAa";

  test("storedInitData takes both reserved keys, a factory address and hex calldata up to the limit", () => {
    expect(storedInitData({label: "main", _factory: FACTORY.toLowerCase(), _factoryData: FACTORY_CALLDATA.toUpperCase().replace("0X", "0x")}))
      .toEqual({factory: FACTORY, factoryCalldata: FACTORY_CALLDATA});
    const atLimit = "0x" + "ab".repeat(ACCOUNT_INIT_DATA_MAX_BYTES);
    expect(storedInitData({_factory: FACTORY, _factoryData: atLimit})).toEqual({factory: FACTORY, factoryCalldata: atLimit});
    expect(storedInitData({_factory: FACTORY, _factoryData: atLimit + "ab"})).toBeUndefined();
  });

  test.each([
    ["no metadata", undefined],
    ["null", null],
    ["a list", [FACTORY, FACTORY_CALLDATA]],
    ["no _factory", {_factoryData: FACTORY_CALLDATA}],
    ["no _factoryData", {_factory: FACTORY}],
    ["a _factory that is not an address", {_factory: "0x1234", _factoryData: FACTORY_CALLDATA}],
    ["_factoryData that is not hex", {_factory: FACTORY, _factoryData: "calldata"}],
    ["_factoryData of an odd length", {_factory: FACTORY, _factoryData: "0xabc"}],
    ["_factoryData that is not a string", {_factory: FACTORY, _factoryData: 12}],
  ])("storedInitData answers undefined for %s", (_name, metadata) => {
    expect(storedInitData(metadata)).toBeUndefined();
  });

  test("the probe reads getThreshold() on the account, and is answered by 32 non-zero bytes only", () => {
    expect(deploymentProbe(ACCOUNT)).toEqual({target: ACCOUNT.toLowerCase(), callData: "0xe75235b8"});
    expect(probeAnswered({success: true, returnData: ONE})).toBe(true);
    expect(probeAnswered({success: true, returnData: ZERO_WORD})).toBe(false);
    expect(probeAnswered({success: false, returnData: ONE})).toBe(false);
    expect(probeAnswered({success: true, returnData: "0x"})).toBe(false);
    expect(probeAnswered({success: true, returnData: ONE + ONE.slice(2)})).toBe(false);
    expect(probeAnswered(undefined)).toBe(false);
  });

  test("senderCheck: match, mismatch, or unknown for anything but an address word", () => {
    expect(senderCheck(encodeAddress(ACCOUNT), ACCOUNT)).toBe("match");
    expect(senderCheck(encodeAddress(ACCOUNT).toUpperCase().replace("0X", "0x"), ACCOUNT.toLowerCase())).toBe("match");
    expect(senderCheck(encodeAddress(GUARDIAN), ACCOUNT)).toBe("mismatch");
    expect(senderCheck(encodeAddress(ACCOUNT) + "00".repeat(32), ACCOUNT)).toBe("unknown");
    expect(senderCheck("0x", ACCOUNT)).toBe("unknown");
    expect(senderCheck("0x" + "ff".repeat(32), ACCOUNT)).toBe("unknown");
    expect(senderCheck(undefined, ACCOUNT)).toBe("unknown");
  });

  test("requesterHash is stable, differs by channel and target, and is not the target", () => {
    const hash = requesterHash("email", "user@example.com");
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(requesterHash("email", "user@example.com")).toBe(hash);
    expect(requesterHash("sms", "user@example.com")).not.toBe(hash);
    expect(requesterHash("email", "other@example.com")).not.toBe(hash);
  });

  test("reachedLimit checks the target first, a count at its maximum reaching it", () => {
    const both = {maxPerTarget: 2, maxTotal: 5, period: 86400};
    expect(reachedLimit(undefined, {target: 100, total: 100})).toBeUndefined();
    expect(reachedLimit(both, {target: 1, total: 4})).toBeUndefined();
    expect(reachedLimit(both, {target: 2, total: 4})).toBe("target");
    expect(reachedLimit(both, {target: 1, total: 5})).toBe("total");
    expect(reachedLimit(both, {target: 2, total: 5})).toBe("target");
    expect(reachedLimit({maxPerTarget: 1, period: 60}, {target: 0, total: 1000})).toBeUndefined();
    expect(reachedLimit({maxPerTarget: 1, period: 60}, {target: 1, total: 0})).toBe("target");
    expect(reachedLimit({maxTotal: 3, period: 60}, {target: 1000, total: 2})).toBeUndefined();
    expect(reachedLimit({maxTotal: 3, period: 60}, {target: 0, total: 3})).toBe("total");
  });

  test("nextStep for every row state, stale at exactly 3 h", () => {
    const now = new Date("2026-11-25T12:00:00Z");
    const ago = (ms: number) => new Date(now.getTime() - ms);
    expect(SPONSORED_DEPLOYMENT_PENDING_MAX_MS).toBe(3 * 60 * 60 * 1000);
    expect(SPONSORED_DEPLOYMENT_MAX_ATTEMPTS).toBe(3);
    expect(nextStep(null, now)).toBe("create");
    expect(nextStep({status: "DEPLOYED", attempts: 3, requestedAt: ago(SPONSORED_DEPLOYMENT_PENDING_MAX_MS * 10)}, now)).toBe("answer");
    expect(nextStep({status: "PENDING", attempts: 1, requestedAt: ago(SPONSORED_DEPLOYMENT_PENDING_MAX_MS - 1)}, now)).toBe("answer");
    expect(nextStep({status: "PENDING", attempts: 1, requestedAt: ago(SPONSORED_DEPLOYMENT_PENDING_MAX_MS)}, now)).toBe("stale");
    expect(nextStep({status: "FAILED", attempts: 1, requestedAt: now}, now)).toBe("retry");
    expect(nextStep({status: "FAILED", attempts: 2, requestedAt: now}, now)).toBe("retry");
    expect(nextStep({status: "FAILED", attempts: 3, requestedAt: now}, now)).toBe("exhausted");
  });

  test("deploymentView and deploymentAnswer", () => {
    const requestedAt = new Date("2026-11-25T10:00:00Z");
    const row = (fields: Partial<SponsoredDeploymentRow>): SponsoredDeploymentRow => ({
      id: "d", account: ACCOUNT, chainId: CHAIN_ID, status: "PENDING", attempts: 1, transactionHash: null, failureReason: null, requestedAt, ...fields,
    });
    expect(deploymentView(row({}))).toEqual({
      account: ACCOUNT.toLowerCase(), chainId: CHAIN_ID, status: "pending", attempts: 1, requestedAt: "2026-11-25T10:00:00.000Z",
    });
    expect(deploymentView(row({status: "DEPLOYED", transactionHash: TX_HASH}))).toEqual({
      account: ACCOUNT.toLowerCase(), chainId: CHAIN_ID, status: "deployed", transactionHash: TX_HASH, attempts: 1, requestedAt: "2026-11-25T10:00:00.000Z",
    });
    const failed = deploymentView(row({status: "FAILED", failureReason: "would-revert", attempts: 2}));
    expect(failed).toEqual({
      account: ACCOUNT.toLowerCase(), chainId: CHAIN_ID, status: "failed", failureReason: "would-revert", attempts: 2, requestedAt: "2026-11-25T10:00:00.000Z",
    });
    expect(deploymentAnswer(deploymentView(row({status: "DEPLOYED", transactionHash: TX_HASH}))))
      .toEqual({account: ACCOUNT.toLowerCase(), chainId: CHAIN_ID, status: "deployed", transactionHash: TX_HASH});
    expect(deploymentAnswer(deploymentView(row({})))).toEqual({account: ACCOUNT.toLowerCase(), chainId: CHAIN_ID, status: "pending"});
    expect(deploymentAnswer(failed)).toEqual({account: ACCOUNT.toLowerCase(), chainId: CHAIN_ID, status: "failed", failureReason: "would-revert"});
  });

  test("the fields of its log lines are written, not redacted", () => {
    for (const key of [
      "deploymentId", "account", "chainId", "signerId", "verificationId", "attempt", "guardianModule", "reason", "statusCode",
      "limit", "signerAddress", "balance", "estimatedCost", "txHash", "deployed", "failed", "unchecked", "superseded",
      "senderCheck", "gasLimit", "maxGas", "network", "factoryCount", "requireGuardian", "rateLimit",
    ]) {
      expect([key, isSensitiveKey(key)]).toEqual([key, false]);
    }
  });
});

// The service, against the tables above and a fake chain.
const DEPLOY_ACCOUNTS: EnabledDeployAccounts = {
  enabled: true, signer: "deployer", factories: [FACTORY.toLowerCase()], requireGuardian: true, maxGas: 1_000_000,
  rateLimit: {maxPerTarget: 2, maxTotal: 5, period: 86400},
};
// What the fake chain answers; reset before each test.
type SenderAnswer = "match" | "mismatch" | "revert" | "nothing";
const mockChain = {
  code: new Set<string>(),
  codeFails: new Set<string>(),
  multicall3: true,
  factoryReverts: false,
  probe: {success: true, returnData: ONE},
  guardianModule: MODULE_B as string | undefined,
  sender: "match" as SenderAnswer,
  gas: 200_000 as number | "revert",
  balance: ethers.utils.parseEther("1"),
  // every provider call, in order
  calls: [] as {method: string, params: any}[],
};
// a JSON-RPC error answered by the node, as ethers' send() rejects with it
const nodeError = (message: string) =>
  Object.assign(new Error("processing response error"), {code: "SERVER_ERROR", error: Object.assign(new Error(message), {code: 3})});
const provider = {
  getCode: async (address: string) => {
    mockChain.calls.push({method: "getCode", params: address});
    const lower = address.toLowerCase();
    if (mockChain.codeFails.has(lower)) throw new Error("rpc unavailable");
    return mockChain.code.has(lower) ? "0x6080" : "0x";
  },
  send: async (method: string, params: any[]) => {
    mockChain.calls.push({method, params});
    const [{from, to, data}] = params;
    if (from === undefined) {
      // the simulation: [factory call, probe, guardian reads (isModuleEnabled, isGuardian) per module]
      if (to.toLowerCase() !== MULTICALL3_ADDRESS.toLowerCase()) throw new Error(`unexpected eth_call to ${to}`);
      if (mockChain.factoryReverts) throw nodeError("execution reverted");
      const [calls] = MULTICALL3.decodeFunctionData("aggregate3", data);
      const results = calls.map((_call: unknown, index: number) => {
        if (index === 0) return {success: true, returnData: "0x"};
        if (index === 1) return mockChain.probe;
        const module = [MODULE_A, MODULE_B][Math.floor((index - 2) / 2)];
        return {success: true, returnData: module === mockChain.guardianModule ? TRUE : FALSE};
      });
      return MULTICALL3.encodeFunctionResult("aggregate3", [results]);
    }
    // the sender check
    const account = deployingAccount;
    switch (mockChain.sender) {
      case "match": return encodeAddress(account);
      case "mismatch": return encodeAddress(GUARDIAN);
      case "nothing": return "0x";
      case "revert": throw nodeError("execution reverted");
    }
  },
  estimateGas: async (transaction: unknown) => {
    mockChain.calls.push({method: "estimateGas", params: transaction});
    if (mockChain.gas === "revert") {
      throw Object.assign(new Error("cannot estimate gas"), {code: ethers.errors.UNPREDICTABLE_GAS_LIMIT});
    }
    return ethers.BigNumber.from(mockChain.gas);
  },
  getBalance: async (address: string) => {
    mockChain.calls.push({method: "getBalance", params: address});
    return mockChain.balance;
  },
};
// the account the fake factory answers for (set by deploy())
let deployingAccount = "";

// A network without its constructor (which starts an indexer); supportsCounterfactual answers mockChain.multicall3.
const network: Network = Object.assign(Object.create(Network.prototype) as Network, {
  chainId: CHAIN_ID, name: "sepolia", guardian: "guardian", modules: [{address: MODULE_A}, {address: MODULE_B}],
  multicall3: MULTICALL3_ADDRESS, jsonRPCProvider: provider, deployAccounts: DEPLOY_ACCOUNTS,
  supportsCounterfactual: async () => mockChain.multicall3,
});
Network.instances.add(network);
Network.supportedChainIds.push(CHAIN_ID);
Signers.instance().addSigner({id: "guardian", signer: async () => GUARDIAN} as unknown as Signer);
Signers.instance().addSigner({id: "deployer", signer: async () => DEPLOYER} as unknown as Signer);

const MAX_FEE_PER_GAS = ethers.utils.parseUnits("10", "gwei");
const estimateFees = jest.spyOn(GasPriceEstimator.instance(), "estimate");
type Enqueued = Parameters<ChainExecutor["addTransaction"]>[0];
const enqueued: Enqueued[] = [];
jest.spyOn(ChainExecutor.instance(), "addTransaction").mockImplementation((transaction) => {
  enqueued.push(transaction);
});

const table = (name: string) => (mockTables[name] ??= []);
const rowOf = (account: string) => table("sponsoredDeployment").find((row) => row.account === account.toLowerCase());
let ids = 0;
let targets = 0;
// every target and token made, none of which may appear in a log line
const secrets: string[] = [];
// An account registered (or not) for a verified target, with init data (or other metadata); its token.
const setup = ({
  registered = true,
  metadata = {label: "main", _factory: FACTORY, _factoryData: FACTORY_CALLDATA} as Record<string, string> | null,
  target = `user${++targets}@example.com`,
  channel = "email",
} = {}) => {
  const account = newAccount();
  const token = newVerifiedTargetToken();
  const verificationId = `verification-${++ids}`;
  secrets.push(target, token, requesterHash(channel, target));
  table("targetVerification").push({
    id: verificationId, channel, target, tokenHash: hashVerifiedTargetToken(token), tokenExpiresAt: new Date(Date.now() + 600_000),
  });
  if (registered) {
    table("authRegistration").push({id: `registration-${++ids}`, account: account.toLowerCase(), chainId: CHAIN_ID, channel, target, guardian: GUARDIAN});
  }
  if (metadata) {
    table("authAccountMetadata").push({id: `metadata-${++ids}`, account: account.toLowerCase(), chainId: CHAIN_ID, metadata});
  }
  return {account, token, verificationId, target, channel};
};
const deploy = (account: string, token: string) => {
  deployingAccount = account;
  return deployAccount(account, CHAIN_ID, token);
};
const refusal = async (promise: Promise<unknown>) =>
  promise.then(() => undefined, (e: ApiError) => ({statusCode: e.statusCode, message: e.message, details: e.details}));
const chainMethods = () => mockChain.calls.map((call) => call.method);
const addRow = (account: string, fields: Record<string, unknown>) => {
  const row = {
    id: `deployment-${++ids}`, account: account.toLowerCase(), chainId: CHAIN_ID, status: "PENDING", attempts: 1, signerId: "deployer",
    requesterHash: "other", verificationId: "other", transactionHash: null, failureReason: null, requestedAt: new Date(),
    createdAt: new Date(), updatedAt: new Date(), ...fields,
  };
  table("sponsoredDeployment").push(row);
  return row;
};
const DAY = 24 * 60 * 60 * 1000;

beforeEach(() => {
  Object.assign(mockChain, {
    code: new Set<string>(), codeFails: new Set<string>(), multicall3: true, factoryReverts: false, probe: {success: true, returnData: ONE},
    guardianModule: MODULE_B, sender: "match", gas: 200_000, balance: ethers.utils.parseEther("1"), calls: [],
  });
  network.deployAccounts = DEPLOY_ACCOUNTS;
  network.counterfactualSupported = undefined;
  estimateFees.mockReset().mockResolvedValue([ethers.utils.parseUnits("5", "gwei"), MAX_FEE_PER_GAS, ethers.utils.parseUnits("1", "gwei")]);
  enqueued.length = 0;
  mockLogLines.length = 0;
  mockHooks.length = 0;
  // the limits count every row of the chain: each test starts with none
  mockTables.sponsoredDeployment = [];
});

// No line ever carries the factory, the calldata, a target, a token or a requester hash.
afterEach(() => {
  const logged = JSON.stringify(mockLogLines, (_key, value) => value instanceof Error ? value.message : value).toLowerCase();
  expect(logged).not.toContain(FACTORY.slice(2).toLowerCase());
  expect(logged).not.toContain(FACTORY_CALLDATA.slice(10, 50));
  for (const secret of secrets) {
    expect(logged).not.toContain(secret.toLowerCase());
  }
});

describe("deployAccount, step by step", () => {
  test("1. a network that does not sponsor answers 403 sponsorship-disabled, before the token is read", async () => {
    network.deployAccounts = {enabled: false};
    const {account} = setup();
    expect(await refusal(deploy(account, "x".repeat(43)))).toEqual({
      statusCode: 403, message: `Deployment sponsorship is not enabled for this network (${CHAIN_ID})`, details: {reason: "sponsorship-disabled"},
    });
    expect(linesWith("verified target token refused")).toEqual([]);
    expect(linesWith("sponsored deployment refused")).toMatchObject([
      {level: "info", fields: {account: account.toLowerCase(), chainId: CHAIN_ID, reason: "sponsorship-disabled", statusCode: 403}},
    ]);
    expect(chainMethods()).toEqual([]);
    expect(enqueued).toEqual([]);
  });

  test("2. an unknown or expired token answers the token's 403, without details", async () => {
    const {account, token} = setup();
    expect(await refusal(deploy(account, newVerifiedTargetToken())))
      .toEqual({statusCode: 403, message: "Invalid or expired verifiedTargetToken", details: undefined});
    table("targetVerification").find((row) => row.tokenHash === hashVerifiedTargetToken(token)).tokenExpiresAt = new Date(Date.now() - 1);
    expect(await refusal(deploy(account, token)))
      .toEqual({statusCode: 403, message: "Invalid or expired verifiedTargetToken", details: undefined});
    expect(linesWith("verified target token refused").map((line) => line.fields)).toMatchObject([
      {use: "deploy", reason: "unknown"}, {use: "deploy", reason: "expired"},
    ]);
    expect(chainMethods()).toEqual([]);
  });

  test("3. a target that is not registered for the account on this chain answers 403 not-registered, with no chain call", async () => {
    const {account, token, verificationId} = setup({registered: false});
    // registered for another account, and for this account on another chain
    table("authRegistration").push({id: "r1", account: newAccount().toLowerCase(), chainId: CHAIN_ID, channel: "email", target: "x", guardian: GUARDIAN});
    table("authRegistration").push({id: "r2", account: account.toLowerCase(), chainId: 1, channel: "email", target: "x", guardian: GUARDIAN});
    expect(await refusal(deploy(account, token))).toEqual({
      statusCode: 403, message: "This verifiedTargetToken's target is not registered for this account on this chain", details: {reason: "not-registered"},
    });
    expect(linesWith("sponsored deployment refused")[0].fields).toEqual({
      account: account.toLowerCase(), chainId: CHAIN_ID, verificationId, reason: "not-registered", statusCode: 403,
    });
    expect(chainMethods()).toEqual([]);
  });

  test("3. a token of the other channel of a registered account is refused too", async () => {
    const email = setup();
    const sms = setup({registered: false, channel: "sms", target: "+15550100001"});
    expect((await refusal(deploy(email.account, sms.token)))?.details).toEqual({reason: "not-registered"});
  });

  test("4. a row DEPLOYED by this service answers 200 with its hash, with no chain call", async () => {
    const {account, token} = setup();
    addRow(account, {status: "DEPLOYED", transactionHash: TX_HASH});
    expect(await deploy(account, token)).toEqual({
      statusCode: 200, body: {account: account.toLowerCase(), chainId: CHAIN_ID, status: "deployed", transactionHash: TX_HASH},
    });
    expect(chainMethods()).toEqual([]);
    expect(enqueued).toEqual([]);
  });

  test("5. an account that already has code answers 200 deployed, and no row is created", async () => {
    const {account, token} = setup();
    mockChain.code.add(account.toLowerCase());
    expect(await deploy(account, token)).toEqual({statusCode: 200, body: {account: account.toLowerCase(), chainId: CHAIN_ID, status: "deployed"}});
    expect(rowOf(account)).toBeUndefined();
    expect(chainMethods()).toEqual(["getCode"]);
    expect(enqueued).toEqual([]);
  });

  test.each([
    ["PENDING", {status: "PENDING"}],
    ["FAILED", {status: "FAILED", failureReason: "reverted", transactionHash: TX_HASH, attempts: 2}],
  ])("5. a %s row of an account that has code becomes DEPLOYED", async (_status, fields) => {
    const {account, token} = setup();
    const row = addRow(account, fields);
    mockChain.code.add(account.toLowerCase());
    expect((await deploy(account, token)).body.status).toBe("deployed");
    expect(rowOf(account)).toMatchObject({status: "DEPLOYED", transactionHash: null, failureReason: null});
    expect(linesWith("sponsored deployment found deployed")).toMatchObject([
      {level: "info", fields: {deploymentId: row.id, account: account.toLowerCase(), chainId: CHAIN_ID}},
    ]);
    expect(enqueued).toEqual([]);
  });

  test("6. a PENDING row answers 202 pending and sends nothing", async () => {
    const {account, token} = setup();
    addRow(account, {status: "PENDING", requestedAt: new Date(Date.now() - SPONSORED_DEPLOYMENT_PENDING_MAX_MS + 60_000)});
    expect(await deploy(account, token)).toEqual({statusCode: 202, body: {account: account.toLowerCase(), chainId: CHAIN_ID, status: "pending"}});
    expect(chainMethods()).toEqual(["getCode"]);
    expect(enqueued).toEqual([]);
  });

  test("6. a stale PENDING row fails as interrupted, and the request goes on as its next attempt", async () => {
    const {account, token} = setup();
    const row = addRow(account, {status: "PENDING", attempts: 1, requestedAt: new Date(Date.now() - SPONSORED_DEPLOYMENT_PENDING_MAX_MS)});
    expect((await deploy(account, token)).statusCode).toBe(202);
    expect(enqueued).toHaveLength(1);
    expect(rowOf(account)).toMatchObject({id: row.id, status: "PENDING", attempts: 2, failureReason: null});
    expect(linesWith("sponsored deployment failed")).toMatchObject([
      {level: "warn", fields: {deploymentId: row.id, reason: "interrupted", attempt: 1}},
    ]);
  });

  test("7. a row FAILED after the third attempt answers 409 attempts-exhausted", async () => {
    const {account, token} = setup();
    addRow(account, {status: "FAILED", attempts: 3, failureReason: "reverted"});
    expect(await refusal(deploy(account, token))).toEqual({
      statusCode: 409, message: "The sponsored deployment of this account failed 3 times; it will not be tried again", details: {reason: "attempts-exhausted"},
    });
    expect(chainMethods()).toEqual(["getCode"]);
    expect(enqueued).toEqual([]);
  });

  test.each([
    ["no metadata", null],
    ["metadata without init data", {label: "main"}],
    ["half of the init data", {_factory: FACTORY}],
  ])("8. %s answers 409 no-init-data", async (_name, metadata) => {
    const {account, token} = setup({metadata});
    expect(await refusal(deploy(account, token))).toEqual({
      statusCode: 409, message: "No init data is stored for this account on this chain", details: {reason: "no-init-data"},
    });
    expect(enqueued).toEqual([]);
  });

  test("9. a factory that is not on the allowlist answers 403 factory-not-sponsored", async () => {
    const {account, token} = setup({metadata: {_factory: OTHER_FACTORY, _factoryData: FACTORY_CALLDATA}});
    expect(await refusal(deploy(account, token))).toEqual({
      statusCode: 403, message: `The factory of this account is not sponsored on this network (${CHAIN_ID})`, details: {reason: "factory-not-sponsored"},
    });
    expect(chainMethods()).toEqual(["getCode"]);
  });

  test("11. a chain without Multicall3 answers 409 sponsorship-unavailable", async () => {
    mockChain.multicall3 = false;
    const {account, token} = setup();
    expect(await refusal(deploy(account, token))).toEqual({
      statusCode: 409, message: `Sponsored deployments are temporarily unavailable on this network (${CHAIN_ID})`, details: {reason: "sponsorship-unavailable"},
    });
    expect(chainMethods()).toEqual(["getCode"]);
  });

  test("11. a factory call that reverts in the simulation answers 409 deployment-would-fail", async () => {
    mockChain.factoryReverts = true;
    const {account, token} = setup();
    expect(await refusal(deploy(account, token))).toEqual({
      statusCode: 409, message: "The init data stored for this account does not deploy it on this chain", details: {reason: "deployment-would-fail"},
    });
    expect(enqueued).toEqual([]);
  });

  test.each([
    ["reverts", {success: false, returnData: "0x"}],
    ["answers nothing (no code at the account)", {success: true, returnData: "0x"}],
    ["answers zero", {success: true, returnData: ZERO_WORD}],
  ])("11. a probe that %s answers 409 deployment-would-fail", async (_name, probe) => {
    mockChain.probe = probe;
    const {account, token} = setup();
    expect((await refusal(deploy(account, token)))?.details).toEqual({reason: "deployment-would-fail"});
    expect(enqueued).toEqual([]);
  });

  test("11. a deployment that does not install the guardian answers 403 no-guardian", async () => {
    mockChain.guardianModule = undefined;
    const {account, token} = setup();
    expect(await refusal(deploy(account, token))).toEqual({
      statusCode: 403, message: "Deploying this account does not install this service's guardian", details: {reason: "no-guardian"},
    });
    expect(enqueued).toEqual([]);
  });

  test("11. the simulation runs the factory call, the probe and the guardian check in one eth_call", async () => {
    const {account, token} = setup();
    await deploy(account, token);
    const simulation = mockChain.calls.find((call) => call.method === "eth_call" && call.params[0].from === undefined)!;
    expect(simulation.params[0].to).toBe(MULTICALL3_ADDRESS);
    const [calls] = MULTICALL3.decodeFunctionData("aggregate3", simulation.params[0].data);
    const expected: SimulatedCall[] = [deploymentProbe(account), ...guardianSetupReads(account, GUARDIAN, [MODULE_A, MODULE_B])];
    expect(calls.map(({target, allowFailure, callData}: any) => [target.toLowerCase(), allowFailure, callData])).toEqual([
      [FACTORY.toLowerCase(), false, FACTORY_CALLDATA],
      ...expected.map(({target, callData}) => [target.toLowerCase(), true, callData]),
    ]);
  });

  test("11. without requireGuardian, the simulation reads the probe only and any guardian passes", async () => {
    network.deployAccounts = {...DEPLOY_ACCOUNTS, requireGuardian: false};
    mockChain.guardianModule = undefined;
    const {account, token} = setup();
    expect((await deploy(account, token)).statusCode).toBe(202);
    const simulation = mockChain.calls.find((call) => call.method === "eth_call" && call.params[0].from === undefined)!;
    expect(MULTICALL3.decodeFunctionData("aggregate3", simulation.params[0].data)[0]).toHaveLength(2);
    expect(linesWith("sponsored deployment requested")[0].fields).not.toHaveProperty("guardianModule");
  });

  test.each([
    ["names another address", "mismatch" as SenderAnswer],
    ["reverts", "revert" as SenderAnswer],
  ])("12. a factory call from the paying signer that %s answers 409 deployment-would-fail", async (_name, sender) => {
    mockChain.sender = sender;
    const {account, token} = setup();
    expect(await refusal(deploy(account, token))).toEqual({
      statusCode: 409, message: "The init data stored for this account does not deploy it on this chain", details: {reason: "deployment-would-fail"},
    });
    expect(enqueued).toEqual([]);
  });

  test("12. a factory that answers no address from the paying signer goes on", async () => {
    mockChain.sender = "nothing";
    const {account, token} = setup();
    expect((await deploy(account, token)).statusCode).toBe(202);
  });

  test("12. a gas estimate that reverts answers 409 deployment-would-fail", async () => {
    mockChain.gas = "revert";
    const {account, token} = setup();
    expect((await refusal(deploy(account, token)))?.details).toEqual({reason: "deployment-would-fail"});
    expect(enqueued).toEqual([]);
  });

  test("12. an estimate that needs more than maxGas once raised by 25 % answers 403 gas-limit", async () => {
    expect(SPONSORED_DEPLOYMENT_GAS_FACTOR).toBe(1.25);
    mockChain.gas = 800_001;
    const {account, token} = setup();
    expect(await refusal(deploy(account, token))).toEqual({
      statusCode: 403, message: "Deploying this account needs more gas than this network sponsors", details: {reason: "gas-limit"},
    });
    expect(enqueued).toEqual([]);
    // exactly at the cap passes
    mockChain.gas = 800_000;
    const other = setup();
    expect((await deploy(other.account, other.token)).statusCode).toBe(202);
  });

  test("12. the sender check and the estimate are made from the paying signer's address", async () => {
    const {account, token} = setup();
    await deploy(account, token);
    const senderCall = mockChain.calls.find((call) => call.method === "eth_call" && call.params[0].from !== undefined)!;
    const estimate = mockChain.calls.find((call) => call.method === "estimateGas")!;
    for (const transaction of [senderCall.params[0], estimate.params]) {
      expect(transaction).toEqual({from: DEPLOYER, to: FACTORY, data: FACTORY_CALLDATA});
    }
  });

  test("13. a fee source that fails answers 503 sponsorship-unavailable", async () => {
    estimateFees.mockRejectedValue(new Error("gas api unavailable"));
    const {account, token} = setup();
    expect(await refusal(deploy(account, token))).toEqual({
      statusCode: 503, message: `Sponsored deployments are temporarily unavailable on this network (${CHAIN_ID})`, details: {reason: "sponsorship-unavailable"},
    });
    expect(estimateFees).toHaveBeenCalledWith(CHAIN_ID, 1.5);
    expect(enqueued).toEqual([]);
  });

  test("13. a signer that cannot pay gasLimit * maxFeePerGas answers 503, with an error line", async () => {
    // 200000 * 1.25 * 10 gwei = 0.0025 ETH
    mockChain.balance = ethers.utils.parseEther("0.0025").sub(1);
    const {account, token} = setup();
    expect((await refusal(deploy(account, token)))).toMatchObject({statusCode: 503, details: {reason: "sponsorship-unavailable"}});
    expect(linesWith("sponsored deployment signer underfunded")).toEqual([{
      level: "error", bindings: {component: "sponsored-deployment"},
      fields: {chainId: CHAIN_ID, signerId: "deployer", signerAddress: DEPLOYER, balance: mockChain.balance.toString(), estimatedCost: "2500000000000000"},
      message: "sponsored deployment signer underfunded",
    }]);
    expect(enqueued).toEqual([]);
    // exactly enough passes
    mockChain.balance = ethers.utils.parseEther("0.0025");
    const other = setup();
    expect((await deploy(other.account, other.token)).statusCode).toBe(202);
  });

  test("14, 15. the claim creates the row, the transaction is enqueued capped at maxGas, and 202 pending is answered", async () => {
    const {account, token, verificationId, target} = setup();
    expect(await deploy(account, token)).toEqual({statusCode: 202, body: {account: account.toLowerCase(), chainId: CHAIN_ID, status: "pending"}});
    const row = rowOf(account);
    expect(row).toMatchObject({
      account: account.toLowerCase(), chainId: CHAIN_ID, status: "PENDING", attempts: 1, signerId: "deployer",
      requesterHash: requesterHash("email", target), verificationId, transactionHash: null, failureReason: null,
    });
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0]).toMatchObject({
      to: FACTORY, value: 0n, callData: FACTORY_CALLDATA, chainId: CHAIN_ID, signerId: "deployer", maxGasLimit: 1_000_000,
      context: {action: "deploy", account: account.toLowerCase()},
    });
    expect(linesWith("sponsored deployment requested")).toEqual([{
      level: "info", bindings: {component: "sponsored-deployment"},
      fields: {
        deploymentId: row.id, account: account.toLowerCase(), chainId: CHAIN_ID, signerId: "deployer", verificationId, attempt: 1,
        guardianModule: MODULE_B,
      },
      message: "sponsored deployment requested",
    }]);
  });
});

describe("the claim", () => {
  test("two requests at once enqueue the deployment once", async () => {
    const {account, token} = setup();
    deployingAccount = account;
    const answers = await Promise.all([deployAccount(account, CHAIN_ID, token), deployAccount(account, CHAIN_ID, token)]);
    expect(answers.map((answer) => answer.statusCode)).toEqual([202, 202]);
    expect(enqueued).toHaveLength(1);
    expect(table("sponsoredDeployment").filter((row) => row.account === account.toLowerCase())).toHaveLength(1);
  });

  test("a row created in between (P2002) is answered, and nothing is sent", async () => {
    const {account, token} = setup();
    mockHooks.push({table: "sponsoredDeployment", method: "create", before: () => addRow(account, {status: "PENDING"})});
    expect(await deploy(account, token)).toEqual({statusCode: 202, body: {account: account.toLowerCase(), chainId: CHAIN_ID, status: "pending"}});
    expect(enqueued).toEqual([]);
  });

  test("a retry claimed in between by another request is answered, and nothing is sent", async () => {
    const {account, token} = setup();
    const row = addRow(account, {status: "FAILED", attempts: 1, failureReason: "expired"});
    mockHooks.push({table: "sponsoredDeployment", method: "updateMany", before: () => Object.assign(row, {status: "PENDING", attempts: 2})});
    expect((await deploy(account, token)).statusCode).toBe(202);
    expect(enqueued).toEqual([]);
    expect(row).toMatchObject({status: "PENDING", attempts: 2});
  });

  test("each retry after a failure is the next attempt, and the fourth request is attempts-exhausted", async () => {
    const {account, token, verificationId} = setup();
    for (let attempt = 1; attempt <= SPONSORED_DEPLOYMENT_MAX_ATTEMPTS; attempt++) {
      expect((await deploy(account, token)).statusCode).toBe(202);
      expect(rowOf(account)).toMatchObject({status: "PENDING", attempts: attempt, verificationId, transactionHash: null, failureReason: null});
      expect(lastOf(linesWith("sponsored deployment requested")).fields.attempt).toBe(attempt);
      await lastOf(enqueued).callback!(false, TX_HASH, "reverted");
      expect(rowOf(account)).toMatchObject({status: "FAILED", attempts: attempt, failureReason: "reverted", transactionHash: TX_HASH});
    }
    expect((await refusal(deploy(account, token)))?.details).toEqual({reason: "attempts-exhausted"});
    expect(enqueued).toHaveLength(SPONSORED_DEPLOYMENT_MAX_ATTEMPTS);
  });

  test("a retry by another target's token records that token's verification and requester", async () => {
    const first = setup();
    const second = setup();
    table("authRegistration").push({
      id: "second", account: first.account.toLowerCase(), chainId: CHAIN_ID, channel: "email", target: second.target, guardian: GUARDIAN,
    });
    await deploy(first.account, first.token);
    await enqueued[0].callback!(false, "", "would-revert");
    await deploy(first.account, second.token);
    expect(rowOf(first.account)).toMatchObject({
      status: "PENDING", attempts: 2, verificationId: second.verificationId, requesterHash: requesterHash("email", second.target),
    });
  });
});

describe("the limits", () => {
  test("the per-target limit counts this target's deployments of other accounts, whatever their status", async () => {
    const {target} = setup();
    const hash = requesterHash("email", target);
    addRow(newAccount(), {status: "FAILED", requesterHash: hash, failureReason: "reverted"});
    addRow(newAccount(), {status: "DEPLOYED", requesterHash: hash});
    const {account, token, verificationId} = setup({target});
    expect(await refusal(deploy(account, token))).toEqual({
      statusCode: 429, message: "You are only allowed 2 sponsored deployments every 1 day", details: {reason: "limit-target"},
    });
    expect(linesWith("sponsored deployment limit reached")).toEqual([{
      level: "info", bindings: {component: "sponsored-deployment"}, fields: {chainId: CHAIN_ID, limit: "target", verificationId},
      message: "sponsored deployment limit reached",
    }]);
    expect(enqueued).toEqual([]);
  });

  test("rows outside the window, of another target or of another chain do not count", async () => {
    const {target} = setup();
    const hash = requesterHash("email", target);
    addRow(newAccount(), {requesterHash: hash, requestedAt: new Date(Date.now() - DAY - 1000)});
    addRow(newAccount(), {requesterHash: hash, chainId: 1});
    addRow(newAccount(), {requesterHash: requesterHash("sms", target)});
    const {account, token} = setup({target});
    expect((await deploy(account, token)).statusCode).toBe(202);
  });

  test("the account's own row is not counted: retrying it never counts twice", async () => {
    network.deployAccounts = {...DEPLOY_ACCOUNTS, rateLimit: {maxPerTarget: 1, maxTotal: 1, period: 86400}};
    const {account, token, target} = setup();
    addRow(account, {status: "FAILED", requesterHash: requesterHash("email", target), failureReason: "expired"});
    expect((await deploy(account, token)).statusCode).toBe(202);
    expect(rowOf(account).attempts).toBe(2);
  });

  test("the network total counts every row of the chain in the window, and its line is a warning", async () => {
    network.deployAccounts = {...DEPLOY_ACCOUNTS, rateLimit: {maxTotal: 2, period: 3600}};
    addRow(newAccount(), {status: "FAILED", failureReason: "no-code"});
    addRow(newAccount(), {status: "PENDING"});
    addRow(newAccount(), {status: "DEPLOYED", requestedAt: new Date(Date.now() - 3600_000 - 1000)});
    const {account, token, verificationId} = setup();
    expect(await refusal(deploy(account, token))).toEqual({
      statusCode: 429, message: "Sponsored deployments are used up on this network for now, try again later", details: {reason: "limit-total"},
    });
    expect(linesWith("sponsored deployment limit reached")).toMatchObject([
      {level: "warn", fields: {chainId: CHAIN_ID, limit: "total", verificationId}},
    ]);
    expect(enqueued).toEqual([]);
  });

  test("without a rate limit nothing is counted", async () => {
    network.deployAccounts = {...DEPLOY_ACCOUNTS, rateLimit: undefined};
    for (let i = 0; i < 10; i++) addRow(newAccount(), {});
    const {account, token} = setup();
    expect((await deploy(account, token)).statusCode).toBe(202);
  });

  test("countSponsoredDeployments counts a chain's rows since a time, of a requester, leaving an account out", async () => {
    const since = new Date();
    const account = newAccount();
    addRow(account, {chainId: 5, requesterHash: "h1"});
    addRow(newAccount(), {chainId: 5, requesterHash: "h1", status: "FAILED"});
    addRow(newAccount(), {chainId: 5, requesterHash: "h2", status: "DEPLOYED"});
    addRow(newAccount(), {chainId: 5, requestedAt: new Date(since.getTime() - 1)});
    expect(await countSponsoredDeployments(5, since)).toBe(3);
    expect(await countSponsoredDeployments(5, since, "h1")).toBe(2);
    expect(await countSponsoredDeployments(5, since, "h1", account)).toBe(1);
    expect(await countSponsoredDeployments(5, since, undefined, account)).toBe(2);
  });
});

describe("the outcome of an attempt", () => {
  const started = async () => {
    const {account, token} = setup();
    await deploy(account, token);
    const row = rowOf(account);
    mockLogLines.length = 0;
    return {account, token, row, callback: lastOf(enqueued).callback!};
  };

  test("mined, with code at the account: DEPLOYED with the hash, and the next request answers 200 with it", async () => {
    const {account, token, row, callback} = await started();
    mockChain.code.add(account.toLowerCase());
    await callback(true, TX_HASH);
    expect(rowOf(account)).toMatchObject({status: "DEPLOYED", transactionHash: TX_HASH, failureReason: null});
    expect(linesWith("sponsored deployment confirmed")).toEqual([{
      level: "info", bindings: {component: "sponsored-deployment"},
      fields: {deploymentId: row.id, account: account.toLowerCase(), chainId: CHAIN_ID, txHash: TX_HASH},
      message: "sponsored deployment confirmed",
    }]);
    expect((await deploy(account, token)).body).toEqual({account: account.toLowerCase(), chainId: CHAIN_ID, status: "deployed", transactionHash: TX_HASH});
  });

  test("mined, and no code at the account: FAILED no-code, with an error line", async () => {
    const {account, row, callback} = await started();
    await callback(true, TX_HASH);
    expect(rowOf(account)).toMatchObject({status: "FAILED", failureReason: "no-code", transactionHash: TX_HASH});
    expect(linesWith("sponsored deployment left no code")).toMatchObject([
      {level: "error", fields: {deploymentId: row.id, account: account.toLowerCase(), chainId: CHAIN_ID, txHash: TX_HASH}},
    ]);
  });

  test("mined, and the code cannot be read: DEPLOYED, with a warning line", async () => {
    const {account, callback} = await started();
    mockChain.codeFails.add(account.toLowerCase());
    await callback(true, TX_HASH);
    expect(rowOf(account)).toMatchObject({status: "DEPLOYED", transactionHash: TX_HASH});
    expect(linesWith("sponsored deployment confirmed without a code check")).toMatchObject([{level: "warn", fields: {txHash: TX_HASH}}]);
  });

  test("failed, but the account has code (deployed by someone else): DEPLOYED, without a hash", async () => {
    const {account, row, callback} = await started();
    mockChain.code.add(account.toLowerCase());
    await callback(false, TX_HASH, "reverted");
    expect(rowOf(account)).toMatchObject({status: "DEPLOYED", transactionHash: null, failureReason: null});
    expect(linesWith("sponsored deployment found deployed")).toMatchObject([{level: "info", fields: {deploymentId: row.id}}]);
  });

  test.each([
    ["would-revert", ""],
    ["gas-limit-exceeded", ""],
    ["expired", ""],
    ["reverted", TX_HASH],
  ] as const)("failed (%s): FAILED with the reason and the mined hash of a revert", async (reason, hash) => {
    const {account, row, callback} = await started();
    await callback(false, hash, reason);
    expect(rowOf(account)).toMatchObject({status: "FAILED", failureReason: reason, transactionHash: hash || null});
    expect(linesWith("sponsored deployment failed")).toEqual([{
      level: "warn", bindings: {component: "sponsored-deployment"},
      fields: {deploymentId: row.id, account: account.toLowerCase(), chainId: CHAIN_ID, reason, txHash: hash || undefined, attempt: 1},
      message: "sponsored deployment failed",
    }]);
  });

  test("a late outcome of an older attempt changes nothing", async () => {
    const {account, token, callback: first} = await started();
    // the first attempt is stale: a request fails it as interrupted and sends the second
    rowOf(account).requestedAt = new Date(Date.now() - SPONSORED_DEPLOYMENT_PENDING_MAX_MS);
    await deploy(account, token);
    expect(rowOf(account)).toMatchObject({status: "PENDING", attempts: 2});
    mockChain.code.add(account.toLowerCase());
    await first(true, TX_HASH);
    expect(rowOf(account)).toMatchObject({status: "PENDING", attempts: 2, transactionHash: null});
    expect(linesWith("sponsored deployment confirmed")).toMatchObject([{fields: {txHash: TX_HASH, superseded: true}}]);
  });
});

describe("releaseOrphanedDeployments", () => {
  test("a previous process's PENDING rows: DEPLOYED with code, FAILED interrupted without, PENDING when unchecked", async () => {
    table("sponsoredDeployment").length = 0;
    const before = new Date(Date.now() - 60 * 60 * 1000);
    const deployed = addRow(newAccount(), {requestedAt: before});
    mockChain.code.add(deployed.account);
    const interrupted = addRow(newAccount(), {requestedAt: before});
    const unreadable = addRow(newAccount(), {requestedAt: before});
    mockChain.codeFails.add(unreadable.account);
    const otherChain = addRow(newAccount(), {requestedAt: before, chainId: 999999});
    // a row of this process, and rows that are not pending
    const current = addRow(newAccount(), {requestedAt: new Date()});
    const failed = addRow(newAccount(), {requestedAt: before, status: "FAILED", failureReason: "expired"});
    expect(await releaseOrphanedDeployments()).toEqual({deployed: 1, failed: 1, unchecked: 2});
    expect(deployed.status).toBe("DEPLOYED");
    expect(interrupted).toMatchObject({status: "FAILED", failureReason: "interrupted"});
    expect([unreadable.status, otherChain.status, current.status]).toEqual(["PENDING", "PENDING", "PENDING"]);
    expect(failed).toMatchObject({status: "FAILED", failureReason: "expired"});
    expect(linesWith("orphaned sponsored deployment not checked")).toHaveLength(2);
    expect(linesWith("orphaned sponsored deployments released")).toEqual([{
      level: "warn", bindings: {component: "sponsored-deployment"}, fields: {deployed: 1, failed: 1, unchecked: 2},
      message: "orphaned sponsored deployments released",
    }]);
  });

  test("logs nothing when there is nothing to release", async () => {
    table("sponsoredDeployment").length = 0;
    expect(await releaseOrphanedDeployments()).toEqual({deployed: 0, failed: 0, unchecked: 0});
    expect(mockLogLines).toEqual([]);
  });
});

describe("fetchDeployment", () => {
  test("answers 404 when nothing was requested, with no chain call", async () => {
    expect(await refusal(fetchDeployment(newAccount(), CHAIN_ID))).toEqual({
      statusCode: 404, message: "No sponsored deployment was requested for this account on this chain", details: undefined,
    });
    expect(chainMethods()).toEqual([]);
  });

  test.each([
    ["PENDING", {}, {status: "pending"}],
    ["DEPLOYED", {status: "DEPLOYED", transactionHash: TX_HASH}, {status: "deployed", transactionHash: TX_HASH}],
    ["FAILED", {status: "FAILED", failureReason: "would-revert", attempts: 2}, {status: "failed", failureReason: "would-revert", attempts: 2}],
  ])("answers a %s row", async (_status, fields, expected) => {
    const account = newAccount();
    const requestedAt = new Date("2026-11-25T10:00:00Z");
    addRow(account, {requestedAt, ...fields});
    expect(await fetchDeployment(account.toLowerCase(), CHAIN_ID)).toEqual({
      account: account.toLowerCase(), chainId: CHAIN_ID, attempts: 1, requestedAt: "2026-11-25T10:00:00.000Z", ...expected,
    });
    expect(chainMethods()).toEqual([]);
  });
});

describe("sponsoredDeploymentAvailable", () => {
  test("is true when the network sponsors and the account's init data names a listed factory, with no chain call", async () => {
    const {account} = setup();
    expect(await sponsoredDeploymentAvailable(network, account)).toBe(true);
    expect(chainMethods()).toEqual([]);
  });

  test.each([
    ["the network does not sponsor", () => { network.deployAccounts = {enabled: false}; }, undefined],
    ["Multicall3 is known to be missing", () => { network.counterfactualSupported = false; }, undefined],
    ["no init data is stored", () => undefined, {label: "main"}],
    ["the factory is not listed", () => undefined, {_factory: OTHER_FACTORY, _factoryData: FACTORY_CALLDATA}],
  ])("is false when %s", async (_name, change, metadata) => {
    const {account} = setup(metadata === undefined ? {} : {metadata});
    change();
    expect(await sponsoredDeploymentAvailable(network, account)).toBe(false);
  });
});

// Against real contracts (Safe 1.4.1, the recovery modules, Multicall3), read-only: what the service checks before
// paying, on the stand-ins of test/guardian-deployment.ts. Nothing is sent.
const jsonRpcNodeProvider = process.env.JSON_RPC_NODE_PROVIDER_1;
(jsonRpcNodeProvider ? describe : describe.skip)("the checks before paying, on chain (JSON_RPC_NODE_PROVIDER_1)", () => {
  jest.setTimeout(120000);
  const modules = [MODULE_A, MODULE_B];
  const chain = new ethers.providers.StaticJsonRpcProvider(jsonRpcNodeProvider);
  const owner = ethers.Wallet.createRandom();
  const guardian = ethers.Wallet.createRandom().address;
  const reads = (account: string) => [deploymentProbe(account), ...guardianSetupReads(account, guardian, modules)];
  const simulate = (account: string, deployment: AccountDeployment) => simulateDeploymentReads(chain, MULTICALL3_ADDRESS, deployment, reads(account));

  beforeAll(async () => {
    for (const address of [...STAND_IN_CONTRACTS, ...modules]) {
      expect([address, await chain.getCode(address)]).not.toEqual([address, "0x"]);
    }
  });

  test("the guardian stand-in deploys Safe code with the guardian on its module", async () => {
    const {account, deployment} = await guardianDeployment(chain, owner, MODULE_B, guardian);
    expect(await chain.getCode(account)).toBe("0x");
    const results = await simulate(account, deployment);
    expect(probeAnswered(results[0])).toBe(true);
    expect(guardianSetupModule(results.slice(1), modules)).toBe(MODULE_B);
  });

  test("the plain stand-in deploys Safe code without the guardian", async () => {
    const {account, deployment} = await plainDeployment(chain, owner.address);
    const results = await simulate(account, deployment);
    expect(probeAnswered(results[0])).toBe(true);
    expect(guardianSetupModule(results.slice(1), modules)).toBeUndefined();
  });

  test("corrupted calldata does not deploy (deployment-would-fail)", async () => {
    const {account, deployment} = await plainDeployment(chain, owner.address);
    const corrupted = {...deployment, factoryCalldata: "0xdeadbeef" + deployment.factoryCalldata.slice(10)};
    const error = await simulate(account, corrupted).then(() => undefined, (e) => e);
    expect(error).toBeInstanceOf(Erc6492Error);
    expect(error.reason).toBe("deploy-failed");
  });

  test("a real createProxyWithNonce names its account to any sender, and its gas is under the default cap", async () => {
    const {account, deployment} = await plainDeployment(chain, owner.address);
    expect(deployment.factory).toBe(SAFE_PROXY_FACTORY_1_4_1);
    const from = ethers.Wallet.createRandom().address;
    const call = {from, to: deployment.factory, data: deployment.factoryCalldata};
    expect(senderCheck(await chain.send("eth_call", [call, "latest"]), account)).toBe("match");
    const estimate = await chain.estimateGas(call);
    expect(estimate.mul(125).div(100).lte(DEFAULT_DEPLOY_ACCOUNTS_MAX_GAS)).toBe(true);
  });
});
