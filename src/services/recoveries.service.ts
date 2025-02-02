import httpStatus from "http-status";
import {BigNumber, ethers} from "ethers";
import {
  ApiError,
  createEmojiSet,
  getSafeInstance,
  getSocialModuleInstance,
  isValidSignature,
  parseSeconds,
} from "../utils";
import {prisma} from "../config/prisma-client";
import {Network} from "../models/network";
import {Prisma, RecoveryRequest} from "@prisma/client";
import {ChainExecutor} from "./chain-executor.service";

export const create = async (account: string, newOwners: string[], newThreshold: number, chainId: number, signer: string, signature: string) => {
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
  try {
    const safeWallet = getSafeInstance(account, network.jsonRPCProvider);
    await safeWallet.nonce();
  } catch (e) {
    throw new ApiError(
      httpStatus.BAD_REQUEST,
      `Account address is not a safe smart contract account`
    );
  }
  const socialRecoveryModule = getSocialModuleInstance(network.recoveryModuleAddress, network.jsonRPCProvider);
  const recoveryNonce: BigNumber = await socialRecoveryModule.nonce(account);
  let recoveryRequest = await prisma.recoveryRequest.create(
    {
      data: {
        emoji: createEmojiSet(15, false),
        account: account.toLowerCase(),
        newOwners: newOwners.map(e => e.toLowerCase()),
        newThreshold: newThreshold,
        chainId,
        nonce: recoveryNonce.toBigInt(),
        signatures: [],
        executeData: {sponsored: false, transactionHash: ""},
        finalizeData: {sponsored: false, transactionHash: ""},
        status: "PENDING",
        discoverable: false,
      }
    }
  );
  try {
    await signRecoveryHash(recoveryRequest, signer, signature);
    recoveryRequest = await prisma.recoveryRequest.update({
      data: {discoverable: true},
      where: {id: recoveryRequest.id}
    });
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
  const network = Network.instances.get(recoveryRequest!.chainId.toString())!;
  const socialRecoveryModule = getSocialModuleInstance(network.recoveryModuleAddress, network.jsonRPCProvider);
  const isSignerAGuardian: boolean = await socialRecoveryModule.isGuardian(recoveryRequest!.account, signer);
  if (!isSignerAGuardian) {
    throw new ApiError(
      httpStatus.BAD_REQUEST,
      `Signer not a guardian`
    );
  }
  //
  const recoveryHash = await getRecoveryRequestExecutionHash(socialRecoveryModule, recoveryRequest!);
  let validSignature: boolean;
  try {
    validSignature = await isValidSignature(
      signer,
      ethers.utils.arrayify(recoveryHash),
      ethers.utils.arrayify(signature),
      network.jsonRPCProvider,
    );
  } catch (e) {
    validSignature = false;
  }
  if (!validSignature){
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
  //
  return true;
};

const getRecoveryRequestExecutionHash = async (socialRecoveryModule: ethers.Contract, recoveryRequest: RecoveryRequest | Prisma.RecoveryRequestCreateInput) => {
  return await socialRecoveryModule.getRecoveryHash(
    recoveryRequest.account,
    recoveryRequest.newOwners,
    recoveryRequest.newThreshold,
    recoveryRequest.nonce,
  );
};

export const findByAccountAddress = async (account: string, chainId: number, nonce: bigint) => {
  return prisma.recoveryRequest.findMany({
    where: {
      account: {equals: account.toLowerCase()},
      chainId: {equals: chainId},
      nonce: {equals: nonce},
      discoverable: {equals: true},
    }
  });
};

export const findById = async (id: string) => {
  return prisma.recoveryRequest.findFirst({where:{id}});
};

const executionMutex = new Set<string>()
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
  const socialRecoveryModule = getSocialModuleInstance(network.recoveryModuleAddress, network.jsonRPCProvider);
  const guardianThreshold = await socialRecoveryModule.threshold(request.account) as BigNumber;
  const accountNonce = await socialRecoveryModule.nonce(request.account) as BigNumber;
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
  const onChainRequest = await socialRecoveryModule.getRecoveryRequest(request.account)
  if (onChainRequest.executeAfter !== 0){
    if ((onChainRequest.guardiansApprovalCount as BigNumber).gte((request.signatures as Prisma.JsonArray).length)){
      throw new ApiError(
        httpStatus.NOT_FOUND,
        `This recovery request cannot replace the current active on-chain recovery request`
      );
    }
  }
  if (executionMutex.has(request.id) || request.status === "EXECUTION-IN-PROGRESS"){
    throw new ApiError(
      httpStatus.FORBIDDEN,
      `Execution already pending`
    );
  }
  executionMutex.add(request.id);
  const callData = socialRecoveryModule.interface.encodeFunctionData(
    "multiConfirmRecovery",
    [
      request.account,
      request.newOwners,
      request.newThreshold,
      request.signatures,
      true,
    ]
  );
  ChainExecutor.instance().addTransaction({
    to: network.recoveryModuleAddress,
    value: 0n,
    callData,
    chainId: network.chainId,
    signerId: network.finalizeRecoveryRequestConfig.signer!,
    callback: async (success, transactionHash) => {
      if (success){
        executeData["sponsored"] = true;
        executeData["transactionHash"] = transactionHash;
        await prisma.recoveryRequest.update({
          data: {executeData, status: "EXECUTED"},
          where: {id: request.id}
        });
      }else{
        await prisma.recoveryRequest.update({
          data: {status: "PENDING"},
          where: {id: request.id}
        });
      }
    }
  });
  executionMutex.delete(request.id);
};

const finalizationMutex = new Set<string>()
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
  let socialRecoveryModule = getSocialModuleInstance(network.recoveryModuleAddress, network.jsonRPCProvider);
  //
  const onChainRequest = await socialRecoveryModule.getRecoveryRequest(request.account)
  if (onChainRequest.executeAfter == 0){
    throw new ApiError(
      httpStatus.NOT_FOUND,
      `No recovery request found on chain`
    );
  }
  const currentTimestamp = (await network.jsonRPCProvider.getBlock("latest")).timestamp;
  if (onChainRequest.executeAfter > currentTimestamp){
    throw new ApiError(
      httpStatus.FORBIDDEN,
      `Recovery request is not yet ready for finalization`
    );
  }
  if (finalizationMutex.has(request.id) || request.status === "FINALIZATION-IN-PROGRESS"){
    throw new ApiError(
      httpStatus.FORBIDDEN,
      `Finalization already pending`
    );
  }
  finalizationMutex.add(request.id);
  const callData = socialRecoveryModule.interface.encodeFunctionData("finalizeRecovery", [request.account]);
  ChainExecutor.instance().addTransaction({
    to: network.recoveryModuleAddress,
    value: 0n,
    callData,
    chainId: network.chainId,
    signerId: network.finalizeRecoveryRequestConfig.signer!,
    callback: async (success, transactionHash) => {
      if (success){
        finalizeData["sponsored"] = true;
        finalizeData["transactionHash"] = transactionHash;
        await prisma.recoveryRequest.update({
          data: {finalizeData, status: "FINALIZED"},
          where: {id: request.id}
        });
      }else{
        await prisma.recoveryRequest.update({
          data: {status: "EXECUTED"},
          where: {id: request.id}
        });
      }
    }
  });
  finalizationMutex.delete(request.id);
};