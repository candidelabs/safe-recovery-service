import {EventType} from "../../utils/constants";

export abstract class IndexedEvent {
  protected constructor(
    public readonly chainId: number,
    public readonly account: string,
    public readonly eventType: EventType,
    public readonly blockNumber: number,
    public readonly transactionIndex: number,
    public readonly logIndex: number,
    public readonly transactionHash: string,
  ) {}

  abstract getIndexedData(): Record<string, any>;
}