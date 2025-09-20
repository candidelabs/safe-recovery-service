import {ethers} from "ethers";
import {StaticInstanceManager} from "./static-instance-manager";
import {Indexer} from "../services/indexer.service";

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

interface IndexerConfig {
  enabled: boolean,
  startBlock: number,
}

export class Network {
  public name: string;
  public chainId: number;
  public recoveryModuleAddress: string;
  public jsonRPCEndpoint: string;
  public jsonRPCProvider: ethers.providers.JsonRpcProvider;
  public executeRecoveryRequestConfig: ExecuteRecoveryRequestConfig;
  public finalizeRecoveryRequestConfig: FinalizeRecoveryRequestConfig;
  public guardian?: string;
  public alert?: string;
  public indexer: Indexer;
  public otpAlertBypassToken?: string;
  //
  public static supportedChainIds: number[] = [];
  public static instances: StaticInstanceManager<Network> = new StaticInstanceManager(undefined);

  constructor(
    name: string,
    chainId: number,
    recoveryModuleAddress: string,
    jsonRPCEndpoint: string,
    jsonRPCProvider: ethers.providers.JsonRpcProvider,
    executeRecoveryRequestConfig: ExecuteRecoveryRequestConfig,
    finalizeRecoveryRequestConfig: FinalizeRecoveryRequestConfig,
    guardian: string | undefined,
    alert: string | undefined,
    indexer: IndexerConfig,
    otpAlertBypassToken: string | undefined
  ) {
    this.name = name;
    this.chainId = chainId;
    this.recoveryModuleAddress = recoveryModuleAddress;
    this.jsonRPCEndpoint = jsonRPCEndpoint;
    this.jsonRPCProvider = jsonRPCProvider;
    this.executeRecoveryRequestConfig = executeRecoveryRequestConfig;
    this.finalizeRecoveryRequestConfig = finalizeRecoveryRequestConfig;
    this.guardian = guardian;
    this.alert = alert;
    this.indexer = new Indexer(this, indexer.startBlock, indexer.enabled);
    this.indexer.start();
    Network.supportedChainIds.push(chainId);
    Network.instances.add(this);
    this.otpAlertBypassToken = otpAlertBypassToken;
  }

  public id() {
    return this.chainId.toString();
  }
}