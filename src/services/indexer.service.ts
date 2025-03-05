import {BigNumber, ethers} from 'ethers';
import * as cron from "node-cron";
import {Network} from "../models/network";
import Logger from "../utils/logger";
import {delay} from "../utils";
import {EventType} from "../utils/constants";
import {IndexedEvent} from "../models/events/indexed-event";
import {GuardianAddedEvent} from "../models/events/guardian-added-event";
import {GuardianRevokedEvent} from "../models/events/guardian-revoked-event";
import {ChangedThresholdEvent} from "../models/events/changed-threshold-event";
import {RecoveryExecutedEvent} from "../models/events/recovery-executed-event";
import {RecoveryCanceledEvent} from "../models/events/recovery-canceled-event";
import {RecoveryFinalizedEvent} from "../models/events/recovery-finalized-event";
import {AccountEventTracker} from "../models/events/account-event-tracker";
import {prisma} from "../config/prisma-client";

interface FailedRange {
  fromBlock: number;
  toBlock: number;
  retryCount: number;
}

const MAX_CONCURRENT_REQUESTS = 30;
const INDEXER_EVENT_TOPICS: Record<string, EventType> = {
  "0xbc3292102fa77e083913064b282926717cdfaede4d35f553d66366c0a3da755a": EventType.GuardianAdded,
  "0x548f10dcba266544123ad8cf8284f25c4baa659cba25dbdf16a06ea11235de9b": EventType.GuardianRevoked,
  "0xde3e32a86d32ca955594af26f515d3dc60003ab279776b14b4012fe99d96f8f6": EventType.ChangedThreshold,
  "0x1fa74635dcccfa96011b50295a26dd08b8c3c6ca7d66ede450288192674ebf01": EventType.RecoveryExecuted,
  "0x8f02bbdd0d302f6cdd4a448157ae4156c07384b648beae077292ba804d60ad5a": EventType.RecoveryFinalized,
  "0x81da66c7aac3ee4365918a5d70f73e846a59e8a8af01ef155e86518190490519": EventType.RecoveryCanceled
}
const INDEXER_EVENT_TYPES: Record<EventType, string> = {
  [EventType.GuardianAdded]: "0xbc3292102fa77e083913064b282926717cdfaede4d35f553d66366c0a3da755a",
  [EventType.GuardianRevoked]: "0x548f10dcba266544123ad8cf8284f25c4baa659cba25dbdf16a06ea11235de9b",
  [EventType.ChangedThreshold]: "0xde3e32a86d32ca955594af26f515d3dc60003ab279776b14b4012fe99d96f8f6",
  [EventType.RecoveryExecuted]: "0x1fa74635dcccfa96011b50295a26dd08b8c3c6ca7d66ede450288192674ebf01",
  [EventType.RecoveryFinalized]: "0x8f02bbdd0d302f6cdd4a448157ae4156c07384b648beae077292ba804d60ad5a",
  [EventType.RecoveryCanceled]: "0x81da66c7aac3ee4365918a5d70f73e846a59e8a8af01ef155e86518190490519"
}

export class Indexer {
  private network: Network;
  private latestFromBlock: number;
  private failedRanges: FailedRange[] = [];
  private maxRetries: number = 3;
  private blockRangeSize: number = 5000;
  private storingBusy: boolean = false;
  private active: boolean;
  private indexerDataId!: string;
  private indexingBusy: boolean = false;
  private indexerReady: boolean = false;
  private cronJob: cron.ScheduledTask | undefined;

  constructor(network: Network, startingBlock: number, active: boolean) {
    this.network = network;
    this.latestFromBlock = startingBlock;
    this.active = active;
  }

  public async start() {
    if (this.indexerReady){
      Logger.debug(`Indexer (${this.network.name}) already running!`);
      return;
    }
    //
    const indexerData = await prisma.indexerData.findFirst({where: {chainId: this.network.chainId}});
    if (indexerData){
      this.latestFromBlock = indexerData.latestIndexedBlock;
      await prisma.indexerData.update({
        data: {
          active: this.active,
        },
        where: {id: indexerData.id}
      });
      this.indexerDataId = indexerData.id;
    } else {
      const indexerData = await prisma.indexerData.create({
        data: {
          chainId: this.network.chainId,
          latestIndexedBlock: this.latestFromBlock,
          active: this.active,
        }
      });
      this.indexerDataId = indexerData.id;
    }
    //
    if (!this.active) return;
    Logger.debug(`Started Indexer (${this.network.name})!`);
    this.cronJob = cron.schedule('*/15 * * * * *', async () => {
      if (!this.storingBusy && !this.indexingBusy){
        this.storeEvents(this.latestFromBlock);
      }
      if (!this.indexingBusy){
        this.indexNewBlocks();
      }
    });
    this.cronJob.start();
  }

  private async indexNewBlocks(): Promise<void> {
    this.indexingBusy = true;
    let concurrentRequests = 0;
    try {
      await this.processFailedRanges();
      const latestOnchainBlock = await this.network.jsonRPCProvider.getBlockNumber();
      let fromBlock = this.latestFromBlock + 1;
      let toBlock = fromBlock + this.blockRangeSize;
      toBlock = Math.min(toBlock, latestOnchainBlock);
      const promises = [];
      while (true){
        if (concurrentRequests >= MAX_CONCURRENT_REQUESTS){
          await delay(350);
          continue;
        }
        // logger.info(`Indexing blocks from ${fromBlock} to ${toBlock}`);
        concurrentRequests++;
        const promise = this.processBlockRange(fromBlock, toBlock, (success) => {
          concurrentRequests--;
          if (!success){
            this.addFailedRange(fromBlock, toBlock);
          }
        });
        this.latestFromBlock = toBlock;
        promises.push(promise);
        fromBlock = toBlock + 1;
        if (fromBlock > latestOnchainBlock){
          break;
        }
        toBlock = fromBlock + this.blockRangeSize;
        toBlock = Math.min(toBlock, latestOnchainBlock);
      }
      await Promise.all(promises);
    } catch (error) {
      Logger.error(`Error in indexNewBlocks: ${error}`);
    }
    this.indexingBusy = false;
  }

  private async processBlockRange(fromBlock: number, toBlock: number, callback?: (success: boolean) => any): Promise<void> {
    const logFilter = {
      "address": this.network.recoveryModuleAddress,
      "topics": [Object.keys(INDEXER_EVENT_TOPICS)],
      "fromBlock": ethers.utils.hexValue(fromBlock),
      "toBlock": ethers.utils.hexValue(toBlock)
    };
    try {
      const logs = await this.network.jsonRPCProvider.send("eth_getLogs", [
        logFilter
      ]);
      await this.processEvents(logs);
      if (callback){
        callback(true);
      }
    } catch (error) {
      Logger.error(`Failed to process blocks ${fromBlock} to ${toBlock}: ${error}`);
      if (callback){
        callback(false);
      }
    }
  }

  private async processFailedRanges(): Promise<void> {
    if (this.failedRanges.length === 0) return;
    let concurrentRequests = 0;

    const rangesToRetry = [...this.failedRanges];
    this.failedRanges = [];
    const deleteRanges = new Set<string>();

    for (const range of rangesToRetry) {
      if (concurrentRequests >= MAX_CONCURRENT_REQUESTS){
        await delay(350);
        continue;
      }
      if (range.retryCount >= this.maxRetries) {
        Logger.error(`Max retries reached for range ${range.fromBlock}-${range.toBlock}`);
        // continue;
      }
      range.retryCount++;
      concurrentRequests++;
      this.processBlockRange(range.fromBlock, range.toBlock, (success) => {
        concurrentRequests--;
        if (success){
          deleteRanges.add(`${range.fromBlock}:${range.toBlock}`);
        }
      });
    }
    while (true){
      if (concurrentRequests > 0){
        await delay(100);
        continue;
      }
      break;
    }
    const removeIndexes: number[] = [];
    for (let i = 0; i < this.failedRanges.length; i++){
      const range = this.failedRanges[i];
      if (deleteRanges.has(`${range.fromBlock}:${range.toBlock}`)){
        removeIndexes.push(i);
      }
    }
    for (const index of removeIndexes) {
      this.failedRanges.splice(index, 1);
    }
  }

  private addFailedRange(fromBlock: number, toBlock: number): void {
    this.failedRanges.push({
      fromBlock,
      toBlock,
      retryCount: 0
    });
  }

  private async processEvents(logs: ethers.providers.Log[]): Promise<void> {
    for (let i = 0; i < logs.length; i++){
      const log = this.network.jsonRPCProvider.formatter.receiptLog(logs[i]);
      const eventType = INDEXER_EVENT_TOPICS[log.topics[0]];
      this.trackEvents(eventType, log);
    }
  }

  private trackEvents(eventType: EventType, log: ethers.providers.Log) {
    const account = log.topics[1]._0xRemove().slice(24)._0x().toLowerCase();
    const blockNumber = log.blockNumber;
    const transactionIndex = log.transactionIndex;
    const logIndex = log.logIndex;
    const transactionHash = log.transactionHash;
    const chainId = this.network.chainId;
    let indexedEvent: IndexedEvent;
    if (eventType == EventType.GuardianAdded) {
      const guardian = log.topics[2]._0xRemove().slice(24)._0x().toLowerCase();
      indexedEvent = new GuardianAddedEvent(chainId, account, guardian, blockNumber, transactionIndex, logIndex, transactionHash);
    }else if (eventType == EventType.GuardianRevoked) {
      const guardian = log.topics[2]._0xRemove().slice(24)._0x().toLowerCase();
      indexedEvent = new GuardianRevokedEvent(chainId, account, guardian, blockNumber, transactionIndex, logIndex, transactionHash);
    }else if (eventType == EventType.ChangedThreshold){
      const data = ethers.utils.defaultAbiCoder.decode(["uint256"], log.data);
      const newThreshold = (data[0] as BigNumber).toBigInt();
      indexedEvent = new ChangedThresholdEvent(chainId, account, newThreshold, blockNumber, transactionIndex, logIndex, transactionHash);
    }else if (eventType == EventType.RecoveryExecuted){
      const data = ethers.utils.defaultAbiCoder.decode(
        ["uint256", "uint256", "uint64", "uint256"],
        log.data
      );
      const newThreshold = (data[0] as BigNumber).toBigInt();
      const nonce = (data[1] as BigNumber).toBigInt();
      const executeAfter = (data[2] as BigNumber).toBigInt();
      const guardiansApprovalCount = (data[3] as BigNumber).toBigInt();
      indexedEvent = new RecoveryExecutedEvent(
        chainId,
        account,
        newThreshold,
        nonce,
        executeAfter,
        guardiansApprovalCount,
        blockNumber,
        transactionIndex,
        logIndex,
        transactionHash
      );
    }else if (eventType == EventType.RecoveryCanceled){
      const data = ethers.utils.defaultAbiCoder.decode(["uint256"], log.data);
      const nonce = (data[0] as BigNumber).toBigInt();
      indexedEvent = new RecoveryCanceledEvent(chainId, account, nonce, blockNumber, transactionIndex, logIndex, transactionHash);
    }else if (eventType == EventType.RecoveryFinalized){
      const data = ethers.utils.defaultAbiCoder.decode(
        ["uint256", "uint256"],
        log.data
      );
      const newThreshold = (data[0] as BigNumber).toBigInt();
      const nonce = (data[1] as BigNumber).toBigInt();
      indexedEvent = new RecoveryFinalizedEvent(chainId, account, newThreshold, nonce, blockNumber, transactionIndex, logIndex, transactionHash);
    }else{
      return;
    }
    AccountEventTracker.instance().addEvent(indexedEvent);
  }

  public async storeEvents(latestIndexedBlock: number){
    this.storingBusy = true;
    const accountEventTracker = AccountEventTracker.instance();
    const accounts = accountEventTracker.getAllAccounts(this.network.chainId);
    const promises = [];
    for (const account of accounts){
      const events = accountEventTracker.getEventsForAccount(account, this.network.chainId);
      for (const event of events){
        let promise;
        if (event.eventType == EventType.GuardianAdded){
          promise = this.storeGuardianAddedEvent(event as GuardianAddedEvent);
        }else if (event.eventType == EventType.GuardianRevoked){
          promise = this.storeGuardianRevokedEvent(event as GuardianRevokedEvent);
        }else if (event.eventType == EventType.ChangedThreshold){
          promise = this.storeChangedThresholdEvent(event as ChangedThresholdEvent);
        }else if (event.eventType == EventType.RecoveryExecuted){
          promise = this.storeRecoveryExecutedEvent(event as RecoveryExecutedEvent);
        }else if (event.eventType == EventType.RecoveryFinalized){
          promise = this.storeRecoveryFinalizedEvent(event as RecoveryFinalizedEvent);
        }else if (event.eventType == EventType.RecoveryCanceled){
          promise = this.storeRecoveryCanceledEvent(event as RecoveryCanceledEvent);
        }
        promises.push(promise);
      }
      const accountSubscriptions = accountEventTracker.getAccountSubscriptions(account);
      if (accountSubscriptions && accountSubscriptions.length > 0){
        const promise = accountEventTracker.getEventSummary(account, this.network.chainId).then((message) => {
          for (const subscription of accountSubscriptions){
            prisma.alertSubscriptionNotification.create({
              data: {
                account: account,
                channel: subscription.channel,
                target: subscription.target,
                data: {message},
                deliveryStatus: "PENDING"
              }
            });
          }
        });
        promises.push(promise);
      }
      accountEventTracker.clearEventsForAccount(account, this.network.chainId);
    }
    await Promise.all(promises);
    if (this.failedRanges.length == 0){
      await prisma.indexerData.update({
        data: {latestIndexedBlock: latestIndexedBlock},
        where: {id: this.indexerDataId}
      });
    }
    this.storingBusy = false;
  }

  private async storeGuardianAddedEvent(event: GuardianAddedEvent){
    await prisma.guardianAddedEvent.create({
      data: {
        account: event.account,
        chainId: event.chainId,
        guardian: event.guardian,
        transactionHash: event.transactionHash,
        blockNumber: event.blockNumber,
        transactionIndex: event.transactionIndex,
        logIndex: event.logIndex,
      }
    });
  }

  private async storeGuardianRevokedEvent(event: GuardianRevokedEvent){
    await prisma.guardianRevokedEvent.create({
      data: {
        account: event.account,
        chainId: event.chainId,
        guardian: event.guardian,
        transactionHash: event.transactionHash,
        blockNumber: event.blockNumber,
        transactionIndex: event.transactionIndex,
        logIndex: event.logIndex,
      }
    });
  }

  private async storeChangedThresholdEvent(event: ChangedThresholdEvent){
    await prisma.thresholdChangedEvent.create({
      data: {
        account: event.account,
        chainId: event.chainId,
        threshold: event.newThreshold,
        transactionHash: event.transactionHash,
        blockNumber: event.blockNumber,
        transactionIndex: event.transactionIndex,
        logIndex: event.logIndex,
      }
    });
  }

  private async storeRecoveryExecutedEvent(event: RecoveryExecutedEvent){
    await prisma.recoveryExecutedEvent.create({
      data: {
        account: event.account,
        chainId: event.chainId,
        newThreshold: event.newThreshold,
        nonce: event.nonce,
        executeAfter: event.executeAfter,
        guardiansApprovalCount: event.guardiansApprovalCount,
        transactionHash: event.transactionHash,
        blockNumber: event.blockNumber,
        transactionIndex: event.transactionIndex,
        logIndex: event.logIndex,
      }
    });
  }

  private async storeRecoveryFinalizedEvent(event: RecoveryFinalizedEvent){
    await prisma.recoveryFinalizedEvent.create({
      data: {
        account: event.account,
        chainId: event.chainId,
        newThreshold: event.newThreshold,
        nonce: event.nonce,
        transactionHash: event.transactionHash,
        blockNumber: event.blockNumber,
        transactionIndex: event.transactionIndex,
        logIndex: event.logIndex,
      }
    });
  }

  private async storeRecoveryCanceledEvent(event: RecoveryCanceledEvent){
    await prisma.recoveryCanceledEvent.create({
      data: {
        account: event.account,
        chainId: event.chainId,
        nonce: event.nonce,
        transactionHash: event.transactionHash,
        blockNumber: event.blockNumber,
        transactionIndex: event.transactionIndex,
        logIndex: event.logIndex,
      }
    });
  }

}