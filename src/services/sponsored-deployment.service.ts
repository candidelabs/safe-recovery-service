import httpStatus from "http-status";
import {ethers} from "ethers";
import {Prisma} from "@prisma/client";
import {prisma} from "../config/prisma-client";
import {Network} from "../models/network";
import {Signers} from "../models/signer/signers";
import {ApiError} from "../utils/error";
import {Erc6492Error, hasCode, isNodeExecutionError, SimulatedCall, SimulatedResult, simulateDeploymentReads} from "../utils/erc6492";
import {parseSeconds, scaleBigNumber} from "../utils/utilities";
import {guardianSetupModule, guardianSetupReads} from "../utils/account-init-data";
import {
  attemptsExhausted,
  DeploymentAnswer,
  deploymentAnswer,
  isMinedFailure,
  SPONSORED_DEPLOYMENT_CODE_READ_INTERVAL_MS,
  SPONSORED_DEPLOYMENT_CODE_READS,
  SPONSORED_DEPLOYMENT_MAX_MINED_FAILURES,
  deploymentProbe,
  DeploymentView,
  deploymentView,
  nextStep,
  probeAnswered,
  reachedLimit,
  requesterHash,
  senderCheck,
  SPONSORED_DEPLOYMENT_GAS_FACTOR,
  SPONSORED_DEPLOYMENT_MAX_ATTEMPTS,
  SponsoredDeploymentFailureReason,
  SponsoredDeploymentRow,
  storedInitData,
} from "../utils/sponsored-deployment";
import {ChainExecutor, ChainExecutorFailureReason} from "./chain-executor.service";
import {GasPriceEstimator} from "./gas-price-estimator.service";
import {requireVerifiedTarget} from "./verification.service";
import {registrationGuardian} from "./auth.service";
import logger from "../utils/logger";

// The sponsored deployment of an undeployed account (POST /v1/auth/accounts/deploy, GET /v1/auth/accounts/deployment):
// the rules and the security notes are in src/utils/sponsored-deployment.ts. Log lines carry the deployment's id, the
// account, the chain, the signer id, the verification id, the attempt and the outcome; never _factory, _factoryData,
// the target, the requester hash or the token.

const log = logger.child({ component: "sponsored-deployment" });

// Rows of this process were requested at or after this; releaseOrphanedDeployments leaves them alone.
const processStartedAt = new Date();

/** Why a deploy request was refused (details.reason of the error). */
export type SponsoredDeploymentRefusal =
  | "sponsorship-disabled"
  | "not-registered"
  | "attempts-exhausted"
  | "no-init-data"
  | "factory-not-sponsored"
  | "limit-target"
  | "limit-total"
  | "deployment-would-fail"
  | "no-guardian"
  | "gas-limit"
  | "sponsorship-unavailable";

/** What POST /v1/auth/accounts/deploy answers: 202 while pending, 200 otherwise. */
export interface DeploymentResponse {
  statusCode: number;
  body: DeploymentAnswer;
}

interface RequestContext {
  account: string;
  chainId: number;
  verificationId?: string;
}

const unavailable = (chainId: number) => `Sponsored deployments are temporarily unavailable on this network (${chainId})`;
const WOULD_FAIL = "The init data stored for this account does not deploy it on this chain";

// A refusal: its line, and the error with details.reason. No message quotes the factory, the calldata or the target.
const refuse = (
  context: RequestContext,
  statusCode: number,
  reason: SponsoredDeploymentRefusal,
  message: string,
  fields: Record<string, unknown> = {},
): ApiError => {
  log.info(
    { account: context.account, chainId: context.chainId, verificationId: context.verificationId, reason, statusCode, ...fields },
    "sponsored deployment refused"
  );
  return new ApiError(statusCode, message, true, "", {reason});
};

const findRow = (account: string, chainId: number): Promise<SponsoredDeploymentRow | null> =>
  prisma.sponsoredDeployment.findFirst({where: {account: account.toLowerCase(), chainId}});

const answerRow = (row: SponsoredDeploymentRow): DeploymentResponse => {
  const view = deploymentView(row);
  return {statusCode: view.status === "pending" ? httpStatus.ACCEPTED : httpStatus.OK, body: deploymentAnswer(view)};
};

// After a claim lost to another request (or an update that found the row changed): the row as it is now.
const answerCurrent = async (account: string, chainId: number): Promise<DeploymentResponse> => {
  const row = await findRow(account, chainId);
  if (!row) throw new Error("sponsored deployment row not found after a lost claim");
  return answerRow(row);
};

/**
 * The deployments of a network requested since `since`, whatever their status: of one requester (its hash) when
 * given, leaving out one account's row when given (a retry of that account is not counted twice). `db` is the
 * transaction of the claim when the count decides it.
 */
export const countSponsoredDeployments = (
  chainId: number,
  since: Date,
  requester?: string,
  exceptAccount?: string,
  db: Prisma.TransactionClient = prisma,
): Promise<number> => db.sponsoredDeployment.count({
  where: {
    chainId,
    requestedAt: {gte: since},
    ...(requester === undefined ? {} : {requesterHash: requester}),
    ...(exceptAccount === undefined ? {} : {account: {not: exceptAccount.toLowerCase()}}),
  },
});

// The limits hold under parallel requests because the count that admits a deployment and its claim are made in one
// transaction holding a per-chain Postgres advisory lock (this class, the chain id): requests for one chain, in any
// number of processes on the database, are admitted one after the other, and a request refused for a limit writes
// nothing. The lock is held for two counts and one write only; the chain checks run before it.
// The transaction is pinned to READ COMMITTED, whatever the database's default: each statement after the lock must see
// what the previous holder committed. Under REPEATABLE READ or SERIALIZABLE the snapshot is taken by the first
// statement, the lock itself, before the lock is granted, so the count misses the previous holder's claim and the
// limits fail. A "stronger" level is what breaks them.
const SPONSORED_DEPLOYMENT_LOCK_CLASS = 0x53444550;
const CLAIM_TRANSACTION = {maxWait: 5_000, timeout: 10_000, isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted};

// How settleDeployment waits between its code reads; tests replace it so that they do not sleep.
export const settlementTiming = {
  wait: (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms)),
};

// A PENDING or FAILED row of an account that has code: someone deployed it (this service's transaction included, when
// its outcome is not in yet). The hash of an earlier attempt did not deploy it, so none is kept.
const markFoundDeployed = async (row: SponsoredDeploymentRow): Promise<void> => {
  const {count} = await prisma.sponsoredDeployment.updateMany({
    where: {id: row.id, status: row.status, attempts: row.attempts},
    data: {status: "DEPLOYED", transactionHash: null, failureReason: null},
  });
  if (count === 1) {
    log.info({ deploymentId: row.id, account: row.account, chainId: row.chainId }, "sponsored deployment found deployed");
  }
};

/**
 * POST /v1/auth/accounts/deploy: deploys the account from its stored init data, paid by the network's
 * deployAccounts.signer, for the holder of a verifiedTargetToken whose target is registered for it. The first step that
 * matches answers (the table of the plan, in order): no chain call before the code check, no row for an account that
 * was already deployed, nothing sent on a refusal.
 */
export const deployAccount = async (account: string, chainId: number, verifiedTargetToken: string): Promise<DeploymentResponse> => {
  const network = Network.instances.get(chainId.toString())!;
  account = account.toLowerCase();
  const context: RequestContext = {account, chainId};
  // 1. the network sponsors deployments
  const config = network.deployAccounts;
  if (!config.enabled) {
    throw refuse(context, httpStatus.FORBIDDEN, "sponsorship-disabled", `Deployment sponsorship is not enabled for this network (${chainId})`);
  }
  // 2. the token (its own 403 and line)
  const {verificationId, channel, target} = await requireVerifiedTarget(verifiedTargetToken, "deploy");
  context.verificationId = verificationId;
  // 3. its target is registered for the account on this chain
  const registrations = await prisma.authRegistration.count({where: {account, chainId, channel, target}});
  if (registrations === 0) {
    throw refuse(context, httpStatus.FORBIDDEN, "not-registered", `This verifiedTargetToken's target is not registered for this account on this chain`);
  }
  // 4. deployed by this service
  let row = await findRow(account, chainId);
  if (row?.status === "DEPLOYED") return answerRow(row);
  // 5. deployed at all: the first chain call
  const provider = network.jsonRPCProvider;
  if (await hasCode(provider, account)) {
    if (row) await markFoundDeployed(row);
    return {statusCode: httpStatus.OK, body: {account, chainId, status: "deployed"}};
  }
  // 6. pending, or stale; 7. out of attempts
  const now = new Date();
  let step = nextStep(row, now);
  if (step === "answer") return answerRow(row!);
  if (step === "stale") {
    const stale = row!;
    const {count} = await prisma.sponsoredDeployment.updateMany({
      where: {id: stale.id, status: "PENDING", attempts: stale.attempts},
      data: {status: "FAILED", failureReason: "interrupted"},
    });
    if (count === 0) return answerCurrent(account, chainId);
    log.warn(
      { deploymentId: stale.id, account, chainId, reason: "interrupted", attempt: stale.attempts },
      "sponsored deployment failed"
    );
    row = {...stale, status: "FAILED", failureReason: "interrupted"};
    step = nextStep(row, now);
  }
  if (step === "exhausted") {
    throw refuse(
      context, httpStatus.CONFLICT, "attempts-exhausted",
      attemptsExhausted(row!) === "mined"
        ? `The sponsored deployment of this account failed on chain ${SPONSORED_DEPLOYMENT_MAX_MINED_FAILURES} times; it will not be tried again`
        : `The sponsored deployment of this account was attempted ${SPONSORED_DEPLOYMENT_MAX_ATTEMPTS} times; it will not be tried again`
    );
  }
  // 8. the init data kept at registration
  const metadata = await prisma.authAccountMetadata.findFirst({where: {account, chainId}, select: {metadata: true}});
  const deployment = storedInitData(metadata?.metadata);
  if (!deployment) {
    throw refuse(context, httpStatus.CONFLICT, "no-init-data", `No init data is stored for this account on this chain`);
  }
  // 9. its factory is on the network's allowlist
  if (!config.factories.includes(deployment.factory.toLowerCase())) {
    throw refuse(context, httpStatus.FORBIDDEN, "factory-not-sponsored", `The factory of this account is not sponsored on this network (${chainId})`);
  }
  // 10. the limits: distinct accounts in the window, failed attempts included, the account asked for left out. This
  // early count spares the chain checks below; the count that admits is made again with the claim (14).
  const requester = requesterHash(channel, target);
  const {rateLimit} = config;
  const limitAt = async (at: Date, db: Prisma.TransactionClient = prisma): Promise<"target" | "total" | undefined> => {
    if (!rateLimit) return undefined;
    const since = new Date(at.getTime() - rateLimit.period * 1000);
    // one after the other: both may run in the claim's transaction
    const targetCount = rateLimit.maxPerTarget === undefined ? 0 : await countSponsoredDeployments(chainId, since, requester, account, db);
    const totalCount = rateLimit.maxTotal === undefined ? 0 : await countSponsoredDeployments(chainId, since, undefined, account, db);
    return reachedLimit(rateLimit, {target: targetCount, total: totalCount});
  };
  const refuseForLimit = (limit: "target" | "total"): ApiError => {
    if (limit === "target") {
      log.info({ chainId, limit, verificationId }, "sponsored deployment limit reached");
      return refuse(
        context, httpStatus.TOO_MANY_REQUESTS, "limit-target",
        `You are only allowed ${rateLimit!.maxPerTarget} sponsored deployments every ${parseSeconds(rateLimit!.period)}`
      );
    }
    log.warn({ chainId, limit, verificationId }, "sponsored deployment limit reached");
    return refuse(context, httpStatus.TOO_MANY_REQUESTS, "limit-total", `Sponsored deployments are used up on this network for now, try again later`);
  };
  const earlyLimit = await limitAt(now);
  if (earlyLimit) throw refuseForLimit(earlyLimit);
  // 11. what deploying does now, in one simulation: Safe-like code at the account, and the guardian when required
  if (!(await network.supportsCounterfactual())) {
    throw refuse(context, httpStatus.CONFLICT, "sponsorship-unavailable", unavailable(chainId));
  }
  const moduleAddresses = network.modules.map((module) => module.address);
  const reads: SimulatedCall[] = [deploymentProbe(account)];
  if (config.requireGuardian) {
    reads.push(...guardianSetupReads(account, await registrationGuardian(network), moduleAddresses));
  }
  let results: SimulatedResult[];
  try {
    results = await simulateDeploymentReads(provider, network.multicall3, deployment, reads);
  } catch (error) {
    if (error instanceof Erc6492Error) throw refuse(context, httpStatus.CONFLICT, "deployment-would-fail", WOULD_FAIL);
    throw error;
  }
  if (!probeAnswered(results[0])) {
    throw refuse(context, httpStatus.CONFLICT, "deployment-would-fail", WOULD_FAIL);
  }
  let guardianModule: string | undefined;
  if (config.requireGuardian) {
    guardianModule = guardianSetupModule(results.slice(1), moduleAddresses);
    if (!guardianModule) {
      throw refuse(context, httpStatus.FORBIDDEN, "no-guardian", `Deploying this account does not install this service's guardian`);
    }
  }
  // 12. from the paying signer: the address the factory answers, and the gas
  const signerAddress = await Signers.instance().getSigner(config.signer)!.signer();
  const call = {from: signerAddress, to: deployment.factory, data: deployment.factoryCalldata};
  let returnData: unknown;
  try {
    // send, not call: ethers' call() reports a transport failure as a revert (see src/utils/erc6492.ts)
    returnData = await provider.send("eth_call", [call, "latest"]);
  } catch (error) {
    if (isNodeExecutionError(error)) throw refuse(context, httpStatus.CONFLICT, "deployment-would-fail", WOULD_FAIL);
    throw error;
  }
  if (senderCheck(returnData, account) === "mismatch") {
    throw refuse(context, httpStatus.CONFLICT, "deployment-would-fail", WOULD_FAIL, {senderCheck: "mismatch"});
  }
  let estimate: ethers.BigNumber;
  try {
    estimate = await provider.estimateGas(call);
  } catch (error) {
    const code = (error as {code?: unknown} | null)?.code;
    if (code === ethers.errors.UNPREDICTABLE_GAS_LIMIT || code === ethers.errors.CALL_EXCEPTION) {
      throw refuse(context, httpStatus.CONFLICT, "deployment-would-fail", WOULD_FAIL);
    }
    throw error;
  }
  const gasLimit = scaleBigNumber(estimate, SPONSORED_DEPLOYMENT_GAS_FACTOR);
  if (gasLimit.gt(config.maxGas)) {
    throw refuse(context, httpStatus.FORBIDDEN, "gas-limit", `Deploying this account needs more gas than this network sponsors`, {
      gasLimit: gasLimit.toString(), maxGas: config.maxGas,
    });
  }
  // 13. the fees, and a signer that can pay them
  let maxFeePerGas: ethers.BigNumber;
  try {
    [, maxFeePerGas] = await GasPriceEstimator.instance().estimate(chainId, 1.5);
  } catch (error) {
    throw refuse(context, httpStatus.SERVICE_UNAVAILABLE, "sponsorship-unavailable", unavailable(chainId), {err: error});
  }
  const balance = await provider.getBalance(signerAddress);
  const estimatedCost = gasLimit.mul(maxFeePerGas);
  if (balance.lt(estimatedCost)) {
    log.error(
      { chainId, signerId: config.signer, signerAddress, balance: balance.toString(), estimatedCost: estimatedCost.toString() },
      "sponsored deployment signer underfunded"
    );
    throw refuse(context, httpStatus.SERVICE_UNAVAILABLE, "sponsorship-unavailable", unavailable(chainId));
  }
  // 14. the claim: one row per account and chain (a create, or a conditional update of the FAILED row). With limits, the
  // count that admits and the claim are one transaction under the chain's lock, so parallel requests cannot all pass.
  type Claim = {kind: "claimed"; id: string; attempt: number} | {kind: "lost"} | {kind: "limit"; limit: "target" | "total"};
  const previous = row;
  const claimIn = async (db: Prisma.TransactionClient, requestedAt: Date): Promise<Claim> => {
    const claim = {status: "PENDING", requestedAt, requesterHash: requester, verificationId, signerId: config.signer};
    if (!previous) {
      const created = await db.sponsoredDeployment.create({data: {account, chainId, attempts: 1, ...claim}});
      return {kind: "claimed", id: created.id, attempt: 1};
    }
    const attempt = previous.attempts + 1;
    const {count} = await db.sponsoredDeployment.updateMany({
      where: {id: previous.id, status: "FAILED", attempts: previous.attempts},
      data: {...claim, attempts: attempt, transactionHash: null, failureReason: null},
    });
    return count === 0 ? {kind: "lost"} : {kind: "claimed", id: previous.id, attempt};
  };
  let claimed: Claim;
  try {
    claimed = !rateLimit
      ? await claimIn(prisma, new Date())
      : await prisma.$transaction(async (tx): Promise<Claim> => {
        await tx.$queryRaw`SELECT 1 AS locked FROM pg_advisory_xact_lock(${SPONSORED_DEPLOYMENT_LOCK_CLASS}::integer, ${chainId}::integer)`;
        const claimedAt = new Date();
        const limit = await limitAt(claimedAt, tx);
        return limit ? {kind: "limit", limit} : claimIn(tx, claimedAt);
      }, CLAIM_TRANSACTION);
  } catch (error) {
    // created by another request in between
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") return answerCurrent(account, chainId);
    // the lock or a connection was not had in time
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2028") {
      throw refuse(context, httpStatus.SERVICE_UNAVAILABLE, "sponsorship-unavailable", unavailable(chainId), {err: error});
    }
    throw error;
  }
  if (claimed.kind === "limit") throw refuseForLimit(claimed.limit);
  if (claimed.kind === "lost") return answerCurrent(account, chainId);
  const admitted = claimed;
  // 15. the transaction, capped at maxGas by the executor whatever the estimate above said
  log.info(
    {
      deploymentId: admitted.id, account, chainId, signerId: config.signer, verificationId, attempt: admitted.attempt,
      ...(guardianModule ? {guardianModule} : {}),
    },
    "sponsored deployment requested"
  );
  ChainExecutor.instance().addTransaction({
    to: deployment.factory,
    value: 0n,
    callData: deployment.factoryCalldata,
    chainId,
    signerId: config.signer,
    maxGasLimit: config.maxGas,
    context: {action: "deploy", account},
    callback: (success, transactionHash, reason) =>
      settleDeployment(network, {id: admitted.id, account, chainId, attempt: admitted.attempt}, success, transactionHash, reason),
  });
  return {statusCode: httpStatus.ACCEPTED, body: {account, chainId, status: "pending"}};
};

// Whether the account has code after its deployment was mined, read up to SPONSORED_DEPLOYMENT_CODE_READS times,
// SPONSORED_DEPLOYMENT_CODE_READ_INTERVAL_MS apart, until a read finds it (a load-balanced RPC can answer from a node
// that has not imported the block yet): true as soon as one does; false when the last read still finds none;
// undefined when the last read failed and none found code.
const readCodeAfterMining = async (network: Network, account: string): Promise<{deployed?: boolean; err?: unknown}> => {
  let last: {deployed?: boolean; err?: unknown} = {};
  for (let read = 0; read < SPONSORED_DEPLOYMENT_CODE_READS; read++) {
    if (read > 0) await settlementTiming.wait(SPONSORED_DEPLOYMENT_CODE_READ_INTERVAL_MS);
    try {
      last = {deployed: await hasCode(network.jsonRPCProvider, account)};
    } catch (error) {
      last = {err: error};
    }
    if (last.deployed === true) return last;
  }
  return last;
};

/**
 * The executor's outcome of one attempt, written only if the row is still that attempt (PENDING, same attempts): a late
 * outcome never overwrites a newer attempt. Mined and code at the account: DEPLOYED. Mined and still no code after
 * SPONSORED_DEPLOYMENT_CODE_READS reads: FAILED "no-code". Failed, but code at the account anyway: DEPLOYED (someone
 * deployed it). Failed: FAILED with the reason, and the mined hash of a revert. A mined failure ("reverted", "no-code")
 * also counts in minedAttempts, in the same conditional update. The executor does not wait for this, so the reads
 * hold no queue.
 */
export const settleDeployment = async (
  network: Network,
  attempt: {id: string; account: string; chainId: number; attempt: number},
  success: boolean,
  transactionHash: string,
  reason?: ChainExecutorFailureReason,
): Promise<void> => {
  const {id, account, chainId} = attempt;
  const context = {deploymentId: id, account, chainId};
  const txHash = transactionHash || undefined;
  const update = async (data: Prisma.SponsoredDeploymentUpdateManyMutationInput): Promise<Record<string, unknown>> => {
    const {count} = await prisma.sponsoredDeployment.updateMany({where: {id, status: "PENDING", attempts: attempt.attempt}, data});
    // a newer attempt or the boot release took the row over: the outcome is logged, not written
    return count === 1 ? {} : {superseded: true};
  };
  let deployed: boolean | undefined;
  let codeError: unknown;
  if (success) {
    ({deployed, err: codeError} = await readCodeAfterMining(network, account));
  } else {
    try {
      deployed = await hasCode(network.jsonRPCProvider, account);
    } catch (error) {
      codeError = error;
    }
  }
  if (success) {
    if (deployed === false) {
      const superseded = await update({
        status: "FAILED", failureReason: "no-code", transactionHash: txHash ?? null, minedAttempts: {increment: 1},
      });
      log.error({ ...context, txHash, ...superseded }, "sponsored deployment left no code");
      return;
    }
    // mined without reverting: deployed, even when the code cannot be read now
    const superseded = await update({status: "DEPLOYED", transactionHash: txHash ?? null, failureReason: null});
    if (deployed === undefined) {
      log.warn({ ...context, txHash, err: codeError, ...superseded }, "sponsored deployment confirmed without a code check");
    } else {
      log.info({ ...context, txHash, ...superseded }, "sponsored deployment confirmed");
    }
    return;
  }
  if (deployed === true) {
    const superseded = await update({status: "DEPLOYED", transactionHash: null, failureReason: null});
    log.info({ ...context, ...superseded }, "sponsored deployment found deployed");
    return;
  }
  const failureReason: SponsoredDeploymentFailureReason = reason ?? "retries-exhausted";
  const superseded = await update({
    status: "FAILED", failureReason, transactionHash: txHash ?? null,
    ...(isMinedFailure(failureReason) ? {minedAttempts: {increment: 1}} : {}),
  });
  log.warn(
    { ...context, reason: failureReason, txHash, attempt: attempt.attempt, ...(codeError ? {err: codeError} : {}), ...superseded },
    "sponsored deployment failed"
  );
};

/** GET /v1/auth/accounts/deployment: the account's row on the chain, or 404. No chain call. */
export const fetchDeployment = async (account: string, chainId: number): Promise<DeploymentView> => {
  const row = await findRow(account, chainId);
  if (!row) {
    throw new ApiError(httpStatus.NOT_FOUND, `No sponsored deployment was requested for this account on this chain`);
  }
  return deploymentView(row);
};

/**
 * At boot, after listen: every PENDING row of a previous process was orphaned (the executor's queue is in memory).
 * Code at the account: DEPLOYED; none: FAILED "interrupted"; a failed read leaves the row PENDING (a request finds it
 * stale later) and is logged. One warning line with the counts.
 */
export const releaseOrphanedDeployments = async (): Promise<{deployed: number; failed: number; unchecked: number}> => {
  const rows = await prisma.sponsoredDeployment.findMany({where: {status: "PENDING", requestedAt: {lt: processStartedAt}}});
  const counts = {deployed: 0, failed: 0, unchecked: 0};
  for (const row of rows) {
    const network = Network.instances.get(row.chainId.toString());
    let deployed: boolean;
    try {
      if (!network) throw new Error(`chain ${row.chainId} is not an enabled network`);
      deployed = await hasCode(network.jsonRPCProvider, row.account);
    } catch (error) {
      counts.unchecked++;
      log.warn({ deploymentId: row.id, account: row.account, chainId: row.chainId, err: error }, "orphaned sponsored deployment not checked");
      continue;
    }
    const {count} = await prisma.sponsoredDeployment.updateMany({
      where: {id: row.id, status: "PENDING", attempts: row.attempts},
      data: deployed ? {status: "DEPLOYED"} : {status: "FAILED", failureReason: "interrupted"},
    });
    if (count === 1) counts[deployed ? "deployed" : "failed"]++;
  }
  if (rows.length > 0) {
    log.warn(counts, "orphaned sponsored deployments released");
  }
  return counts;
};

/**
 * Whether the service would deploy the account on this network: the sponsorship is on (and Multicall3 not known to be
 * missing), and init data is stored for the account with a factory on the allowlist. One database read, no chain call.
 */
export const sponsoredDeploymentAvailable = async (network: Network, account: string): Promise<boolean> => {
  const config = network.deployAccounts;
  if (!config.enabled || network.counterfactualSupported === false) return false;
  const row = await prisma.authAccountMetadata.findFirst({
    where: {account: account.toLowerCase(), chainId: network.chainId},
    select: {metadata: true},
  });
  const deployment = storedInitData(row?.metadata);
  return deployment !== undefined && config.factories.includes(deployment.factory.toLowerCase());
};
