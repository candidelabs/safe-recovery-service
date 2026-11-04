import {BigNumber, ethers} from "ethers";
import {EventType} from "../utils/constants";
import {
  findRecoveryModuleVariant,
  formatRecoveryPeriod,
  RecoveryModuleVariant,
  RecoveryModuleVersion,
} from "../utils/recovery-modules";
import socialSourceV0_1_0 from "../utils/source/SocialRecoveryModule.v0.1.0.json";
import socialSourceV0_2_0 from "../utils/source/SocialRecoveryModule.v0.2.0.json";
import {IndexedEvent} from "./events/indexed-event";
import {GuardianAddedEvent} from "./events/guardian-added-event";
import {GuardianRevokedEvent} from "./events/guardian-revoked-event";
import {ChangedThresholdEvent} from "./events/changed-threshold-event";
import {RecoveryExecutedEvent} from "./events/recovery-executed-event";
import {RecoveryFinalizedEvent} from "./events/recovery-finalized-event";
import {RecoveryCanceledEvent} from "./events/recovery-canceled-event";

export interface RecoveryModuleIndexerConfig {
  enabled: boolean;
  startBlock: number;
}

export interface RecoveryModuleConfig {
  address: string;
  fallback: boolean;
  // Set on the module of a legacy 'recoveryModuleAddress' config: rows indexed before modules were
  // tracked came from it.
  legacy?: boolean;
  indexer: RecoveryModuleIndexerConfig;
}

// The account's pending on-chain recovery request, the same shape for every version.
// executableAt is 0 when there is none.
export interface OnChainRecoveryRequest {
  approvalCount: bigint;
  newThreshold: bigint;
  newOwners: string[];
  executableAt: bigint;
  nonce?: bigint; // v0.2.0 only
}

type LogPosition = [blockNumber: number, transactionIndex: number, logIndex: number, transactionHash: string];

const v0_1_0Interface = new ethers.utils.Interface(socialSourceV0_1_0.abi);
const v0_2_0Interface = new ethers.utils.Interface(socialSourceV0_2_0.abi);

// topic0 -> event type, for the events the indexer stores. Guardian events have the same topics on
// both versions; the recovery event topics are disjoint, so a topic gives both the version and the type.
const eventTopics = (iface: ethers.utils.Interface): Record<string, EventType> => ({
  [iface.getEventTopic("GuardianAdded")]: EventType.GuardianAdded,
  [iface.getEventTopic("GuardianRevoked")]: EventType.GuardianRevoked,
  [iface.getEventTopic("ChangedThreshold")]: EventType.ChangedThreshold,
  [iface.getEventTopic("RecoveryExecuted")]: EventType.RecoveryExecuted,
  [iface.getEventTopic("RecoveryFinalized")]: EventType.RecoveryFinalized,
  [iface.getEventTopic("RecoveryCanceled")]: EventType.RecoveryCanceled,
});

const toBigInt = (value: BigNumber | number): bigint => BigNumber.from(value).toBigInt();

// One configured SocialRecoveryModule on one network. Every call to the module goes through this
// object, which hides the differences between versions (ABI, event layouts, getRecoveryRequest).
export abstract class RecoveryModule {
  public readonly address: string; // lowercase
  public readonly version: RecoveryModuleVersion;
  public readonly recoveryPeriod: number; // seconds
  public readonly testnetOnly: boolean;
  public readonly codeHash: string;
  public readonly contract: ethers.Contract;

  protected constructor(
    variant: RecoveryModuleVariant,
    public readonly fallback: boolean,
    public readonly indexer: RecoveryModuleIndexerConfig,
    iface: ethers.utils.Interface,
    provider: ethers.providers.Provider,
  ) {
    this.address = variant.address;
    this.version = variant.version;
    this.recoveryPeriod = variant.recoveryPeriod;
    this.testnetOnly = variant.testnetOnly;
    this.codeHash = variant.codeHash;
    this.contract = new ethers.Contract(variant.address, iface, provider);
  }

  public abstract readonly topics: Readonly<Record<string, EventType>>;

  // "v0.2.0 (7 days)"
  public get label(): string {
    return `v${this.version} (${formatRecoveryPeriod(this.recoveryPeriod)})`;
  }

  public abstract readRecoveryRequest(account: string): Promise<OnChainRecoveryRequest>;

  // Decodes a log emitted by this module; undefined for events the indexer does not store.
  public decodeLog(log: ethers.providers.Log, chainId: number): IndexedEvent | undefined {
    const eventType = this.topics[log.topics[0]];
    if (eventType === undefined) return undefined;
    // Not parseLog: it deep-copies the result and drops the named args when an indexed array (the
    // v0.1.0 newOwners) is present.
    const iface = this.contract.interface;
    const args = iface.decodeEventLog(iface.getEvent(log.topics[0]), log.data, log.topics);
    const account = (args.wallet as string).toLowerCase();
    const position: LogPosition = [log.blockNumber, log.transactionIndex, log.logIndex, log.transactionHash];
    switch (eventType) {
      case EventType.GuardianAdded:
        return new GuardianAddedEvent(chainId, this.address, account, (args.guardian as string).toLowerCase(), ...position);
      case EventType.GuardianRevoked:
        return new GuardianRevokedEvent(chainId, this.address, account, (args.guardian as string).toLowerCase(), ...position);
      case EventType.ChangedThreshold:
        return new ChangedThresholdEvent(chainId, this.address, account, toBigInt(args.threshold), ...position);
      default:
        return this.decodeRecoveryLog(eventType, args, account, chainId, position);
    }
  }

  protected abstract decodeRecoveryLog(
    eventType: EventType,
    args: ethers.utils.Result,
    account: string,
    chainId: number,
    position: LogPosition,
  ): IndexedEvent | undefined;
}

class RecoveryModuleV0_1_0 extends RecoveryModule {
  public readonly topics = eventTopics(v0_1_0Interface);

  constructor(variant: RecoveryModuleVariant, fallback: boolean, indexer: RecoveryModuleIndexerConfig, provider: ethers.providers.Provider) {
    super(variant, fallback, indexer, v0_1_0Interface, provider);
  }

  public async readRecoveryRequest(account: string): Promise<OnChainRecoveryRequest> {
    const request = await this.contract.getRecoveryRequest(account);
    return {
      approvalCount: toBigInt(request.guardiansApprovalCount),
      newThreshold: toBigInt(request.newThreshold),
      newOwners: (request.newOwners as string[]).map((owner) => owner.toLowerCase()),
      executableAt: toBigInt(request.executeAfter),
    };
  }

  // newOwners is an indexed address[], so the log only carries its hash.
  protected decodeRecoveryLog(eventType: EventType, args: ethers.utils.Result, account: string, chainId: number, position: LogPosition) {
    switch (eventType) {
      case EventType.RecoveryExecuted:
        return new RecoveryExecutedEvent(
          chainId,
          this.address,
          account,
          (args.newOwners as ethers.utils.Indexed).hash.toLowerCase(),
          toBigInt(args.newThreshold),
          toBigInt(args.nonce),
          toBigInt(args.executeAfter),
          toBigInt(args.guardiansApprovalCount),
          ...position,
        );
      case EventType.RecoveryFinalized:
        return new RecoveryFinalizedEvent(
          chainId,
          this.address,
          account,
          (args.newOwners as ethers.utils.Indexed).hash.toLowerCase(),
          toBigInt(args.newThreshold),
          toBigInt(args.nonce),
          ...position,
        );
      case EventType.RecoveryCanceled:
        return new RecoveryCanceledEvent(chainId, this.address, account, toBigInt(args.nonce), ...position);
    }
    return undefined;
  }
}

class RecoveryModuleV0_2_0 extends RecoveryModule {
  public readonly topics = eventTopics(v0_2_0Interface);

  constructor(variant: RecoveryModuleVariant, fallback: boolean, indexer: RecoveryModuleIndexerConfig, provider: ethers.providers.Provider) {
    super(variant, fallback, indexer, v0_2_0Interface, provider);
  }

  public async readRecoveryRequest(account: string): Promise<OnChainRecoveryRequest> {
    const request = await this.contract.getRecoveryRequest(account);
    return {
      approvalCount: toBigInt(request.guardiansApprovalCount),
      newThreshold: toBigInt(request.newThreshold),
      newOwners: (request.newOwners as string[]).map((owner) => owner.toLowerCase()),
      executableAt: toBigInt(request.executableAt),
      nonce: toBigInt(request.nonce),
    };
  }

  // newOwners is in the log data and recoveryHash is indexed. newOwnersHash is computed the way
  // Solidity hashes an indexed address[] (and v0.1.0 logs carry it), so both versions join the same way.
  protected decodeRecoveryLog(eventType: EventType, args: ethers.utils.Result, account: string, chainId: number, position: LogPosition) {
    const recoveryHash = (args.recoveryHash as string).toLowerCase();
    switch (eventType) {
      case EventType.RecoveryExecuted: {
        const newOwners = (args.newOwners as string[]).map((owner) => owner.toLowerCase());
        return new RecoveryExecutedEvent(
          chainId,
          this.address,
          account,
          ethers.utils.solidityKeccak256(["address[]"], [newOwners]).toLowerCase(),
          toBigInt(args.newThreshold),
          toBigInt(args.nonce),
          toBigInt(args.executableAt),
          toBigInt(args.guardiansApprovalCount),
          ...position,
          recoveryHash,
          newOwners,
        );
      }
      case EventType.RecoveryFinalized: {
        const newOwners = (args.newOwners as string[]).map((owner) => owner.toLowerCase());
        return new RecoveryFinalizedEvent(
          chainId,
          this.address,
          account,
          ethers.utils.solidityKeccak256(["address[]"], [newOwners]).toLowerCase(),
          toBigInt(args.newThreshold),
          toBigInt(args.nonce),
          ...position,
          recoveryHash,
          newOwners,
        );
      }
      case EventType.RecoveryCanceled:
        return new RecoveryCanceledEvent(chainId, this.address, account, toBigInt(args.nonce), ...position, recoveryHash);
    }
    return undefined;
  }
}

// Throws for an address that is not a pinned variant (see utils/recovery-modules.ts).
export const createRecoveryModule = (config: RecoveryModuleConfig, provider: ethers.providers.Provider): RecoveryModule => {
  const variant = findRecoveryModuleVariant(config.address);
  if (!variant) {
    throw new Error(`'${config.address}' is not a known SocialRecoveryModule deployment.`);
  }
  return variant.version === "0.1.0"
    ? new RecoveryModuleV0_1_0(variant, config.fallback, config.indexer, provider)
    : new RecoveryModuleV0_2_0(variant, config.fallback, config.indexer, provider);
};
