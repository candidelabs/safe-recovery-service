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

export const createSubscription = async (account: string, chainId: number, channel: string, target: string, message: string, signature: string) => {
  const alertChannel = Alerts.instance().getAlertChannel(Configuration.instance().indexerAlert, channel);
  if (!alertChannel){
    throw new ApiError(httpStatus.BAD_REQUEST, `Target channel '${channel}' is not supported for alerts`);
  }
  //
  const sanitizedTarget = await alertChannel.sanitizeTarget(target);
  if (!sanitizedTarget) {
    throw new ApiError(httpStatus.FORBIDDEN, `Target '${target}' is not compatible with '${channel}' channel`);
  }
  //
  let statement = MessageStatements["alerts-subscribe"];
  statement = statement.replace("{{target}}", target);
  statement = statement.replace("{{channel}}", channel);
  await validateSIWEMessage(message, account, chainId, statement, signature);
  //
  target = sanitizedTarget;
  const existingSubscription = await prisma.alertSubscription.findFirst({
    where: {
      account: {equals: account.toLowerCase()},
      channel: {equals: channel},
      target: {equals: target.toLowerCase()},
      active: {equals: true}
    }
  });
  if (existingSubscription){
    throw new ApiError(httpStatus.CONFLICT, `An active subscription already exists for ${account} using ${target} as ${channel}`);
  }
  //
  const [challenge, challengeHash] = await alertChannel.generateChallenge(account.toLowerCase());
  await alertChannel.sendMessage("otpVerification", target, {
    "subject": "OTP Verification for Safe Recovery Module Alerts",
    "otp": challenge
  });
  //
  let alertSubscription = await prisma.alertSubscription.create(
    {
      data: {
        account: account.toLowerCase(),
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
    alertSubscription.account.toLowerCase()
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
  //
  return true;
};

export const fetchSubscriptions = async (account: string, chainId: number, message: string, signature: string) => {
  let statement = MessageStatements["alerts-fetch"];
  await validateSIWEMessage(message, account, chainId, statement, signature);
  //
  const subscriptions = await prisma.alertSubscription.findMany({
    where: {
      account: {equals: account.toLowerCase()},
      active: {equals: true}
    },
    select: {
      id: true,
      channel: true,
      target: true
    }
  });
  return subscriptions;
};

export const unsubscribe = async (subscriptionId: string) => {
  const alertSubscription = await prisma.alertSubscription.findFirst({where: {id: {equals: subscriptionId},}});
  if (!alertSubscription){
    throw new ApiError(httpStatus.NOT_FOUND, `Could not find an alert subscription with this id`);
  }
  //
  await prisma.alertSubscription.delete({
    where: {id: subscriptionId}
  });
  AccountEventTracker.instance().removeSubscription(alertSubscription.account, alertSubscription.id);
  return true;
};

let sendingBusy = false;
export const startSendNotificationsCronJob = () => {
  const cronJob = cron.schedule('*/10 * * * * *', async () => {
    if (sendingBusy) return;
    sendingBusy = true;
    const notifications = await prisma.alertSubscriptionNotification.findMany({where: {deliveryStatus: "PENDING"}});
    for (const notification of notifications) {
      await _sendNotification(notification);
    }
    sendingBusy = false;
  });
  cronJob.start();
}

async function _sendNotification(notification: AlertSubscriptionNotification){
  const indexerAlertId = Configuration.instance().indexerAlert;
  const alertChannel = Alerts.instance().getAlertChannel(indexerAlertId, notification.channel);
  if (!alertChannel){
    const data = {...notification.data as Prisma.JsonObject, failedReason: `Alert channel ${notification.channel} not found on ${indexerAlertId}`};
    await prisma.alertSubscriptionNotification.update({
      data: {data: data, deliveryStatus: "FAILED",},
      where: {id: notification.id}
    });
    return;
  }
  const message = (notification.data as Record<string, any>)["message"] as SummaryMessageData;
  await prisma.alertSubscriptionNotification.update({data: {deliveryStatus: "SENDING",}, where: {id: notification.id}});
  const success = await alertChannel.sendMessage(
    "notification",
    notification.target,
    {
      argumentData: message,
      subject: "Security: Changes have been made to your social recovery setting",
    }
  );
  if (success){
    await prisma.alertSubscriptionNotification.update({data: {deliveryStatus: "SENT",}, where: {id: notification.id}});
  }else{
    await prisma.alertSubscriptionNotification.update({data: {deliveryStatus: "FAILED",}, where: {id: notification.id}});
  }
}