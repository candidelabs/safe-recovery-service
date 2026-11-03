import {ethers} from 'ethers';
import * as cron from "node-cron";
import {Network} from "../models/network";
import {RecoveryModule} from "../models/recovery-module";
import type {Logger} from "../logging";
import logger from "../utils/logger";
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
import {Configuration} from "../config/config-manager";
import {prisma} from "../config/prisma-client";
import {assignLegacyRows} from "./recovery-modules.service";

interface FailedRange {
  modules: RecoveryModule[];
  fromBlock: number;
  toBlock: number;
  retryCount: number;
}

// One IndexerData row per module: the last block fetched for it, and the last value written to the DB.
interface ModuleCursor {
  module: RecoveryModule;
  indexerDataId: string;
  latestFromBlock: number;
  storedBlock: number;
}

const MAX_CONCURRENT_REQUESTS = 30;

// One Indexer per Network, covering every module of the network whose indexer is enabled. Modules at
// the same cursor share each eth_getLogs call (its 'address' takes a list). A module whose cursor is
// behind (a module configured later, backfilling from its start block) is fetched on its own until it
// reaches the others: every module ends a cycle at the same head block, so they merge on the next one.
export class Indexer {
  private network: Network;
  private cursors: ModuleCursor[] = [];
  private failedRanges: FailedRange[] = [];
  private maxRetries: number = 3;
  private blockRangeSize: number = 9990;
  private storingBusy: boolean = false;
  private indexingBusy: boolean = false;
  private indexerReady: boolean = false;
  private cronJob: cron.ScheduledTask | undefined;
  // Every line of this indexer carries its chainId and network name.
  private readonly log: Logger;

  constructor(network: Network) {
    this.network = network;
    this.log = logger.child({ component: "indexer", chainId: network.chainId, network: network.name });
  }

  public async start() {
    // Paused outside 'production' / 'development:indexer': no cron, no RPC calls, no IndexerData reads or writes
    if (Configuration.instance().indexerPaused){
      this.log.info("indexer paused");
      return;
    }
    if (this.indexerReady){
      this.log.debug("indexer already running");
      return;
    }
    //
    try {
      await assignLegacyRows(this.network);
    } catch (error) {
      // Indexing on a guessed assignment would mislabel events and reuse another module's cursor.
      this.log.fatal({ err: error }, "legacy indexed rows cannot be assigned to a recovery module");
      logger.flush();
      process.exit(1);
    }
    for (const module of this.network.modules){
      const indexerData = await this.loadIndexerData(module);
      if (!module.indexer.enabled) continue;
      this.cursors.push({
        module,
        indexerDataId: indexerData.id,
        latestFromBlock: indexerData.latestIndexedBlock,
        storedBlock: indexerData.latestIndexedBlock,
      });
    }
    //
    if (this.cursors.length === 0) return;
    this.log.info(
      { modules: this.cursors.map(c => ({ moduleAddress: c.module.address, module: c.module.label, fromBlock: c.latestFromBlock })) },
      "indexer started"
    );
    this.cronJob = cron.schedule('*/15 * * * * *', async () => {
      if (!this.storingBusy && !this.indexingBusy){
        await this.storeEvents();
      }
      if (!this.indexingBusy && !this.storingBusy){
        this.indexNewBlocks();
      }
    });
    this.cronJob.start();
  }

  // A module without a row (assignLegacyRows has given the legacy cursor its module) starts at its
  // configured start block.
  private async loadIndexerData(module: RecoveryModule) {
    const chainId = this.network.chainId;
    const active = module.indexer.enabled;
    const indexerData = await prisma.indexerData.findFirst({where: {chainId, moduleAddress: module.address}});
    if (indexerData){
      return prisma.indexerData.update({
        data: {active},
        where: {id: indexerData.id}
      });
    }
    return prisma.indexerData.create({
      data: {
        chainId,
        moduleAddress: module.address,
        latestIndexedBlock: module.indexer.startBlock,
        active,
      }
    });
  }

  private async indexNewBlocks(): Promise<void> {
    this.indexingBusy = true;
    try {
      await this.processFailedRanges();
      const _latestOnchainBlock = await this.network.jsonRPCProvider.send("eth_blockNumber", []);
      const latestOnchainBlock = parseInt(_latestOnchainBlock, 16) - 2;
      for (const cursors of this.cursorGroups()){
        const latestFromBlock = cursors[0].latestFromBlock;
        this.log.debug(
          {
            moduleAddresses: cursors.map(c => c.module.address),
            headBlock: latestOnchainBlock,
            fromBlock: latestFromBlock + 1,
            lagBlocks: latestOnchainBlock - latestFromBlock,
          },
          "indexer cycle"
        );
        await this.indexBlocks(cursors, latestOnchainBlock);
      }
    } catch (error) {
      this.log.error({ err: error, fn: "indexNewBlocks" }, "indexer cycle failed");
    } finally {
      this.indexingBusy = false;
    }
  }

  // Cursors grouped by block, the most advanced group first so live events are fetched before a backfill.
  private cursorGroups(): ModuleCursor[][] {
    const groups = new Map<number, ModuleCursor[]>();
    for (const cursor of this.cursors){
      if (!groups.has(cursor.latestFromBlock)) groups.set(cursor.latestFromBlock, []);
      groups.get(cursor.latestFromBlock)!.push(cursor);
    }
    return [...groups.entries()].sort((a, b) => b[0] - a[0]).map(([, cursors]) => cursors);
  }

  // Fetches (latestFromBlock, latestOnchainBlock] for modules that share the same cursor.
  private async indexBlocks(cursors: ModuleCursor[], latestOnchainBlock: number): Promise<void> {
    const modules = cursors.map(c => c.module);
    let concurrentRequests = 0;
    let fromBlock = cursors[0].latestFromBlock + 1;
    const promises = [];
    while (fromBlock <= latestOnchainBlock){
      const toBlock = Math.min(fromBlock + this.blockRangeSize, latestOnchainBlock);
      while (concurrentRequests >= MAX_CONCURRENT_REQUESTS){
        await delay(350);
      }
      concurrentRequests++;
      const rangeFrom = fromBlock;
      const promise = this.processBlockRange(modules, rangeFrom, toBlock, (success) => {
        concurrentRequests--;
        if (!success){
          this.addFailedRange(modules, rangeFrom, toBlock);
        }
      });
      for (const cursor of cursors){
        cursor.latestFromBlock = toBlock;
      }
      promises.push(promise);
      fromBlock = toBlock + 1;
    }
    await Promise.all(promises);
  }

  private async processBlockRange(
    modules: RecoveryModule[],
    fromBlock: number,
    toBlock: number,
    callback?: (success: boolean) => any
  ): Promise<void> {
    const logFilter = {
      "address": modules.map(module => module.address),
      // Guardian event topics are shared between versions; recovery event topics differ per version.
      "topics": [[...new Set(modules.flatMap(module => Object.keys(module.topics)))]],
      "fromBlock": ethers.utils.hexValue(fromBlock),
      "toBlock": ethers.utils.hexValue(toBlock)
    };
    try {
      const logs = await this.network.jsonRPCProvider.send("eth_getLogs", [
        logFilter
      ]);
      this.processEvents(logs);
      if (callback){
        callback(true);
      }
    } catch (error) {
      // retried from failedRanges; "indexer range dropped" is the terminal line
      this.log.warn({ err: error, fromBlock, toBlock, moduleAddresses: logFilter.address }, "indexer range failed");
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

    for (const range of rangesToRetry) {
      if (range.retryCount >= this.maxRetries) {
        this.log.error(
          {
            fromBlock: range.fromBlock,
            toBlock: range.toBlock,
            moduleAddresses: range.modules.map(module => module.address),
            attempt: range.retryCount,
            maxAttempts: this.maxRetries,
          },
          "indexer range dropped"
        );
        continue;
      }
      while (concurrentRequests >= MAX_CONCURRENT_REQUESTS){
        await delay(350);
      }
      range.retryCount++;
      concurrentRequests++;
      this.processBlockRange(range.modules, range.fromBlock, range.toBlock, (success) => {
        concurrentRequests--;
        if (!success){
          this.failedRanges.push(range);
        }
      });
    }
    while (concurrentRequests > 0){
      await delay(100);
    }
  }

  private addFailedRange(modules: RecoveryModule[], fromBlock: number, toBlock: number): void {
    this.failedRanges.push({
      modules,
      fromBlock,
      toBlock,
      retryCount: 0
    });
  }

  // Decodes the whole range before buffering anything, so a range that fails and is retried is never
  // buffered twice.
  private processEvents(logs: ethers.providers.Log[]): void {
    const events: IndexedEvent[] = [];
    for (let i = 0; i < logs.length; i++){
      const log = this.network.jsonRPCProvider.formatter.receiptLog(logs[i]);
      const event = this.network.getModule(log.address)?.decodeLog(log, this.network.chainId);
      if (event) events.push(event);
    }
    for (const event of events){
      AccountEventTracker.instance().addEvent(event);
    }
  }

  // Alerts are built per (account, module); events are then stored and every module's cursor is saved,
  // except for modules with a range still waiting to be retried.
  public async storeEvents(){
    this.storingBusy = true;
    try {
      const accountEventTracker = AccountEventTracker.instance();
      const chainId = this.network.chainId;
      const accounts = accountEventTracker.getAllAccounts(chainId);
      const promises = [];
      for (const account of accounts){
        const accountSubscriptions = accountEventTracker.getAccountSubscriptions(account);
        // Counted once per account, before this batch is stored: a first setup is per account, across modules.
        let hasExistingEvents: boolean | undefined;
        for (const moduleAddress of accountEventTracker.getModulesForAccount(account, chainId)){
          const events = accountEventTracker.getEventsForAccount(account, chainId, moduleAddress);
          if (accountSubscriptions && accountSubscriptions.length > 0){
            let message;
            try {
              message = await accountEventTracker.getEventSummary(account, chainId, moduleAddress);
            } catch (error) {
              this.log.error({ err: error, account, moduleAddress }, "event summary failed");
              message = undefined;
            }
            if (message){
              let shouldSkipAlert = false;
              if (Configuration.instance().skipFirstAccountSetupAlert){
                const allSetupEvents = events.every(e =>
                  e.eventType === EventType.GuardianAdded || e.eventType === EventType.ChangedThreshold
                );
                if (allSetupEvents){
                  hasExistingEvents ??= await this.hasExistingEventsForAccount(account, chainId);
                  shouldSkipAlert = !hasExistingEvents;
                }
              }
              if (!shouldSkipAlert){
                for (const subscription of accountSubscriptions){
                  const promise = prisma.alertSubscriptionNotification.create({
                    data: {
                      account: account,
                      channel: subscription.channel,
                      target: subscription.target,
                      data: {message: {...message}},
                      deliveryStatus: "PENDING"
                    }
                  });
                  promises.push(promise);
                }
              }
            }
          }
          for (const event of events){
            promises.push(this.storeEvent(event));
          }
          accountEventTracker.clearEventsForAccount(account, chainId, moduleAddress);
        }
      }
      await Promise.all(promises);
      await this.storeCursors();
    } catch (error) {
      this.log.error({ err: error, fn: "storeEvents" }, "indexer store failed");
    } finally {
      this.storingBusy = false;
    }
  }

  private async storeCursors(){
    const retrying = new Set(this.failedRanges.flatMap(range => range.modules.map(module => module.address)));
    await Promise.all(this.cursors.map(async (cursor) => {
      if (retrying.has(cursor.module.address) || cursor.storedBlock === cursor.latestFromBlock) return;
      const latestIndexedBlock = cursor.latestFromBlock;
      await prisma.indexerData.update({
        data: {latestIndexedBlock},
        where: {id: cursor.indexerDataId}
      });
      cursor.storedBlock = latestIndexedBlock;
    }));
  }

  private storeEvent(event: IndexedEvent): Promise<void> | undefined {
    switch (event.eventType){
      case EventType.GuardianAdded:
        return this.storeGuardianAddedEvent(event as GuardianAddedEvent);
      case EventType.GuardianRevoked:
        return this.storeGuardianRevokedEvent(event as GuardianRevokedEvent);
      case EventType.ChangedThreshold:
        return this.storeChangedThresholdEvent(event as ChangedThresholdEvent);
      case EventType.RecoveryExecuted:
        return this.storeRecoveryExecutedEvent(event as RecoveryExecutedEvent);
      case EventType.RecoveryFinalized:
        return this.storeRecoveryFinalizedEvent(event as RecoveryFinalizedEvent);
      case EventType.RecoveryCanceled:
        return this.storeRecoveryCanceledEvent(event as RecoveryCanceledEvent);
    }
  }

  private async storeGuardianAddedEvent(event: GuardianAddedEvent){
    await prisma.guardianAddedEvent.create({
      data: {
        account: event.account,
        chainId: event.chainId,
        moduleAddress: event.moduleAddress,
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
        moduleAddress: event.moduleAddress,
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
        moduleAddress: event.moduleAddress,
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
        moduleAddress: event.moduleAddress,
        recoveryHash: event.recoveryHash,
        newOwners: event.newOwners ?? [],
        newOwnersHash: event.newOwnersHash,
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
        moduleAddress: event.moduleAddress,
        recoveryHash: event.recoveryHash,
        newOwners: event.newOwners ?? [],
        newOwnersHash: event.newOwnersHash,
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
        moduleAddress: event.moduleAddress,
        nonce: event.nonce,
        recoveryHash: event.recoveryHash,
        transactionHash: event.transactionHash,
        blockNumber: event.blockNumber,
        transactionIndex: event.transactionIndex,
        logIndex: event.logIndex,
      }
    });
  }

  // Across all modules of the chain, so moving guardians to another module is alerted, not taken for a first setup.
  private async hasExistingEventsForAccount(account: string, chainId: number): Promise<boolean> {
    const counts = await prisma.guardianAddedEvent.count({where: {account, chainId}});
    return counts > 0;
  }

}
