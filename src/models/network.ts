import {ethers} from "ethers";
import httpStatus from "http-status";
import {StaticInstanceManager} from "./static-instance-manager";
import {Indexer} from "../services/indexer.service";
import {createRecoveryModule, RecoveryModule, RecoveryModuleConfig} from "./recovery-module";
import {ApiError} from "../utils/error";

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
  public modules: RecoveryModule[];
  // The module used when a request does not name one; undefined on a chain without a v0.1.0 fallback.
  public fallbackModule?: RecoveryModule;
  // Rows indexed before modules were tracked (no moduleAddress) came from this module: the one a legacy
  // 'recoveryModuleAddress' config names. Undefined with 'recoveryModules' (see assignLegacyRows).
  public legacyModule?: RecoveryModule;
  public jsonRPCEndpoint: string;
  public jsonRPCProvider: ethers.providers.JsonRpcProvider;
  public executeRecoveryRequestConfig: ExecuteRecoveryRequestConfig;
  public finalizeRecoveryRequestConfig: FinalizeRecoveryRequestConfig;
  public guardian?: string;
  public alert?: string;
  public indexer: Indexer;
  //
  public static supportedChainIds: number[] = [];
  public static instances: StaticInstanceManager<Network> = new StaticInstanceManager(undefined);

  constructor(
    name: string,
    chainId: number,
    modules: RecoveryModuleConfig[],
    jsonRPCEndpoint: string,
    jsonRPCProvider: ethers.providers.JsonRpcProvider,
    executeRecoveryRequestConfig: ExecuteRecoveryRequestConfig,
    finalizeRecoveryRequestConfig: FinalizeRecoveryRequestConfig,
    guardian: string | undefined,
    alert: string | undefined,
  ) {
    this.name = name;
    this.chainId = chainId;
    this.modules = modules.map((module) => createRecoveryModule(module, jsonRPCProvider));
    this.fallbackModule = this.modules.find((module) => module.fallback);
    const legacyModule = modules.find((module) => module.legacy);
    this.legacyModule = legacyModule ? this.getModule(legacyModule.address) : undefined;
    this.jsonRPCEndpoint = jsonRPCEndpoint;
    this.jsonRPCProvider = jsonRPCProvider;
    this.executeRecoveryRequestConfig = executeRecoveryRequestConfig;
    this.finalizeRecoveryRequestConfig = finalizeRecoveryRequestConfig;
    this.guardian = guardian;
    this.alert = alert;
    this.indexer = new Indexer(this);
    this.indexer.start();
    Network.supportedChainIds.push(chainId);
    Network.instances.add(this);
  }

  public id() {
    return this.chainId.toString();
  }

  public getModule(address: string): RecoveryModule | undefined {
    const _address = address.toLowerCase();
    return this.modules.find((module) => module.address === _address);
  }

  // The module a request that starts a flow names, or the fallback when it names none.
  public resolveModule(moduleAddress?: string): ModuleSelection {
    if (moduleAddress === undefined) {
      return {module: this.requireFallbackModule(), fallback: true};
    }
    const module = this.getModule(moduleAddress);
    if (!module) {
      throw new ApiError(
        httpStatus.BAD_REQUEST,
        `Recovery module ${moduleAddress} is not configured on this network (${this.chainId})`
      );
    }
    return {module, fallback: false};
  }

  public requireFallbackModule(): RecoveryModule {
    if (!this.fallbackModule) {
      throw new ApiError(
        httpStatus.BAD_REQUEST,
        `No default recovery module is configured on this network (${this.chainId}); pass moduleAddress`
      );
    }
    return this.fallbackModule;
  }

  // The module a stored request was made on. Later steps of a flow always use it, never a module derived again.
  public requireRequestModule(moduleAddress: string | null): RecoveryModule {
    if (!moduleAddress) {
      // only between boot and the assignment of rows made before requests named their module
      throw new ApiError(httpStatus.SERVICE_UNAVAILABLE, `This request is not bound to a recovery module yet, try again shortly`);
    }
    const module = this.getModule(moduleAddress);
    if (!module) {
      throw new ApiError(
        httpStatus.BAD_REQUEST,
        `The recovery module of this request (${moduleAddress}) is no longer configured on this network (${this.chainId})`
      );
    }
    return module;
  }
}

export interface ModuleSelection {
  module: RecoveryModule;
  fallback: boolean; // the request named no module
}