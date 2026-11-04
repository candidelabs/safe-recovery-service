import { ethers } from "ethers";
import walletSource from "./source/Safe.json";

export const getSafeInstance = (address: string, provider: ethers.providers.Provider) =>
  new ethers.Contract(address, walletSource.abi, provider);