// The init data an undeployed account's registration keeps (src/utils/account-init-data.ts) and the option that governs
// it (parseCounterfactualAccounts): no database, no chain, no app boot. The last block runs against real contracts
// (read-only eth_calls) only when JSON_RPC_NODE_PROVIDER_1 is set (.env is read); the services that store the keys are
// in test/verification-rules.test.ts.
import * as dotenv from "dotenv";
import {ethers} from "ethers";
import {parseCounterfactualAccounts, StoreInitDataPolicy} from "../src/config/config-manager";
import {
  ACCOUNT_INIT_DATA_MAX_BYTES,
  guardianSetupModule,
  guardianSetupReads,
  InitDataVerification,
  resolveInitData,
} from "../src/utils/account-init-data";
import {AccountDeployment, MULTICALL3_ADDRESS, SimulatedResult, simulateIsValidSignatureAndReads} from "../src/utils/erc6492";
import {isSensitiveKey} from "../src/logging";
import safeSource from "../src/utils/source/Safe.json";
import moduleSourceV0_1_0 from "../src/utils/source/SocialRecoveryModule.v0.1.0.json";
import moduleSourceV0_2_0 from "../src/utils/source/SocialRecoveryModule.v0.2.0.json";
import {guardianDeployment, plainDeployment, STAND_IN_CONTRACTS} from "./guardian-deployment";

dotenv.config();

const ACCOUNT = "0x1111111111111111111111111111111111111111";
const GUARDIAN = "0x9999999999999999999999999999999999999999";
const MODULE_A = "0x38275826e1933303e508433dd5f289315da2541c"; // v0.1.0, 3 days
const MODULE_B = "0x00480f5ecc008995469fa7e12c70ef3dc9fee7fd"; // v0.2.0, 3 days
const FACTORY = "0x4e1dcf7ad4e460cfd30791ccc4f9c8a4f820ec67";

const TRUE = ethers.utils.defaultAbiCoder.encode(["bool"], [true]);
const FALSE = ethers.utils.defaultAbiCoder.encode(["bool"], [false]);
const ok = (returnData: string): SimulatedResult => ({success: true, returnData});
const reverted: SimulatedResult = {success: false, returnData: "0x"};

describe("parseCounterfactualAccounts", () => {
  const DEFAULTS = {erc6492: true, storeInitData: "never"};

  test.each([
    ["omitted", undefined],
    ["null", null],
    ["~", "~"],
    ["an empty object", {}],
  ])("reads %s as the defaults", (_name, value) => {
    expect(parseCounterfactualAccounts(value)).toEqual(DEFAULTS);
  });

  test("takes erc6492 as a boolean, or 'true' / 'false' in any case, and defaults it to true", () => {
    expect(parseCounterfactualAccounts({erc6492: false})).toEqual({erc6492: false, storeInitData: "never"});
    expect(parseCounterfactualAccounts({erc6492: true, storeInitData: "always"})).toEqual({erc6492: true, storeInitData: "always"});
    expect(parseCounterfactualAccounts({erc6492: "FALSE"})).toEqual({erc6492: false, storeInitData: "never"});
    expect(parseCounterfactualAccounts({erc6492: "True"})).toEqual(DEFAULTS);
    expect(parseCounterfactualAccounts({storeInitData: "with-guardian"})).toEqual({erc6492: true, storeInitData: "with-guardian"});
  });

  test.each(["never", "with-guardian", "always"])("takes storeInitData %s", (storeInitData) => {
    expect(parseCounterfactualAccounts({storeInitData})).toEqual({erc6492: true, storeInitData});
  });

  test.each([
    ["a string", "always", "Options.counterfactualAccounts must be an object with 'erc6492' and 'storeInitData', or '~'."],
    ["a list", [true], "Options.counterfactualAccounts must be an object with 'erc6492' and 'storeInitData', or '~'."],
    ["a number", 1, "Options.counterfactualAccounts must be an object with 'erc6492' and 'storeInitData', or '~'."],
    ["an unknown key", {erc6492: true, storeInitdata: "always"}, "Options.counterfactualAccounts has an unknown key 'storeInitdata'."],
    ["erc6492 as a number", {erc6492: 1}, "Options.counterfactualAccounts.erc6492 must be true or false."],
    ["erc6492 as another string", {erc6492: "yes"}, "Options.counterfactualAccounts.erc6492 must be true or false."],
    ["erc6492 as null", {erc6492: null}, "Options.counterfactualAccounts.erc6492 must be true or false."],
    ["storeInitData in another case", {storeInitData: "Always"}, "Options.counterfactualAccounts.storeInitData must be 'never', 'with-guardian' or 'always'."],
    ["storeInitData as a boolean", {storeInitData: true}, "Options.counterfactualAccounts.storeInitData must be 'never', 'with-guardian' or 'always'."],
    ["storeInitData with erc6492 off", {erc6492: false, storeInitData: "with-guardian"}, "Options.counterfactualAccounts.storeInitData must be 'never' when erc6492 is false."],
    ["storeInitData always with erc6492 'false'", {erc6492: "false", storeInitData: "always"}, "Options.counterfactualAccounts.storeInitData must be 'never' when erc6492 is false."],
  ])("refuses %s", (_name, value, message) => {
    expect(() => parseCounterfactualAccounts(value)).toThrow(message);
  });
});

describe("guardianSetupReads", () => {
  const safe = new ethers.utils.Interface(safeSource.abi);
  const modules = [new ethers.utils.Interface(moduleSourceV0_1_0.abi), new ethers.utils.Interface(moduleSourceV0_2_0.abi)];

  test("asks each module in order: enabled on the account, then the guardian on the module", () => {
    const reads = guardianSetupReads(ethers.utils.getAddress(ACCOUNT), GUARDIAN.toUpperCase().replace("0X", "0x"), [MODULE_A, MODULE_B]);
    expect(reads).toEqual([
      {target: ACCOUNT, callData: safe.encodeFunctionData("isModuleEnabled", [MODULE_A])},
      {target: MODULE_A, callData: modules[0].encodeFunctionData("isGuardian", [ACCOUNT, GUARDIAN])},
      {target: ACCOUNT, callData: safe.encodeFunctionData("isModuleEnabled", [MODULE_B])},
      {target: MODULE_B, callData: modules[1].encodeFunctionData("isGuardian", [ACCOUNT, GUARDIAN])},
    ]);
    expect(guardianSetupReads(ACCOUNT, GUARDIAN, [])).toEqual([]);
  });

  test("uses the selectors of the Safe ABI and of both module ABIs", () => {
    const [enabled, guardian] = guardianSetupReads(ACCOUNT, GUARDIAN, [MODULE_A]);
    expect(enabled.callData.slice(0, 10)).toBe(safe.getSighash("isModuleEnabled"));
    for (const module of modules) {
      expect(guardian.callData.slice(0, 10)).toBe(module.getSighash("isGuardian"));
      expect(module.getFunction("isGuardian").inputs.map((input) => input.type)).toEqual(["address", "address"]);
      expect(module.getFunction("isGuardian").outputs!.map((output) => output.type)).toEqual(["bool"]);
    }
    expect(safe.getFunction("isModuleEnabled").outputs!.map((output) => output.type)).toEqual(["bool"]);
  });
});

describe("guardianSetupModule", () => {
  const modules = [MODULE_A, MODULE_B];

  test("finds the module that is enabled and has the guardian", () => {
    expect(guardianSetupModule([ok(TRUE), ok(TRUE), ok(FALSE), ok(FALSE)], modules)).toBe(MODULE_A);
  });

  test("finds the second module when the first is not set up", () => {
    expect(guardianSetupModule([ok(TRUE), ok(FALSE), ok(TRUE), ok(TRUE)], modules)).toBe(MODULE_B);
    expect(guardianSetupModule([ok(FALSE), ok(TRUE), ok(TRUE), ok(TRUE)], modules)).toBe(MODULE_B);
  });

  test("finds none when a module is only enabled, or only has the guardian", () => {
    expect(guardianSetupModule([ok(TRUE), ok(FALSE)], [MODULE_A])).toBeUndefined();
    expect(guardianSetupModule([ok(FALSE), ok(TRUE)], [MODULE_A])).toBeUndefined();
    // each answer of another module does not count
    expect(guardianSetupModule([ok(TRUE), ok(FALSE), ok(FALSE), ok(TRUE)], modules)).toBeUndefined();
  });

  test("finds none when a read failed, or answered empty, short or longer data", () => {
    expect(guardianSetupModule([reverted, ok(TRUE)], [MODULE_A])).toBeUndefined();
    expect(guardianSetupModule([ok(TRUE), reverted], [MODULE_A])).toBeUndefined();
    expect(guardianSetupModule([{success: false, returnData: TRUE}, ok(TRUE)], [MODULE_A])).toBeUndefined();
    expect(guardianSetupModule([ok("0x"), ok(TRUE)], [MODULE_A])).toBeUndefined(); // an address without code
    expect(guardianSetupModule([ok("0x01"), ok(TRUE)], [MODULE_A])).toBeUndefined();
    expect(guardianSetupModule([ok(TRUE + "00"), ok(TRUE)], [MODULE_A])).toBeUndefined();
    expect(guardianSetupModule([ok(ethers.utils.defaultAbiCoder.encode(["uint256"], [2])), ok(TRUE)], [MODULE_A])).toBeUndefined();
  });

  test("finds none when the results do not match the modules in number, and never throws", () => {
    expect(guardianSetupModule([ok(TRUE), ok(TRUE), ok(TRUE)], modules)).toBeUndefined();
    expect(guardianSetupModule([ok(TRUE), ok(TRUE), ok(TRUE), ok(TRUE), ok(TRUE)], modules)).toBeUndefined();
    expect(guardianSetupModule([], [])).toBeUndefined();
    expect(guardianSetupModule(undefined, modules)).toBeUndefined();
    expect(guardianSetupModule([null, undefined] as unknown as SimulatedResult[], [MODULE_A])).toBeUndefined();
    expect(guardianSetupModule([{success: true, returnData: 1}, ok(TRUE)] as unknown as SimulatedResult[], [MODULE_A])).toBeUndefined();
  });
});

describe("resolveInitData", () => {
  const modules = [MODULE_A, MODULE_B];
  const deployment: AccountDeployment = {factory: ethers.utils.getAddress(FACTORY), factoryCalldata: "0x1688F0B9" + "AB".repeat(100)};
  const KEPT = {_factory: ethers.utils.getAddress(FACTORY), _factoryData: deployment.factoryCalldata.toLowerCase()};
  const withGuardian: InitDataVerification = {counterfactual: true, deployment, reads: [ok(FALSE), ok(FALSE), ok(TRUE), ok(TRUE)]};
  const withoutGuardian: InitDataVerification = {counterfactual: true, deployment, reads: [ok(TRUE), ok(FALSE), ok(FALSE), ok(FALSE)]};
  const withCalldata = (bytes: number): InitDataVerification =>
    ({...withGuardian, deployment: {...deployment, factoryCalldata: "0x" + "ab".repeat(bytes)}});

  test("keeps nothing and logs nothing under 'never', whatever the verification", () => {
    for (const verification of [withGuardian, withoutGuardian, withCalldata(ACCOUNT_INIT_DATA_MAX_BYTES + 1), {counterfactual: false}]) {
      expect(resolveInitData("never", verification, modules)).toEqual({entries: {}, log: {}});
    }
  });

  test.each(["with-guardian", "always"] as StoreInitDataPolicy[])("keeps nothing and logs nothing for a deployed account (%s)", (policy) => {
    expect(resolveInitData(policy, {counterfactual: false}, modules)).toEqual({entries: {}, log: {}});
    // the validator never returns a deployment then, but a deployment without counterfactual is not kept either
    expect(resolveInitData(policy, {counterfactual: false, deployment, reads: []}, modules)).toEqual({entries: {}, log: {}});
  });

  test("keeps the data with the guardian under 'with-guardian'", () => {
    expect(resolveInitData("with-guardian", withGuardian, modules)).toEqual({
      entries: KEPT,
      log: {guardianInstalled: true, guardianModule: MODULE_B, initData: "kept"},
    });
  });

  test("keeps nothing without the guardian under 'with-guardian'", () => {
    expect(resolveInitData("with-guardian", withoutGuardian, modules)).toEqual({
      entries: {},
      log: {guardianInstalled: false, initData: "no-guardian"},
    });
    // no reads (the check did not run): no guardian found
    expect(resolveInitData("with-guardian", {counterfactual: true, deployment, reads: []}, modules)).toEqual({
      entries: {},
      log: {guardianInstalled: false, initData: "no-guardian"},
    });
  });

  test("keeps the data either way under 'always'", () => {
    expect(resolveInitData("always", withGuardian, modules)).toEqual({
      entries: KEPT,
      log: {guardianInstalled: true, guardianModule: MODULE_B, initData: "kept"},
    });
    expect(resolveInitData("always", withoutGuardian, modules)).toEqual({
      entries: KEPT,
      log: {guardianInstalled: false, initData: "kept"},
    });
  });

  test.each(["with-guardian", "always"] as StoreInitDataPolicy[])("keeps calldata of exactly the cap, not one byte more (%s)", (policy) => {
    expect(ACCOUNT_INIT_DATA_MAX_BYTES).toBe(16384);
    const atCap = resolveInitData(policy, withCalldata(16384), modules);
    expect(atCap.entries).toEqual({_factory: KEPT._factory, _factoryData: "0x" + "ab".repeat(16384)});
    expect(atCap.log.initData).toBe("kept");
    expect(resolveInitData(policy, withCalldata(16385), modules)).toEqual({entries: {}, log: {guardianInstalled: true, initData: "too-large"}});
    expect(resolveInitData(policy, {...withoutGuardian, deployment: withCalldata(16385).deployment}, modules))
      .toEqual({entries: {}, log: {guardianInstalled: false, initData: "too-large"}});
  });

  test("the log fields are written, not redacted, and never carry the data", () => {
    for (const key of ["guardianInstalled", "guardianModule", "initData"]) {
      expect(isSensitiveKey(key)).toBe(false);
    }
    const {log} = resolveInitData("always", withGuardian, modules);
    expect(JSON.stringify(log)).not.toContain(deployment.factoryCalldata.toLowerCase().slice(2, 20));
    expect(JSON.stringify(log).toLowerCase()).not.toContain(FACTORY);
  });
});

/// Against real contracts (Safe 1.4.1, the recovery modules, Multicall3), read-only: the guardian check sees a deployment
// that installs the guardian, and not a plain one. Both are the stand-ins of test/guardian-deployment.ts, which
// test/auth.test.ts registers over HTTP. No valid SIWE signature is needed here: the reads come back when
// isValidSignature fails.
const jsonRpcNodeProvider = process.env.JSON_RPC_NODE_PROVIDER_1;
(jsonRpcNodeProvider ? describe : describe.skip)("guardian check on chain (JSON_RPC_NODE_PROVIDER_1)", () => {
  jest.setTimeout(120000);
  const modules = [MODULE_A, MODULE_B];
  const provider = new ethers.providers.StaticJsonRpcProvider(jsonRpcNodeProvider);
  const owner = ethers.Wallet.createRandom();
  const guardian = ethers.Wallet.createRandom().address;
  const hash = ethers.utils.keccak256(ethers.utils.toUtf8Bytes("not signed by the account"));
  const guardianCheck = async (account: string, deployment: AccountDeployment) =>
    simulateIsValidSignatureAndReads(
      provider, MULTICALL3_ADDRESS, deployment, account, hash, "0x" + "00".repeat(65), guardianSetupReads(account, guardian, modules)
    );

  beforeAll(async () => {
    for (const address of [...STAND_IN_CONTRACTS, ...modules]) {
      expect([address, await provider.getCode(address)]).not.toEqual([address, "0x"]);
    }
  });

  test("a plain deployment does not install the guardian", async () => {
    const {account, deployment} = await plainDeployment(provider, owner.address);
    expect(await provider.getCode(account)).toBe("0x");
    const {valid, reads} = await guardianCheck(account, deployment);
    expect(valid).toBe(false);
    // the Safe exists in the simulation: it answers, with no module enabled
    expect(reads).toEqual([ok(FALSE), ok(FALSE), ok(FALSE), ok(FALSE)]);
    expect(guardianSetupModule(reads, modules)).toBeUndefined();
    expect(resolveInitData("with-guardian", {counterfactual: true, deployment, reads}, modules))
      .toEqual({entries: {}, log: {guardianInstalled: false, initData: "no-guardian"}});
  });

  test("a deployment that enables the module and adds the guardian is found", async () => {
    const {account, deployment} = await guardianDeployment(provider, owner, MODULE_B, guardian);
    expect(await provider.getCode(account)).toBe("0x");
    const {valid, reads} = await guardianCheck(account, deployment);
    expect(valid).toBe(false);
    expect(reads).toEqual([ok(FALSE), ok(FALSE), ok(TRUE), ok(TRUE)]);
    expect(guardianSetupModule(reads, modules)).toBe(MODULE_B);
    expect(resolveInitData("with-guardian", {counterfactual: true, deployment, reads}, modules)).toEqual({
      entries: {_factory: MULTICALL3_ADDRESS, _factoryData: deployment.factoryCalldata.toLowerCase()},
      log: {guardianInstalled: true, guardianModule: MODULE_B, initData: "kept"},
    });
    // another guardian is not found on the same deployment
    const other = await simulateIsValidSignatureAndReads(
      provider, MULTICALL3_ADDRESS, deployment, account, hash, "0x" + "00".repeat(65),
      guardianSetupReads(account, ethers.Wallet.createRandom().address, modules),
    );
    expect(guardianSetupModule(other.reads, modules)).toBeUndefined();
  });
});
