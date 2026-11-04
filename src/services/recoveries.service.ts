import httpStatus from "http-status";
import {BigNumber, ethers} from "ethers";
import {
  ApiError,
  createEmojiSet,
  isValidSignature,
  parseSeconds,
} from "../utils";
import {prisma} from "../config/prisma-client";
import {ModuleSelection, Network} from "../models/network";
import {RecoveryModule} from "../models/recovery-module";
import {Prisma, RecoveryRequest} from "@prisma/client";
import {ChainExecutor} from "./chain-executor.service";
import {checkRecoveryModule} from "./recovery-modules.service";
import logger from "../utils/logger";

const log = logger.child({ component: "recoveries" });

export const create = async (
  account: string,
  newOwners: string[],
  newThreshold: number,
  chainId: number,
  signer: string,
  signature: string,
  {module: recoveryModule, fallback}: ModuleSelection,
) => {
  const network = Network.instances.get(chainId.toString())!;
  const last5Minutes = new Date(Date.now() - (5*60*1000));
  const lastRecoveryRequest = await prisma.recoveryRequest.findFirst({
    where: {
      account: {equals: account.toLowerCase()},
      chainId: {equals: chainId},
      createdAt: {gte: last5Minutes}
    }
  });
  if (lastRecoveryRequest) {
    throw new ApiError(
      httpStatus.TOO_MANY_REQUESTS,
      `You can only create 1 recovery request every 5 minutes`
    );
  }
  await checkRecoveryModule(network, recoveryModule, account, newOwners);
  const recoveryNonce: BigNumber = await recoveryModule.contract.nonce(account);
  const _newOwners = newOwners.map(e => e.toLowerCase());
  const recoveryHash = await recoveryModule.getRecoveryHash(account, _newOwners, newThreshold, recoveryNonce.toBigInt());
  let recoveryRequest = await prisma.recoveryRequest.create(
    {
      data: {
        emoji: createEmojiSet(15, false),
        account: account.toLowerCase(),
        newOwners: _newOwners,
        newThreshold: newThreshold,
        chainId,
        nonce: recoveryNonce.toBigInt(),
        signatures: [],
        executeData: {sponsored: false, transactionHash: ""},
        finalizeData: {sponsored: false, transactionHash: ""},
        status: "PENDING",
        discoverable: false,
        moduleAddress: recoveryModule.address,
        recoveryHash,
      }
    }
  );
  try {
    await addSignature(recoveryRequest, recoveryModule, signer, signature, fallback);
    recoveryRequest = await prisma.recoveryRequest.update({
      data: {discoverable: true},
      where: {id: recoveryRequest.id}
    });
    log.info(
      {
        recoveryRequestId: recoveryRequest.id,
        account: recoveryRequest.account,
        chainId,
        moduleAddress: recoveryModule.address,
        nonce: recoveryRequest.nonce,
      },
      "recovery request created"
    );
  } catch (e) {
    await prisma.recoveryRequest.delete({
      where: {id: recoveryRequest.id}
    });
    throw e
  }
  return recoveryRequest;
};


export const signRecoveryHash = async (id: string | RecoveryRequest, signer: string, signature: string) => {
  let recoveryRequest: RecoveryRequest | null;
  if (typeof id === "string") {
    recoveryRequest = await prisma.recoveryRequest.findFirst({
      where: {
        id: {equals: id},
      }
    });
    if (!recoveryRequest) {
      throw new ApiError(
        httpStatus.NOT_FOUND,
        `Recovery request with id ${id} not found`
      );
    }
  }else{
    recoveryRequest = id;
  }
  const network = Network.instances.get(recoveryRequest.chainId.toString())!;
  const recoveryModule = network.requireRequestModule(recoveryRequest.moduleAddress);
  return addSignature(recoveryRequest, recoveryModule, signer, signature, false);
};

// fallback: the request named no module (create only), so a signature made for another module gets an
// error naming it.
const addSignature = async (
  recoveryRequest: RecoveryRequest,
  recoveryModule: RecoveryModule,
  signer: string,
  signature: string,
  fallback: boolean,
) => {
  const network = Network.instances.get(recoveryRequest.chainId.toString())!;
  const isSignerAGuardian: boolean = await recoveryModule.contract.isGuardian(recoveryRequest.account, signer);
  if (!isSignerAGuardian) {
    throw new ApiError(
      httpStatus.BAD_REQUEST,
      `Signer not a guardian`
    );
  }
  if (signature === "0x" && !recoveryModule.acceptsRelayedEmptySignature) {
    throw new ApiError(
      httpStatus.BAD_REQUEST,
      `Empty signatures cannot be relayed on the ${recoveryModule.label} recovery module`
    );
  }
  //
  const recoveryHash = recoveryRequest.recoveryHash ?? await recoveryModule.getRecoveryHash(
    recoveryRequest.account,
    recoveryRequest.newOwners,
    recoveryRequest.newThreshold,
    recoveryRequest.nonce,
  );
  if (!await verifySignature(network, signer, recoveryHash, signature)){
    const signedModule = fallback ? await findSignedModule(network, recoveryModule, recoveryRequest, signer, signature) : undefined;
    if (signedModule) {
      throw new ApiError(
        httpStatus.BAD_REQUEST,
        `Invalid signature: it was made for the ${signedModule.label} recovery module ` +
        `${ethers.utils.getAddress(signedModule.address)}; pass it as moduleAddress`
      );
    }
    throw new ApiError(
      httpStatus.BAD_REQUEST,
      `Invalid signature`
    );
  }
  let signatures = recoveryRequest.signatures as string[][];
  //
  for (const _signature of signatures) {
    if (_signature[0].toLowerCase() == signer.toLowerCase()) return true;
  }
  signatures.push([signer, signature]);
  signatures = signatures.sort((a, b) => a[0].localeCompare(b[0]));
  //
  await prisma.recoveryRequest.update({
    data: {
      signatures: signatures,
    },
    where: {
      id: recoveryRequest.id
    }
  });
  log.info(
    { recoveryRequestId: recoveryRequest.id, chainId: recoveryRequest.chainId, signer, signatureCount: signatures.length },
    "recovery request signed"
  );
  //
  return true;
};

const verifySignature = async (network: Network, signer: string, hash: string, signature: string): Promise<boolean> => {
  try {
    return await isValidSignature(
      signer,
      ethers.utils.arrayify(hash),
      ethers.utils.arrayify(signature),
      network.jsonRPCProvider,
    );
  } catch (e) {
    return false;
  }
};

// The other configured module whose recovery hash (at that module's current nonce) the signature is
// valid for, if any. Runs only after a signature failed under the fallback, which keeps its RPC calls
// off the normal path.
const findSignedModule = async (
  network: Network,
  requestModule: RecoveryModule,
  recoveryRequest: RecoveryRequest,
  signer: string,
  signature: string,
): Promise<RecoveryModule | undefined> => {
  const matches = await Promise.all(network.modules.filter((module) => module !== requestModule).map(async (module) => {
    try {
      const nonce: BigNumber = await module.contract.nonce(recoveryRequest.account);
      const hash = await module.getRecoveryHash(recoveryRequest.account, recoveryRequest.newOwners, recoveryRequest.newThreshold, nonce.toBigInt());
      return await verifySignature(network, signer, hash, signature) ? module : undefined;
    } catch (e) {
      return undefined;
    }
  }));
  return matches.find((module) => module !== undefined);
};

// Reads filter by module: requests made on other modules can share a nonce (every module starts each
// account's nonce at 0).
export const findByAccountAddress = async (account: string, chainId: number, nonce: bigint, module: RecoveryModule) => {
  return prisma.recoveryRequest.findMany({
    where: {
      account: {equals: account.toLowerCase()},
      chainId: {equals: chainId},
      moduleAddress: {equals: module.address},
      nonce: {equals: nonce},
      discoverable: {equals: true},
    }
  });
};

export const findByAccount = async (
  account: string,
  chainId: number,
  module: RecoveryModule,
  filters: Record<string, any>,
  orderBy?: "createdAt" | "nonce",
  order: "asc" | "desc" = "desc",
  limit: number = 20,
  offset: number = 0,
) => {
  const where: Prisma.RecoveryRequestWhereInput = {
    account: { equals: account.toLowerCase() },
    chainId: { equals: chainId },
    moduleAddress: { equals: module.address },
    discoverable: { equals: true },
  };

  // Build nonce filter
  const nonceFilter: Record<string, bigint> = {};
  if (filters.nonce != null) nonceFilter.equals = BigInt(filters.nonce);
  if (filters.nonce__lt != null) nonceFilter.lt = BigInt(filters.nonce__lt);
  if (filters.nonce__gt != null) nonceFilter.gt = BigInt(filters.nonce__gt);
  if (filters.nonce__lte != null) nonceFilter.lte = BigInt(filters.nonce__lte);
  if (filters.nonce__gte != null) nonceFilter.gte = BigInt(filters.nonce__gte);
  if (Object.keys(nonceFilter).length > 0) where.nonce = nonceFilter;

  // Build createdAt filter
  const createdAtFilter: Record<string, Date> = {};
  if (filters.createdAt != null) createdAtFilter.equals = new Date(filters.createdAt);
  if (filters.createdAt__lt != null) createdAtFilter.lt = new Date(filters.createdAt__lt);
  if (filters.createdAt__gt != null) createdAtFilter.gt = new Date(filters.createdAt__gt);
  if (filters.createdAt__lte != null) createdAtFilter.lte = new Date(filters.createdAt__lte);
  if (filters.createdAt__gte != null) createdAtFilter.gte = new Date(filters.createdAt__gte);
  if (Object.keys(createdAtFilter).length > 0) where.createdAt = createdAtFilter;

  // Status filter
  if (filters.status != null) where.status = { equals: filters.status };

  const results = await prisma.recoveryRequest.findMany({
    where,
    orderBy: orderBy ? { [orderBy]: order } : undefined,
    take: limit,
    skip: offset,
  });

  // Return results as is if executed and finalized filters are not set.
  if (filters.executed == null && filters.finalized == null) return results;

  // Executed/finalized boolean filters, on the events of the requests' module only. v0.2.0 events carry
  // the recovery hash; v0.1.0 events are matched on (newOwnersHash, newThreshold, nonce).
  const byRecoveryHash = module.version === "0.2.0";
  const eventWhere = {
    account: account.toLowerCase(),
    chainId,
    moduleAddress: module.address,
    ...(byRecoveryHash
      ? { recoveryHash: { in: results.flatMap(r => r.recoveryHash ? [r.recoveryHash] : []) } }
      : { nonce: { in: [...new Set(results.map(r => r.nonce))] } }),
  };

  const [executedEvents, finalizedEvents] = await Promise.all([
    prisma.recoveryExecutedEvent.findMany({ where: eventWhere }),
    prisma.recoveryFinalizedEvent.findMany({ where: eventWhere }),
  ]);

  const keyOfEvent = (e: { recoveryHash: string | null, newOwnersHash: string, newThreshold: bigint, nonce: bigint }) =>
    byRecoveryHash ? e.recoveryHash : `${e.newOwnersHash}:${e.newThreshold}:${e.nonce}`;
  const executedEventKeys = new Set(executedEvents.map(keyOfEvent));
  const finalizedEventKeys = new Set(finalizedEvents.map(keyOfEvent));
  // a missing key (a v0.2.0 request always stores its hash) matches no event
  const matches = (keys: Set<string | null>, key: string | null) => key !== null && keys.has(key);

  const prohibitedIds = new Set<string>();
  for (const request of results) {
    // We use solidityKeccak256 because Solidity dynamic indexed types are encoded this way, see https://docs.soliditylang.org/en/v0.8.33/abi-spec.html#encoding-of-indexed-event-parameters
    // We explicitly cast request.newThreshold into a BigInt because FinalizedEvent.newThreshold and ExecutedEvent.newThreshold are both BigInt
    const eventKey = byRecoveryHash
      ? request.recoveryHash
      : `${ethers.utils.solidityKeccak256(["address[]"], [request.newOwners]).toLowerCase()}:${BigInt(request.newThreshold)}:${request.nonce}`;
    if (filters.executed != null){
      if (filters.executed === true && !matches(executedEventKeys, eventKey)) {
        prohibitedIds.add(request.id);
      }
      if (filters.executed === false && matches(executedEventKeys, eventKey)) {
        prohibitedIds.add(request.id);
      }
    }
    if (filters.finalized != null){
      if (filters.finalized === true && !matches(finalizedEventKeys, eventKey)) {
        prohibitedIds.add(request.id);
      }
      if (filters.finalized === false && matches(finalizedEventKeys, eventKey)) {
        prohibitedIds.add(request.id);
      }
    }
  }

  return results.filter(r => {
    return !prohibitedIds.has(r.id);
  });
};

export const findById = async (id: string) => {
  return prisma.recoveryRequest.findFirst({where:{id}});
};

export const sponsorExecution = async (request: RecoveryRequest) => {
  const network = Network.instances.get(request.chainId.toString())!;
  if (!network.executeRecoveryRequestConfig.enabled){
    throw new ApiError(
      httpStatus.FORBIDDEN,
      `Execution sponsorship is not enabled for this network (${network.chainId})`
    );
  }
  if (network.executeRecoveryRequestConfig.rateLimit){
    const period = network.executeRecoveryRequestConfig.rateLimit.period;
    const maxPerAccount = network.executeRecoveryRequestConfig.rateLimit.maxPerAccount;
    const lastPeriod = new Date(Date.now() - (period*1000));
    const sponsoredRequestsInPeriod = await prisma.recoveryRequest.count({
      where: {
        account: {equals: request.account},
        chainId: {equals: network.chainId},
        createdAt: {gte: lastPeriod},
        executeData: {path: ['sponsored'], equals: true}
      }
    });
    if (sponsoredRequestsInPeriod >= maxPerAccount){
      throw new ApiError(
        httpStatus.TOO_MANY_REQUESTS,
        `You are only allowed ${maxPerAccount} execution sponsorships every ${parseSeconds(period)}`
      );
    }
  }
  //
  const recoveryModule = network.requireRequestModule(request.moduleAddress);
  const guardianThreshold = await recoveryModule.contract.threshold(request.account) as BigNumber;
  const accountNonce = await recoveryModule.contract.nonce(request.account) as BigNumber;
  if (!accountNonce.eq(request.nonce)){
    throw new ApiError(
      httpStatus.FORBIDDEN,
      `This recovery request has an invalid nonce`
    );
  }
  if (guardianThreshold.gt((request.signatures as Prisma.JsonArray).length)){
    throw new ApiError(
      httpStatus.FORBIDDEN,
      `This recovery request has insufficient signatures (collected ${(request.signatures as Prisma.JsonArray).length} signatures, account threshold is ${guardianThreshold.toNumber()})`
    );
  }
  //
  const executeData = request.executeData as Prisma.JsonObject;
  if (typeof executeData["transactionHash"] == "string" && executeData["transactionHash"]._0xRemove().length > 0) return executeData["transactionHash"];
  if (request.status === "EXECUTED") return executeData["transactionHash"];
  //
  const onChainRequest = await recoveryModule.readRecoveryRequest(request.account);
  if (onChainRequest.executableAt !== 0n){
    if (onChainRequest.approvalCount >= BigInt((request.signatures as Prisma.JsonArray).length)){
      throw new ApiError(
        httpStatus.NOT_FOUND,
        `This recovery request cannot replace the current active on-chain recovery request`
      );
    }
  }
  // Claim the request atomically so concurrent calls cannot enqueue it twice;
  // the executor queue is in-memory and has no idempotency key of its own.
  const claimed = await prisma.recoveryRequest.updateMany({
    where: {id: request.id, status: "PENDING"},
    data: {status: "EXECUTION-IN-PROGRESS"}
  });
  if (claimed.count === 0){
    throw new ApiError(
      httpStatus.FORBIDDEN,
      `Execution already pending`
    );
  }
  const callData = recoveryModule.encodeExecute({
    account: request.account,
    newOwners: request.newOwners,
    newThreshold: request.newThreshold,
    nonce: request.nonce,
    signatures: request.signatures as string[][],
  });
  const context = {
    recoveryRequestId: request.id,
    account: request.account,
    chainId: network.chainId,
    moduleAddress: recoveryModule.address,
    signerId: network.executeRecoveryRequestConfig.signer!,
    phase: "execute",
  };
  log.info(context, "recovery execution sponsored");
  ChainExecutor.instance().addTransaction({
    to: recoveryModule.address,
    value: 0n,
    callData,
    chainId: network.chainId,
    signerId: network.executeRecoveryRequestConfig.signer!,
    callback: async (success, transactionHash) => {
      // Conditional on the claim still being ours, so a late or duplicate
      // outcome can never overwrite a status another path has since set.
      if (success){
        log.info({ ...context, txHash: transactionHash }, "recovery executed");
        executeData["sponsored"] = true;
        executeData["transactionHash"] = transactionHash;
        await prisma.recoveryRequest.updateMany({
          data: {executeData, status: "EXECUTED"},
          where: {id: request.id, status: "EXECUTION-IN-PROGRESS"}
        });
      }else{
        // the chain executor logged why; the request goes back to PENDING and can be sponsored again
        log.warn(context, "recovery execution failed, request released");
        await prisma.recoveryRequest.updateMany({
          data: {status: "PENDING"},
          where: {id: request.id, status: "EXECUTION-IN-PROGRESS"}
        });
      }
    }
  });
};

export const sponsorFinalization = async (request: RecoveryRequest) => {
  const network = Network.instances.get(request.chainId.toString())!;
  if (!network.finalizeRecoveryRequestConfig.enabled){
    throw new ApiError(
      httpStatus.FORBIDDEN,
      `Finalization sponsorship is not enabled for this network (${network.chainId})`
    );
  }
  if (network.finalizeRecoveryRequestConfig.rateLimit){
    const period = network.finalizeRecoveryRequestConfig.rateLimit.period;
    const maxPerAccount = network.finalizeRecoveryRequestConfig.rateLimit.maxPerAccount;
    const lastPeriod = new Date(Date.now() - (period*1000));
    const sponsoredRequestsInPeriod = await prisma.recoveryRequest.count({
      where: {
        account: {equals: request.account},
        chainId: {equals: network.chainId},
        createdAt: {gte: lastPeriod},
        finalizeData: {path: ['sponsored'], equals: true}
      }
    });
    if (sponsoredRequestsInPeriod >= maxPerAccount){
      throw new ApiError(
        httpStatus.TOO_MANY_REQUESTS,
        `You are only allowed ${maxPerAccount} finalization sponsorships every ${parseSeconds(period)}`
      );
    }
  }
  //
  const finalizeData = request.finalizeData as Prisma.JsonObject;
  if (typeof finalizeData["transactionHash"] == "string" && finalizeData["transactionHash"]._0xRemove().length > 0) return finalizeData["transactionHash"];
  if (request.status === "FINALIZED") return finalizeData["transactionHash"];
  //
  const recoveryModule = network.requireRequestModule(request.moduleAddress);
  //
  const onChainRequest = await recoveryModule.readRecoveryRequest(request.account);
  if (onChainRequest.executableAt === 0n){
    throw new ApiError(
      httpStatus.NOT_FOUND,
      `No recovery request found on chain`
    );
  }
  const currentTimestamp = (await network.jsonRPCProvider.getBlock("latest")).timestamp;
  if (onChainRequest.executableAt > BigInt(currentTimestamp)){
    throw new ApiError(
      httpStatus.FORBIDDEN,
      `Recovery request is not yet ready for finalization`
    );
  }
  // Claim atomically (see sponsorExecution). Any status short of finalized may
  // be claimed because the recovery may have been executed outside this service.
  const claimed = await prisma.recoveryRequest.updateMany({
    where: {id: request.id, status: {notIn: ["FINALIZATION-IN-PROGRESS", "FINALIZED"]}},
    data: {status: "FINALIZATION-IN-PROGRESS"}
  });
  if (claimed.count === 0){
    throw new ApiError(
      httpStatus.FORBIDDEN,
      `Finalization already pending`
    );
  }
  const callData = recoveryModule.contract.interface.encodeFunctionData("finalizeRecovery", [request.account]);
  const context = {
    recoveryRequestId: request.id,
    account: request.account,
    chainId: network.chainId,
    moduleAddress: recoveryModule.address,
    signerId: network.finalizeRecoveryRequestConfig.signer!,
    phase: "finalize",
  };
  log.info(context, "recovery finalization sponsored");
  ChainExecutor.instance().addTransaction({
    to: recoveryModule.address,
    value: 0n,
    callData,
    chainId: network.chainId,
    signerId: network.finalizeRecoveryRequestConfig.signer!,
    callback: async (success, transactionHash) => {
      // See sponsorExecution: conditional on the claim still being ours.
      if (success){
        log.info({ ...context, txHash: transactionHash }, "recovery finalized");
        finalizeData["sponsored"] = true;
        finalizeData["transactionHash"] = transactionHash;
        await prisma.recoveryRequest.updateMany({
          data: {finalizeData, status: "FINALIZED"},
          where: {id: request.id, status: "FINALIZATION-IN-PROGRESS"}
        });
      }else{
        log.warn(context, "recovery finalization failed, request released");
        await prisma.recoveryRequest.updateMany({
          data: {status: "EXECUTED"},
          where: {id: request.id, status: "FINALIZATION-IN-PROGRESS"}
        });
      }
    }
  });
};

// Claims live in the DB but the executor queue lives in memory, so any
// *-IN-PROGRESS row at boot was orphaned by a previous process. Release it so
// the request can be sponsored again; the on-chain checks in sponsorExecution
// and sponsorFinalization prevent a double execution if the old tx did land.
export const releaseOrphanedSponsorships = async (): Promise<number> => {
  const executions = await prisma.recoveryRequest.updateMany({
    where: {status: "EXECUTION-IN-PROGRESS"},
    data: {status: "PENDING"}
  });
  const finalizations = await prisma.recoveryRequest.updateMany({
    where: {status: "FINALIZATION-IN-PROGRESS"},
    data: {status: "EXECUTED"}
  });
  return executions.count + finalizations.count;
};