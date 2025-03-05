import {IndexedEvent} from "./indexed-event";
import {EventType} from "../../utils/constants";

export class RecoveryCanceledEvent extends IndexedEvent {

  constructor(
    public readonly chainId: number,
    public readonly account: string,
    public readonly nonce: bigint,
    public readonly blockNumber: number,
    public readonly transactionIndex: number,
    public readonly logIndex: number,
    public readonly transactionHash: string,
  ) {
    super(chainId, account, EventType.RecoveryCanceled, blockNumber, transactionIndex, logIndex, transactionHash);
  }

  getIndexedData(): Record<string, any> {
    return {
      account: this.account,
      nonce: this.nonce
    };
  }
}