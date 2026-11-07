import httpStatus from "http-status";
import {ApiError, validateSIWEMessage,} from "../utils";
import {prisma} from "../config/prisma-client";
import {Alerts} from "../models/alert/alerts";
import {AccountEventTracker} from "../models/events/account-event-tracker";
import {Configuration} from "../config/config-manager";
import {AlertSubscriptionNotification, Prisma} from "@prisma/client";
import * as cron from "node-cron";
import {SummaryMessageData} from "../utils/interfaces";
import {MessageStatements} from "../utils/constants";
import {SafeAccountV0_3_0 as SafeAccount} from "abstractionkit";
import {Network} from "../models/network";
import logger from "../utils/logger";

const log = logger.child({ component: "alerts" });

const fetchAccountOwners = async (account: string, chainId: number): Promise<string[]> => {
  const safeAccount = new SafeAccount(account);
  const network = Network.instances.get(chainId.toString())!;
  let owners: string[];
  try {
    owners = await safeAccount.getOwners(network.jsonRPCEndpoint);
  } catch (e) {
    throw new ApiError(httpStatus.BAD_REQUEST, `Unable to fetch owners for account '${account}' on chain ${chainId}. The account may not be deployed.`);
  }
  return owners.map(e => e.toLowerCase());
};

const requireAccountOwner = async (account: string, owner: string, chainId: number): Promise<string[]> => {
  const owners = await fetchAccountOwners(account, chainId);
  if (!owners.includes(owner.toLowerCase())){
    throw new ApiError(httpStatus.FORBIDDEN, `Owner must be a valid owner for the account provided`);
  }
  return owners;
};

// A subscription belongs to the account, and `owner` records who created it. A current owner of the account
// manages its own subscriptions and the ones whose creator is no longer an owner (a recovery or an owner swap
// replaced the key), but not those of another current owner.
const canManageSubscription = (subscriptionOwner: string, owner: string, owners: string[]) =>
  subscriptionOwner === owner.toLowerCase() || !owners.includes(subscriptionOwner);

export const createSubscription = async (account: string, owner: string, chainId: number, channel: string, target: string, message: string, signature: string) => {
  const alertChannel = Alerts.instance().getAlertChannel(Configuration.instance().indexerAlert, channel);
  if (!alertChannel){
    throw new ApiError(httpStatus.BAD_REQUEST, `Target channel '${channel}' is not supported for alerts`);
  }
  //
  const sanitizedTarget = await alertChannel.sanitizeTarget(target);
  if (!sanitizedTarget) {
    throw new ApiError(httpStatus.FORBIDDEN, `Target is not compatible with the '${channel}' channel`);
  }
  //
  let statement = MessageStatements["alerts-subscribe"];
  statement = statement.replace("{{account}}", account.toLowerCase());
  statement = statement.replace("{{target}}", target);
  statement = statement.replace("{{channel}}", channel);
  await validateSIWEMessage(message, owner, chainId, statement, signature);
  await requireAccountOwner(account, owner, chainId);
  //
  target = sanitizedTarget;
  const existingSubscription = await prisma.alertSubscription.findFirst({
    where: {
      account: {equals: account.toLowerCase()},
      owner: {equals: owner.toLowerCase()},
      channel: {equals: channel},
      target: {equals: target.toLowerCase()},
      active: {equals: true}
    }
  });
  if (existingSubscription){
    throw new ApiError(httpStatus.CONFLICT, `An active subscription already exists for ${owner} in ${account} on the '${channel}' channel`);
  }
  //
  const [challenge, challengeHash] = await alertChannel.generateChallenge(account.toLowerCase()+owner.toLowerCase());
  await alertChannel.sendMessage("otpVerification", target, {
    "subject": "OTP Verification for Safe Recovery Module Alerts",
    "otp": challenge
  });
  //
  let alertSubscription = await prisma.alertSubscription.create(
    {
      data: {
        account: account.toLowerCase(),
        owner: owner.toLowerCase(),
        channel,
        target,
        active: false,
        challengeHash,
        verified: false,
        tries: 0,
        expiresAt: new Date(Date.now() + 10*60*1000)
      }
    }
  );
  // the target (email / phone number) and the OTP are never logged
  log.info({ subscriptionId: alertSubscription.id, account: account.toLowerCase(), chainId, channel }, "alert subscription created");
  return alertSubscription.id;
};

export const activateSubscription = async (subscriptionId: string, challenge: string) => {
  const alertSubscription = await prisma.alertSubscription.findFirst({where: {id: {equals: subscriptionId}}});
  if (!alertSubscription){
    throw new ApiError(httpStatus.NOT_FOUND, `Alert subscription not found`);
  }
  if (alertSubscription.active){
    throw new ApiError(httpStatus.BAD_REQUEST, `Alert subscription already active`);
  }
  //
  const alertChannel = Alerts.instance().getAlertChannel(Configuration.instance().indexerAlert, alertSubscription.channel);
  if (!alertChannel){
    throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, `Channel '${alertSubscription.channel}' no longer exists, please contact support`);
  }
  //
  const currentDate = new Date(Date.now());
  if (alertSubscription.expiresAt < currentDate){
    throw new ApiError(httpStatus.FORBIDDEN, `Alert subscription request's challenge has been expired`);
  }
  //
  const validChallenge = await alertChannel.verifyChallenge(
    challenge,
    alertSubscription.challengeHash,
    alertSubscription.account.toLowerCase() + alertSubscription.owner.toLowerCase()
  );
  if (!validChallenge){
    await prisma.alertSubscription.update({
      data: {tries: {increment: 1}},
      where: {id: alertSubscription.id}
    });
    throw new ApiError(httpStatus.FORBIDDEN, `Invalid challenge`);
  }
  //
  await prisma.alertSubscription.update({
    data: {active: true, verified: true, verifiedAt: currentDate},
    where: {id: alertSubscription.id}
  });
  AccountEventTracker.instance().addSubscription(
    alertSubscription.account,
    alertSubscription.id,
    alertSubscription.channel,
    alertSubscription.target,
  );
  log.info(
    { subscriptionId: alertSubscription.id, account: alertSubscription.account, channel: alertSubscription.channel },
    "alert subscription activated"
  );
  //
  return true;
};

export const fetchSubscriptions = async (account: string, owner: string, chainId: number, message: string, signature: string) => {
  let statement = MessageStatements["alerts-fetch"];
  await validateSIWEMessage(message, owner, chainId, statement, signature);
  const owners = await requireAccountOwner(account, owner, chainId);
  //
  const subscriptions = await prisma.alertSubscription.findMany({
    where: {
      account: {equals: account.toLowerCase()},
      active: {equals: true},
      // canManageSubscription, as a query
      OR: [
        {owner: {equals: owner.toLowerCase()}},
        {owner: {notIn: owners}},
      ],
    },
    select: {
      id: true,
      owner: true,
      channel: true,
      target: true
    }
  });
  return subscriptions;
};

export const unsubscribe = async (subscriptionId: string, chainId: number, owner: string, message: string, signature: string) => {
  const alertSubscription = await prisma.alertSubscription.findFirst({where: {id: {equals: subscriptionId},}});
  if (!alertSubscription){
    throw new ApiError(httpStatus.NOT_FOUND, `Could not find an alert subscription with this id`);
  }
  const statement = MessageStatements["alerts-unsubscribe"];
  await validateSIWEMessage(message, owner, chainId, statement, signature);
  const owners = await requireAccountOwner(alertSubscription.account, owner, chainId);
  if (!canManageSubscription(alertSubscription.owner, owner, owners)){
    throw new ApiError(httpStatus.FORBIDDEN, `This subscription belongs to another owner of the account`);
  }
  //
  await prisma.alertSubscription.delete({
    where: {id: subscriptionId}
  });
  AccountEventTracker.instance().removeSubscription(alertSubscription.account, alertSubscription.id);
  log.info(
    { subscriptionId: alertSubscription.id, account: alertSubscription.account, channel: alertSubscription.channel },
    "alert subscription removed"
  );
  return true;
};

interface NotificationAccumilationTrigger {
   [key: string]: Date;
}

let sendingBusy = false;
let notificationAccumilationTrigger: NotificationAccumilationTrigger = {}; 
export const startSendNotificationsCronJob = () => {
  const cronJob = cron.schedule('*/10 * * * * *', async () => {
    if (sendingBusy) return;
    sendingBusy = true;
    const notifications = await prisma.alertSubscriptionNotification.findMany({where: {deliveryStatus: "PENDING"}});
    const targetTriggered:string[] = [];
    for (const notification of notifications) {
      let target = notification.target;
      if(!(target in notificationAccumilationTrigger)){ 
        notificationAccumilationTrigger[target] = new Date();
      }
    }
    for (const target in notificationAccumilationTrigger) {
     if(
          (
              (Date.now() - notificationAccumilationTrigger[target].getTime())/1000
          ) > 60 // 1 minute
      ){
        targetTriggered.push(target);
      }
    }

    for (const target of targetTriggered) {
        const targetNotifications = await prisma.alertSubscriptionNotification.findMany(
            {where: {deliveryStatus: "PENDING", target: target}}
        );
        await _sendNotification(target, targetNotifications);
        delete notificationAccumilationTrigger[target];
    }
    sendingBusy = false;
  });
  cronJob.start();
}

async function _sendNotification(target: string, notifications: AlertSubscriptionNotification[]){
  const indexerAlertId = Configuration.instance().indexerAlert;
  //using the alert from the first notification for now
  const alertChannel = Alerts.instance().getAlertChannel(indexerAlertId, notifications[0].channel);
  if (!alertChannel){
    log.error(
      { alertId: indexerAlertId, channel: notifications[0].channel, notificationId: notifications[0].id },
      "alert channel not configured"
    );
    const data = {...notifications[0].data as Prisma.JsonObject, failedReason: `Alert channel ${notifications[0].channel} not found on ${indexerAlertId}`};
    await prisma.alertSubscriptionNotification.update({
      data: {data: data, deliveryStatus: "FAILED",},
      where: {id: notifications[0].id}
    });
    return;
  }
  if (Configuration.instance().suppressAlerts) {
    for (const notification of notifications) {
      await prisma.alertSubscriptionNotification.update({
        data: {deliveryStatus: "SENT"},
        where: {id: notification.id}
      });
    }
    return;
  }
  let messages:SummaryMessageData[] = [];
  for (const notification of notifications){
      messages.push(
          (notification.data as Record<string, any>)["message"] as SummaryMessageData
      );
      await prisma.alertSubscriptionNotification.update({data: {deliveryStatus: "SENDING",}, where: {id: notification.id}});
  }
  const success = await alertChannel.sendMessage(
    "notification",
    target,
    {
      argumentData: messages,
      subject: "Security: Changes have been made to your social recovery setting",
    }
  );
  const delivery = { alertId: indexerAlertId, channel: alertChannel.channelName, count: notifications.length };
  if (success){
    log.info(delivery, "alert notifications sent");
    for (const notification of notifications){
        await prisma.alertSubscriptionNotification.update({data: {deliveryStatus: "SENT",}, where: {id: notification.id}});
    }
  }else{
    // the channel logged the send error; the notifications are marked FAILED
    log.warn(delivery, "alert notifications failed");
    for (const notification of notifications){
        await prisma.alertSubscriptionNotification.update({data: {deliveryStatus: "FAILED",}, where: {id: notification.id}});
    }
  }
}