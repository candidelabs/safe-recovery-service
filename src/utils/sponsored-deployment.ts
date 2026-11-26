import {createHash} from "node:crypto";
import {ethers} from "ethers";
import {AccountDeployment, SimulatedCall, SimulatedResult} from "./erc6492";
import {ACCOUNT_INIT_DATA_MAX_BYTES} from "./account-init-data";
import type {DeployAccountsRateLimit} from "../config/config-manager";

// The rules of the sponsored deployment of an undeployed account (POST /v1/auth/accounts/deploy): the service sends,
// with a signer the operator configured (networks.<name>.deployAccounts), the deployment call kept at registration
// under the reserved metadata keys _factory / _factoryData (src/utils/account-init-data.ts), for whoever proves a
// target registered for the account with a verifiedTargetToken. Pure: ethers only, no database, no network, so the
// rules are tested without either; src/services/sponsored-deployment.service.ts applies them.
//
// Security notes:
// - What is paid for is the registrant's calldata. The factory allowlist (deployAccounts.factories) fixes the contract
//   that is called; the singleton and the initializer inside the call are still the registrant's choice, and the
//   expected way to install the guardian is a delegate call from setup(), so arbitrary code runs inside the deployment.
//   What bounds it: the gas cap the chain executor enforces (maxGasLimit, which code that behaves differently once
//   mined cannot game, unlike the estimate), SPONSORED_DEPLOYMENT_MAX_MINED_FAILURES (and, in all,
//   SPONSORED_DEPLOYMENT_MAX_ATTEMPTS) per account, the rate limits, and the
//   token.
// - The paying key's exposure is gas, and tx.origin. A listed factory must not treat its caller specially; nothing the
//   service's keys do relies on tx.origin. A dedicated signer keeps the blast radius and the queue apart; sharing the
//   guardian's key is allowed and warned about at boot.
// - Sponsorship lowers no security bar. Whoever holds the token already gets the init data from the account lookup and
//   can deploy the account themselves; the service removes only the gas cost.
// - A listed factory must not depend on its caller. The simulation runs with Multicall3 as the caller, the transaction
//   comes from the paying signer: senderCheck catches the factories that return the address they create, and the code
//   check after mining catches the rest, after one paid attempt.
// - Losing a race costs gas. If someone else deploys the account between the executor's estimate and mining, the
//   factory call reverts on the CREATE2 collision and uses most of its gas limit. The executor estimates right before
//   broadcasting, so the window is one block, and it is one of the account's mined failures.
// - Single instance. The claim (one row per account and chain) and the limits (counted and claimed under a per-chain
//   database lock) hold across processes, but the executor's queue, and the boot release that fails every PENDING row
//   of a previous process, assume one process.
// - Privacy. Deploying puts the owner set on chain earlier than the user would have. The request needs a verified,
//   registered target. Never logged: _factory, _factoryData, the target, the requester hash, the token.

/**
 * Attempts per account and chain, ever, whose transaction was mined and failed (SPONSORED_DEPLOYMENT_MINED_FAILURES):
 * they spent the paying signer's gas. A FAILED row with this many is not tried again.
 */
export const SPONSORED_DEPLOYMENT_MAX_MINED_FAILURES = 3;
/**
 * Attempts per account and chain, ever, whatever their outcome, so that a deployment that never gets mined (the
 * process stops, the transaction expires, the estimate reverts) is not tried again forever.
 */
export const SPONSORED_DEPLOYMENT_MAX_ATTEMPTS = 10;
/**
 * The failures of an attempt whose transaction was mined and failed. The others sent nothing that stayed on chain,
 * except "unconfirmed": mined without reverting, but not known to have failed.
 */
export const SPONSORED_DEPLOYMENT_MINED_FAILURES: readonly string[] = ["reverted", "no-code"];
/**
 * After a transaction is mined without reverting, the account's code is read up to this many times, this far apart,
 * until a read finds it: behind a load-balanced RPC a read can reach a node that has not imported the block yet. When
 * no read found code and at least one answered 0x, the attempt is "no-code", whatever the order of the answers and the
 * failed reads (5 reads over 15 s).
 */
export const SPONSORED_DEPLOYMENT_CODE_READS = 5;
export const SPONSORED_DEPLOYMENT_CODE_READ_INTERVAL_MS = 3_750;
/**
 * When every one of those reads failed, which says nothing either way, the code is read again up to this many times,
 * this far apart (5 minutes), and the first read that answers decides: code is deployed, 0x is "no-code" (minutes after
 * mining, a node behind the others is no longer the likely reason). When none answers the attempt is "unconfirmed",
 * never DEPLOYED: a DEPLOYED row is answered with no chain call, so a wrong one could never be tried again.
 */
export const SPONSORED_DEPLOYMENT_CODE_RECHECKS = 20;
export const SPONSORED_DEPLOYMENT_CODE_RECHECK_INTERVAL_MS = 15_000;
/**
 * A PENDING row older than this was orphaned (its process stopped): the chain executor's 2 h lifetime and its 30 min
 * cancel phase, plus a margin.
 */
export const SPONSORED_DEPLOYMENT_PENDING_MAX_MS = 3 * 60 * 60 * 1000;
/** What the chain executor adds to a gas estimate (populateTxGasPricesAndLimits). */
export const SPONSORED_DEPLOYMENT_GAS_FACTOR = 1.25;

export const SPONSORED_DEPLOYMENT_STATUSES = ["PENDING", "DEPLOYED", "FAILED"] as const;
export type SponsoredDeploymentStatus = typeof SPONSORED_DEPLOYMENT_STATUSES[number];

/** Why an attempt failed: the chain executor's reasons, then the service's own. */
export const SPONSORED_DEPLOYMENT_FAILURE_REASONS = [
  "would-revert", "retries-exhausted", "expired", "reverted", "gas-limit-exceeded",
  // the process stopped while it was pending (found at boot, or stale)
  "interrupted",
  // mined without reverting, no read found code at the account and at least one answered 0x
  "no-code",
  // mined without reverting, but no code read answered (SPONSORED_DEPLOYMENT_CODE_RECHECKS): not a mined failure; a
  // later request reads the code first, and code found keeps this attempt's hash
  "unconfirmed",
] as const;
export type SponsoredDeploymentFailureReason = typeof SPONSORED_DEPLOYMENT_FAILURE_REASONS[number];

/** The fields of a SponsoredDeployment row the rules read. */
export interface SponsoredDeploymentRow {
  id: string;
  account: string;
  chainId: number;
  status: string;
  // the attempt number, the fence of every conditional update of the row
  attempts: number;
  // of them, the attempts whose transaction was mined and failed
  minedAttempts: number;
  transactionHash: string | null;
  failureReason: string | null;
  requestedAt: Date;
}

const isPlainObject = (value: unknown): value is Record<string, unknown> => {
  const prototype = typeof value === "object" && value !== null && !Array.isArray(value) ? Object.getPrototypeOf(value) : undefined;
  return prototype === Object.prototype || prototype === null;
};

/**
 * The init data stored for an account (its AuthAccountMetadata.metadata): `{factory, factoryCalldata}` when both
 * reserved keys are there, `_factory` is an address and `_factoryData` is hex of at most ACCOUNT_INIT_DATA_MAX_BYTES;
 * undefined otherwise. Never throws.
 */
export function storedInitData(metadata: unknown): AccountDeployment | undefined {
  if (!isPlainObject(metadata)) return undefined;
  const factory = metadata._factory;
  const factoryCalldata = metadata._factoryData;
  if (typeof factory !== "string" || !ethers.utils.isAddress(factory)) return undefined;
  if (typeof factoryCalldata !== "string" || !ethers.utils.isHexString(factoryCalldata) || factoryCalldata.length % 2 !== 0) return undefined;
  if ((factoryCalldata.length - 2) / 2 > ACCOUNT_INIT_DATA_MAX_BYTES) return undefined;
  return {factory: ethers.utils.getAddress(factory), factoryCalldata: factoryCalldata.toLowerCase()};
}

const SAFE_THRESHOLD = new ethers.utils.Interface(["function getThreshold() view returns (uint256)"]);

/** The read that tells whether the factory call left Safe-like code at the account's address: getThreshold(). */
export function deploymentProbe(account: string): SimulatedCall {
  return {target: account.toLowerCase(), callData: SAFE_THRESHOLD.encodeFunctionData("getThreshold")};
}

/** The probe answered: it succeeded with 32 bytes that are not zero. */
export function probeAnswered(result: SimulatedResult | undefined): boolean {
  if (result === undefined || result === null || result.success !== true || typeof result.returnData !== "string") return false;
  if (!ethers.utils.isHexString(result.returnData) || ethers.utils.hexDataLength(result.returnData) !== 32) return false;
  return !ethers.BigNumber.from(result.returnData).isZero();
}

/**
 * What the factory call answers when the paying signer is its caller: "match" for exactly 32 bytes that decode to the
 * account's address, "mismatch" for 32 bytes holding another address (the factory would deploy somewhere else for this
 * sender), "unknown" for anything else (a factory that returns nothing, or more).
 */
export function senderCheck(returnData: unknown, account: string): "match" | "mismatch" | "unknown" {
  if (typeof returnData !== "string" || !ethers.utils.isHexString(returnData) || ethers.utils.hexDataLength(returnData) !== 32) {
    return "unknown";
  }
  // an ABI-encoded address: twelve zero bytes, then the address
  if (!/^0x0{24}/.test(returnData)) return "unknown";
  const address = ethers.utils.hexDataSlice(returnData, 12).toLowerCase();
  return address === account.toLowerCase() ? "match" : "mismatch";
}

/**
 * The per-target limit's key: the SHA-256 (hex) of the channel and the normalized target of the token that asked. Not
 * anonymity (an email address is guessable), only the plain target kept out of a table that is never deleted from.
 */
export function requesterHash(channel: string, target: string): string {
  return createHash("sha256").update(`${channel}:${target}`).digest("hex");
}

/**
 * The limit reached, if any: the deployments of this target's tokens, then of the network, in the window (counts
 * leave out the account asked for). A count at its maximum has reached it.
 */
export function reachedLimit(
  limits: DeployAccountsRateLimit | undefined,
  counts: {target: number; total: number},
): "target" | "total" | undefined {
  if (!limits) return undefined;
  if (limits.maxPerTarget !== undefined && counts.target >= limits.maxPerTarget) return "target";
  if (limits.maxTotal !== undefined && counts.total >= limits.maxTotal) return "total";
  return undefined;
}

/**
 * What a request does with the account's row:
 * - create: no row (the first attempt);
 * - answer: DEPLOYED, or PENDING and not stale (nothing is sent);
 * - stale: PENDING for SPONSORED_DEPLOYMENT_PENDING_MAX_MS or more (its process stopped), it fails as "interrupted"
 *   and the request goes on as a retry;
 * - retry: FAILED with attempts left;
 * - exhausted: FAILED after SPONSORED_DEPLOYMENT_MAX_MINED_FAILURES mined failures, or after
 *   SPONSORED_DEPLOYMENT_MAX_ATTEMPTS attempts in all (attemptsExhausted says which).
 */
export function nextStep(
  row: Pick<SponsoredDeploymentRow, "status" | "attempts" | "minedAttempts" | "requestedAt"> | null | undefined,
  now: Date,
): "create" | "answer" | "stale" | "retry" | "exhausted" {
  if (!row) return "create";
  if (row.status === "PENDING") {
    return now.getTime() - row.requestedAt.getTime() >= SPONSORED_DEPLOYMENT_PENDING_MAX_MS ? "stale" : "answer";
  }
  if (row.status === "FAILED") {
    return attemptsExhausted(row) === undefined ? "retry" : "exhausted";
  }
  return "answer";
}

/** Which cap an account reached: its mined failures first, then its attempts in all; undefined while it may retry. */
export function attemptsExhausted(row: Pick<SponsoredDeploymentRow, "attempts" | "minedAttempts">): "mined" | "attempts" | undefined {
  if (row.minedAttempts >= SPONSORED_DEPLOYMENT_MAX_MINED_FAILURES) return "mined";
  if (row.attempts >= SPONSORED_DEPLOYMENT_MAX_ATTEMPTS) return "attempts";
  return undefined;
}

/** Whether an attempt that failed for this reason had its transaction mined (it counts toward the mined cap). */
export const isMinedFailure = (reason: string): boolean => SPONSORED_DEPLOYMENT_MINED_FAILURES.includes(reason);

export type DeploymentStatusView = "pending" | "deployed" | "failed";

/** GET /v1/auth/accounts/deployment: a row as the client sees it. */
export interface DeploymentView {
  account: string;
  chainId: number;
  status: DeploymentStatusView;
  // when this service's transaction deployed the account, or the mined hash of a failed attempt
  transactionHash?: string;
  failureReason?: string;
  attempts: number;
  requestedAt: string;
}

const statusView = (status: string): DeploymentStatusView =>
  status === "DEPLOYED" ? "deployed" : status === "FAILED" ? "failed" : "pending";

export function deploymentView(row: SponsoredDeploymentRow): DeploymentView {
  return {
    account: row.account.toLowerCase(),
    chainId: row.chainId,
    status: statusView(row.status),
    ...(row.transactionHash ? {transactionHash: row.transactionHash} : {}),
    ...(row.status === "FAILED" && row.failureReason ? {failureReason: row.failureReason} : {}),
    attempts: row.attempts,
    requestedAt: row.requestedAt.toISOString(),
  };
}

/** POST /v1/auth/accounts/deploy: the account, its chain, the status and, once deployed by this service, the hash. */
export interface DeploymentAnswer {
  account: string;
  chainId: number;
  status: DeploymentStatusView;
  transactionHash?: string;
  failureReason?: string;
}

export function deploymentAnswer(view: Pick<DeploymentView, "account" | "chainId" | "status" | "transactionHash" | "failureReason">): DeploymentAnswer {
  return {
    account: view.account.toLowerCase(),
    chainId: view.chainId,
    status: view.status,
    ...(view.status === "deployed" && view.transactionHash ? {transactionHash: view.transactionHash} : {}),
    ...(view.status === "failed" && view.failureReason ? {failureReason: view.failureReason} : {}),
  };
}
