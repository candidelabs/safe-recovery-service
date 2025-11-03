import {IndexedEvent} from "./indexed-event";
import {EventType} from "../../utils/constants";
import {getSocialModuleInstance, toNormalCase} from "../../utils";
import {Network} from "../network";
import {GuardianAddedEvent} from "./guardian-added-event";
import {GuardianRevokedEvent} from "./guardian-revoked-event";
import {ChangedThresholdEvent} from "./changed-threshold-event";
import {prisma} from "../../config/prisma-client";
import {SummaryMessageData} from "../../utils/interfaces";

interface SubscriptionData {
  subscriptionId: string;
  channel: string;
  target: string;
}

export class AccountEventTracker {
  private static _instance: AccountEventTracker;
  private subscriptions = new Map<string, SubscriptionData[]>();
  private eventsByAccount: Map<string, Map<number, IndexedEvent[]>>;

  private constructor() {
    this.eventsByAccount = new Map();
  }

  public static instance(): AccountEventTracker {
    if (!AccountEventTracker._instance) {
      AccountEventTracker._instance = new AccountEventTracker();
    }
    return AccountEventTracker._instance;
  }

  public async loadSubscriptions(){
    const subscriptions = await prisma.alertSubscription.findMany({where:{active: true}});
    for (const subscription of subscriptions){
      if (!this.subscriptions.has(subscription.account)){
        this.subscriptions.set(subscription.account, []);
      }
      this.subscriptions.get(subscription.account)!.push({
        subscriptionId: subscription.id,
        channel: subscription.channel,
        target: subscription.target
      });
    }
  }

  public addSubscription(account: string, subscriptionId: string, channel: string, target: string){
    if (!this.subscriptions.has(account)){
      this.subscriptions.set(account, []);
    }
    this.subscriptions.get(account)!.push({
      subscriptionId,
      channel,
      target
    });
  }

  public removeSubscription(account: string, subscriptionId: string){
    if (!this.subscriptions.has(account)) return;
    const subscriptions = this.subscriptions.get(account)!;
    const newSubscriptions = [];
    for (const subscription of subscriptions){
      if (subscription.subscriptionId !== subscriptionId){
        newSubscriptions.push(subscription);
      }
    }
    this.subscriptions.set(account, newSubscriptions);
  }

  public getAccountSubscriptions(account: string): SubscriptionData[] | undefined {
    return this.subscriptions.get(account);
  }

  public addEvent(event: IndexedEvent): void {
    if (!this.eventsByAccount.has(event.account)){
      this.eventsByAccount.set(event.account, new Map());
    }
    const chainsMap = this.eventsByAccount.get(event.account)!;
    if (!chainsMap.has(event.chainId)){
      chainsMap.set(event.chainId, []);
    }
    const accountEvents = this.eventsByAccount.get(event.account)!.get(event.chainId)!;
    accountEvents.push(event);
  }

  public getEventsForAccount(account: string, chainId: number): IndexedEvent[] {
    if (!this.eventsByAccount.has(account)) return [];
    if (!this.eventsByAccount.get(account)!.has(chainId)) return [];
    const accountEvents = this.eventsByAccount.get(account)!.get(chainId)!;
    accountEvents.sort((a, b) => {
      if (a.blockNumber !== b.blockNumber) {
        return a.blockNumber - b.blockNumber;
      }
      if (a.transactionIndex !== b.transactionIndex) {
        return a.transactionIndex - b.transactionIndex;
      }
      return a.logIndex - b.logIndex;
    });
    return accountEvents;
  }

  public getEventsByType<T extends IndexedEvent>(account: string, chainId: number, eventType: EventType): T[] {
    const accountEvents = this.eventsByAccount.get(account)?.get(chainId) || [];
    return accountEvents.filter(event => event.eventType === eventType) as T[];
  }

  public clearEventsForAccount(account: string, chainId: number): void {
    if (!this.eventsByAccount.has(account)) return;
    this.eventsByAccount.get(account)!.set(chainId, []);
  }

  public getAllAccounts(chainId: number): string[] {
    const allAccounts = this.eventsByAccount.keys();
    const chainAccounts = [];
    for (const account of allAccounts) {
      if (!this.eventsByAccount.get(account)!.has(chainId)) continue;
      chainAccounts.push(account);
    }
    return chainAccounts;
  }

  public async getEventSummary(account: string, chainId: number): Promise<SummaryMessageData | undefined> {
    const events = this.getEventsForAccount(account, chainId);
    if (events.length === 0) {
      return undefined;
    }

    const network = Network.instances.get(chainId.toString())!;
    const socialRecoveryModule = getSocialModuleInstance(network.recoveryModuleAddress, network.jsonRPCProvider);

    let latestRecoveryEvent: IndexedEvent | undefined;
    for (const event of events) {
      if (event.eventType !== EventType.RecoveryExecuted
        && event.eventType !== EventType.RecoveryFinalized
        && event.eventType !== EventType.RecoveryCanceled) continue;
      latestRecoveryEvent = event;
    }

    const guardianManagementEvents = events.filter(e =>
      e.eventType === EventType.GuardianAdded ||
      e.eventType === EventType.GuardianRevoked ||
      e.eventType === EventType.ChangedThreshold
    );

    const result: SummaryMessageData = {
      header: `Security: Changes have been made to your social recovery settings for account ${account} on ${toNormalCase(network.name)} (chainId: ${network.chainId})`
    };

    // Handle critical events
    if (latestRecoveryEvent) {
      const data = latestRecoveryEvent.getIndexedData();
      let details: string;
      switch (latestRecoveryEvent.eventType) {
        case EventType.RecoveryExecuted:
          details = `RECOVERY EXECUTED
New Threshold: ${data.newThreshold}
Nonce: ${data.nonce}
Execute After: ${new Date(Number(data.executeAfter)).toISOString()}
Guardian Approvals: ${data.guardiansApprovalCount}
Block: ${latestRecoveryEvent.blockNumber}, Tx Hash: ${latestRecoveryEvent.transactionHash}`;
          break;
        case EventType.RecoveryFinalized:
          details = `RECOVERY FINALIZED
New Threshold: ${data.newThreshold}
Nonce: ${data.nonce}
Block: ${latestRecoveryEvent.blockNumber}, Tx Hash: ${latestRecoveryEvent.transactionHash}`;
          break;
        case EventType.RecoveryCanceled:
          details = `RECOVERY CANCELED
Nonce: ${data.nonce}
Block: ${latestRecoveryEvent.blockNumber}, Tx Hash: ${latestRecoveryEvent.transactionHash}`;
          break;
        default:
          details = '';
      }
      result.critical = details
    }

    // Handle non-critical events
    let guardianAddCount = 0;
    let guardianRevokeCount = 0;
    let latestThreshold: bigint | undefined;
    const addedGuardians = new Set<string>();
    const revokedGuardians = new Set<string>();

    for (const event of guardianManagementEvents) {
      let _event;
      switch (event.eventType) {
        case EventType.GuardianAdded:
          _event = event as GuardianAddedEvent;
          if (revokedGuardians.has(_event.guardian)) {
            guardianRevokeCount--;
            revokedGuardians.delete(_event.guardian);
          }
          if (addedGuardians.has(_event.guardian)) continue;
          guardianAddCount++;
          addedGuardians.add(_event.guardian);
          break;
        case EventType.GuardianRevoked:
          _event = event as GuardianRevokedEvent;
          if (addedGuardians.has(_event.guardian)) {
            guardianAddCount--;
            addedGuardians.delete(_event.guardian);
          }
          if (revokedGuardians.has(_event.guardian)) continue;
          guardianRevokeCount++;
          revokedGuardians.add(_event.guardian);
          break;
        case EventType.ChangedThreshold:
          latestThreshold = (event as ChangedThresholdEvent).newThreshold;
          break;
      }
    }

    const currentGuardians = await socialRecoveryModule.getGuardians(account) as string[];
    const summaryParts: string[] = [];
    if (guardianAddCount > 0 || guardianRevokeCount > 0) {
      const netGuardians = guardianAddCount - guardianRevokeCount;
      if (netGuardians !== 0) {
        summaryParts.push(`${netGuardians > 0 ? 'Added' : 'Removed'} ${Math.abs(netGuardians)} guardian${Math.abs(netGuardians) === 1 ? '' : 's'}`);
      }
    }
    if (latestThreshold !== undefined) {
      summaryParts.push(`Threshold: ${latestThreshold}`);
    }
    summaryParts.push(`Current Guardians:\n${currentGuardians.join("\n")}`);

    if (summaryParts.length > 0) {
      result.accountChanges = summaryParts
    }

    return result;
  }
}