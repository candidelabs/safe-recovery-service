import {ethers} from "ethers";
import {AccountDeployment, SimulatedCall, SimulatedResult} from "./erc6492";
import {AccountMetadata} from "./account-metadata";
import type {StoreInitDataPolicy} from "../config/config-manager";

// The init data of an account that registers before it is deployed (POST /v1/auth/register with an ERC-6492 signature
// of an account without code): the deployment call the signature check already ran in simulation, kept under the
// reserved metadata keys _factory and _factoryData (options.counterfactualAccounts.storeInitData) so that the account
// lookup can return it to a user who lost the wallet before the first transaction. Pure: ethers only, no database, no
// network, so the rules are tested without either.
//
// Security and privacy notes:
// - Verified once, at registration. The keys say that when the account registered, calling _factory with _factoryData
//   put code at this address that accepted the account's signature (and, under "with-guardian", had this service's
//   guardian on a configured recovery module). Nothing checks it again. A wallet must read eth_getCode first and ignore
//   the keys once the account has code.
// - Only the account writes them. The write needs a request signed by the account, verified by simulating that very
//   deployment, so nobody can replace another account's init data.
// - The factory is the registrant's choice. CREATE2 binds an address to its factory, so the data can only deploy the
//   registrant's own account, but _factory is an arbitrary contract: a wallet should match it against the factories it
//   knows before calling it. The service broadcasts it in one place only, the sponsored deployment
//   (src/services/sponsored-deployment.service.ts), and only for a factory on the network's allowlist
//   (deployAccounts.factories), after simulating it again; its notes are in src/utils/sponsored-deployment.ts.
// - Written by the service, unlike the app's keys: the guidance that metadata is "a name the app stored, not a statement
//   by the service" holds for the app's keys only.
// - More revealing than a label. The init data shows the owner set (or a passkey's public key) before it is on chain, to
//   whoever proves a registered target and to the operator, who stores it in plaintext.
// - Bounded. At most ACCOUNT_INIT_DATA_MAX_BYTES of calldata per account and chain, behind a SIWE signature and a
//   verified target, as registrations already are.
// - Never logged: log lines carry guardianInstalled, guardianModule (a configured, public module address) and initData
//   (what was done), never the factory, the calldata or the signature that carries them.

/** The largest factoryCalldata kept, in bytes; a two-owner Safe's createProxyWithNonce call is under 1 KB. */
export const ACCOUNT_INIT_DATA_MAX_BYTES = 16384;

// The two reads of the guardian check, by selector. test/account-init-data.test.ts pins them to the Safe ABI and both
// recovery module ABIs.
const SAFE_MODULES = new ethers.utils.Interface(["function isModuleEnabled(address module) view returns (bool)"]);
const RECOVERY_MODULE_GUARDIANS = new ethers.utils.Interface(["function isGuardian(address wallet, address guardian) view returns (bool)"]);
const TRUE = ethers.utils.defaultAbiCoder.encode(["bool"], [true]);

/**
 * The reads that tell whether deploying the account installs the guardian, run after the factory call in the same
 * simulation: for each module, in config order, `account.isModuleEnabled(module)` then `module.isGuardian(account,
 * guardian)`.
 */
export function guardianSetupReads(account: string, guardian: string, moduleAddresses: string[]): SimulatedCall[] {
  const wallet = account.toLowerCase();
  return moduleAddresses.flatMap((module) => [
    {target: wallet, callData: SAFE_MODULES.encodeFunctionData("isModuleEnabled", [module.toLowerCase()])},
    {target: module.toLowerCase(), callData: RECOVERY_MODULE_GUARDIANS.encodeFunctionData("isGuardian", [wallet, guardian.toLowerCase()])},
  ]);
}

const isTrue = (result: SimulatedResult | undefined): boolean =>
  result !== undefined && result !== null && result.success === true
  && typeof result.returnData === "string" && result.returnData.toLowerCase() === TRUE;

/**
 * The first module (as given) whose two reads both answered a 32-byte `true`: enabled on the account, with the guardian.
 * Undefined when there is none, and when the results do not match the modules in number. Never throws.
 */
export function guardianSetupModule(results: SimulatedResult[] | undefined, moduleAddresses: string[]): string | undefined {
  if (!Array.isArray(results) || results.length !== moduleAddresses.length * 2) return undefined;
  return moduleAddresses.find((_module, index) => isTrue(results[2 * index]) && isTrue(results[2 * index + 1]));
}

/** What the SIWE check of a registration found (SiweVerification of src/utils/utilities.ts). */
export interface InitDataVerification {
  counterfactual: boolean;
  deployment?: AccountDeployment;
  reads?: SimulatedResult[];
}

/** The fields a registration's log line gets; none of them reveals the init data. */
export interface InitDataLogFields {
  guardianInstalled?: boolean;
  guardianModule?: string;
  initData?: "kept" | "too-large" | "no-guardian";
}

/** What a registration keeps: `{}` or `{_factory, _factoryData}`, and the fields of its log line. */
export interface InitDataResolution {
  entries: AccountMetadata;
  log: InitDataLogFields;
}

/**
 * What a registration keeps of the deployment its signature check simulated, under the policy; the first rule that
 * matches wins:
 * - "never", or an account that was deployed (or an unwrapped signature): nothing, no log field;
 * - factoryCalldata over ACCOUNT_INIT_DATA_MAX_BYTES: nothing (initData "too-large");
 * - "with-guardian" and no configured module with the guardian: nothing (initData "no-guardian");
 * - otherwise (the guardian found, or "always"): `_factory` (checksummed) and `_factoryData` (lower-case hex).
 * Not keeping never removes: a registration that keeps nothing writes no reserved key.
 */
export function resolveInitData(policy: StoreInitDataPolicy, verification: InitDataVerification, moduleAddresses: string[]): InitDataResolution {
  const {counterfactual, deployment} = verification;
  if (policy === "never" || !counterfactual || deployment === undefined) return {entries: {}, log: {}};
  const guardianModule = guardianSetupModule(verification.reads, moduleAddresses);
  const guardianInstalled = guardianModule !== undefined;
  if ((ethers.utils.hexDataLength(deployment.factoryCalldata) ?? Infinity) > ACCOUNT_INIT_DATA_MAX_BYTES) {
    return {entries: {}, log: {guardianInstalled, initData: "too-large"}};
  }
  if (policy === "with-guardian" && !guardianInstalled) {
    return {entries: {}, log: {guardianInstalled, initData: "no-guardian"}};
  }
  return {
    entries: {
      _factory: ethers.utils.getAddress(deployment.factory),
      _factoryData: deployment.factoryCalldata.toLowerCase(),
    },
    log: {guardianInstalled, ...(guardianInstalled ? {guardianModule} : {}), initData: "kept"},
  };
}
