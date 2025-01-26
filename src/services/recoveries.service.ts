import httpStatus from "http-status";
import { ApiError, createEmojiSet } from "../utils";
import {ethers} from "ethers";
import {getSafeInstance, getSocialModuleInstance} from "../utils/contractSource";
import { isValidSignature } from "../utils/valid_signature";
import {prisma} from "../config/prisma-client";
import {Network} from "../models/network";
import { Prisma, RecoveryRequest } from "@prisma/client";

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
  const recoveryNonce: number = await socialRecoveryModule.nonce(account);
  const recoveryRequest = await prisma.recoveryRequest.create(
    {
      data: {
        emoji: createEmojiSet(15, false),
        account: account.toLowerCase(),
        newOwners: newOwners.map(e => e.toLowerCase()),
        newThreshold,
        chainId,
        nonce: recoveryNonce,
        signatures: [],
        executeTransactionHash: "",
        finalizeTransactionHash: "",
        status: "PENDING",
        discoverable: false,
      }
    }
  );
  try {
    await signRecoveryHash(recoveryRequest, signer, signature);
    await prisma.recoveryRequest.update({
      data: {discoverable: true},
      where: {id: recoveryRequest.id}
    });
  } catch (e) {
    await prisma.recoveryRequest.delete({
      where: {id: recoveryRequest.id}
    });
    throw e
  }
  return
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
  const validSignature: boolean = await isValidSignature(
    signer,
    ethers.utils.arrayify(recoveryHash),
    ethers.utils.arrayify(signature),
    network.jsonRPCProvider,
  );
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
  //
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