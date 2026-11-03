import {IndexedEvent} from "./indexed-event";
import {EventType} from "../../utils/constants";

export class RecoveryExecutedEvent extends IndexedEvent {

  constructor(
    public readonly chainId: number,
    public readonly moduleAddress: string,
    public readonly account: string,
    public readonly newOwnersHash: string, // solidityKeccak256(newOwners)
    public readonly newThreshold: bigint,
    public readonly nonce: bigint,
    public readonly executeAfter: bigint, // executableAt on v0.2.0
    public readonly guardiansApprovalCount: bigint,
    public readonly blockNumber: number,
    public readonly transactionIndex: number,
    public readonly logIndex: number,
    public readonly transactionHash: string,
    // v0.2.0 only: v0.1.0 logs carry the owners as an indexed hash and no recovery hash
    public readonly recoveryHash?: string,
    public readonly newOwners?: string[],
  ) {
    super(chainId, moduleAddress, account, EventType.RecoveryExecuted, blockNumber, transactionIndex, logIndex, transactionHash);
  }

  getIndexedData(): Record<string, any> {
    return {
      account: this.account,
      newOwnersHash: this.newOwnersHash,
      newThreshold: this.newThreshold,
      nonce: this.nonce,
      executeAfter: this.executeAfter,
      guardiansApprovalCount: this.guardiansApprovalCount,
      recoveryHash: this.recoveryHash,
      newOwners: this.newOwners,
    };
  }
}