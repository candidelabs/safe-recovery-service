import {ethers} from "ethers";
import {StaticInstanceManager} from "./static-instance-manager";

interface ExecuteRecoveryRequestConfig {
  enabled: boolean;
  signer?: string;
  rateLimit?: {maxPerAccount: number, period: number};
}

interface FinalizeRecoveryRequestConfig {
  enabled: boolean;
  signer?: string;
  rateLimit?: {maxPerAccount: number, period: number}; // max sponsorships per account per period (in seconds)
}

export class Network {
  public name: string;
  public chainId: number;
  public recoveryModuleAddress: string;
  public jsonRPCProvider: ethers.providers.JsonRpcProvider;
  public executeRecoveryRequestConfig: ExecuteRecoveryRequestConfig;
  public finalizeRecoveryRequestConfig: FinalizeRecoveryRequestConfig;
  private alert?: string;
  //
  public static supportedChainIds: number[] = [];
  public static instances: StaticInstanceManager<Network> = new StaticInstanceManager(undefined);

  constructor(
    name: string,
    chainId: number,
    recoveryModuleAddress: string,
    jsonRPCProvider: ethers.providers.JsonRpcProvider,
    executeRecoveryRequestConfig: ExecuteRecoveryRequestConfig,
    finalizeRecoveryRequestConfig: FinalizeRecoveryRequestConfig,
    alert: string | undefined,
  ) {
    this.name = name;
    this.chainId = chainId;
    this.recoveryModuleAddress = recoveryModuleAddress;
    this.jsonRPCProvider = jsonRPCProvider;
    this.executeRecoveryRequestConfig = executeRecoveryRequestConfig;
    this.finalizeRecoveryRequestConfig = finalizeRecoveryRequestConfig;
    this.alert = alert;
    Network.supportedChainIds.push(chainId);
    Network.instances.add(this);
  }

  public id() {
    return this.chainId.toString();
  }
}