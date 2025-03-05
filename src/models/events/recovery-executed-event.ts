import {IndexedEvent} from "./indexed-event";
import {EventType} from "../../utils/constants";

export class RecoveryExecutedEvent extends IndexedEvent {

  constructor(
    public readonly chainId: number,
    public readonly account: string,
    public readonly newThreshold: bigint,
    public readonly nonce: bigint,
    public readonly executeAfter: bigint,
    public readonly guardiansApprovalCount: bigint,
    public readonly blockNumber: number,
    public readonly transactionIndex: number,
    public readonly logIndex: number,
    public readonly transactionHash: string,
  ) {
    super(chainId, account, EventType.RecoveryExecuted, blockNumber, transactionIndex, logIndex, transactionHash);
  }

  getIndexedData(): Record<string, any> {
    return {
      account: this.account,
      newThreshold: this.newThreshold,
      nonce: this.nonce,
      executeAfter: this.executeAfter,
      guardiansApprovalCount: this.guardiansApprovalCount,
    };
  }
}