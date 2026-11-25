// The sponsored deployment of undeployed accounts: the configuration (parseDeployAccounts and the boot checks). No
// database, no chain, no app boot.
import {ethers} from "ethers";
import {DEFAULT_DEPLOY_ACCOUNTS_MAX_GAS, parseDeployAccounts} from "../src/config/config-manager";

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
