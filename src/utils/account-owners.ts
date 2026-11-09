import httpStatus from "http-status";
import {ethers} from "ethers";
import {Network} from "../models/network";
import {ApiError} from "./error";
import {AccountDeployment, Erc6492Error, hasCode, simulateGetOwners} from "./erc6492";

const SAFE_OWNERS_ABI = ["function getOwners() view returns (address[])"];

export interface AccountOwners {
  owners: string[]; // lower case
  deployed: boolean; // false: read by simulating the account's ERC-6492 deployment data
}

// The owners of a Safe on `network`: read on chain when the account has code, else from a simulated
// deployment with the account's ERC-6492 deployment data (the owner-mode wrapper of the alerts routes).
export const fetchAccountOwners = async (network: Network, account: string, deployment?: AccountDeployment): Promise<AccountOwners> => {
  const chainId = network.chainId;
  if (await hasCode(network.jsonRPCProvider, account)) {
    let owners: string[];
    try {
      owners = await new ethers.Contract(account, SAFE_OWNERS_ABI, network.jsonRPCProvider).getOwners();
    } catch (error) {
      throw new ApiError(httpStatus.BAD_REQUEST, `Unable to fetch owners for account '${account}' on chain ${chainId}: it does not answer getOwners()`);
    }
    return {owners: owners.map((owner) => owner.toLowerCase()), deployed: true};
  }
  if (!deployment) {
    throw new ApiError(
      httpStatus.BAD_REQUEST,
      `Unable to fetch owners for account '${account}' on chain ${chainId}: the account is not deployed. Wrap the signature with the account's ERC-6492 deployment data (factory, factoryCalldata) to use it before deployment.`
    );
  }
  await network.requireCounterfactualSupport();
  try {
    return {owners: await simulateGetOwners(network.jsonRPCProvider, network.multicall3, deployment, account), deployed: false};
  } catch (error) {
    if (error instanceof Erc6492Error) {
      throw new ApiError(httpStatus.BAD_REQUEST, `Unable to fetch owners for account '${account}' on chain ${chainId}: the ERC-6492 deployment data does not deploy it`);
    }
    throw error;
  }
};

// The SIWE signer must be a current owner of the account (one owner is enough, whatever the threshold).
export const requireAccountOwner = async (network: Network, account: string, owner: string, deployment?: AccountDeployment): Promise<AccountOwners> => {
  const accountOwners = await fetchAccountOwners(network, account, deployment);
  if (!accountOwners.owners.includes(owner.toLowerCase())){
    throw new ApiError(httpStatus.FORBIDDEN, `Owner must be a valid owner for the account provided`);
  }
  return accountOwners;
};
