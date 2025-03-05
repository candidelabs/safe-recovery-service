import {IndexedEvent} from "./indexed-event";
import {EventType} from "../../utils/constants";

export class GuardianRevokedEvent extends IndexedEvent {

  constructor(
    public readonly chainId: number,
    public readonly account: string,
    public readonly guardian: string,
    public readonly blockNumber: number,
    public readonly transactionIndex: number,
    public readonly logIndex: number,
    public readonly transactionHash: string,
  ) {
    super(chainId, account, EventType.GuardianRevoked, blockNumber, transactionIndex, logIndex, transactionHash);
  }

  getIndexedData(): Record<string, any> {
    return {
      account: this.account,
      guardian: this.guardian
    };
  }
}