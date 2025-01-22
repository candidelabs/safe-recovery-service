import { ethers } from "ethers";
import socialSource from "./source/SocialRecoveryModule.json";
import walletSource from "./source/Safe.json";

export const getSafeInstance = (address: string, provider: ethers.providers.Provider) =>
  new ethers.Contract(address, walletSource.abi, provider);

export const getSocialModuleInstance = (address: string, provider: ethers.providers.Provider) =>
  new ethers.Contract(address, socialSource.abi, provider);