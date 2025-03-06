import httpStatus from "http-status";
import {ethers} from "ethers";
import {
  ApiError,
  isValidSignature,
} from "../utils";
import {prisma} from "../config/prisma-client";
import {Network} from "../models/network";
import {Alerts} from "../models/alert/alerts";
import {AccountEventTracker} from "../models/events/account-event-tracker";
import {Configuration} from "../config/config-manager";


export const createSubscription = async (account: string, chainId: number, channel: string, target: string, timestamp: number, signature: string) => {
  const network = Network.instances.get(chainId.toString())!;
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
  const currentTimestamp = Date.now();
  // timestamp should be within 5 minutes of signature timestamp
  if (Math.abs(currentTimestamp - timestamp) > (60*5*1000)) {
    throw new ApiError(httpStatus.FORBIDDEN, `Timestamp expired, signature timestamp should be within 5 minutes of sending the request`);
  }
  const message = `${channel}:${target}:${timestamp}`; // todo proper message
  const validSignature = await isValidSignature(
    account,
    ethers.utils.toUtf8Bytes(message),
    ethers.utils.arrayify(signature),
    network.jsonRPCProvider
  );
  if (!validSignature) {
    throw new ApiError(httpStatus.FORBIDDEN, `Invalid signature, make sure you correctly signed this request, learn more here ...}`); // todo add link for signature generation
  }
  target = sanitizedTarget;
  //
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
    "subject": "OTP Verification for Safe Recovery",
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

export const fetchSubscriptions = async (account: string, chainId: number, timestamp: number, signature: string) => {
  const network = Network.instances.get(chainId.toString())!;
  //
  const currentTimestamp = Date.now();
  // timestamp should be within 5 minutes of signature timestamp
  if (Math.abs(currentTimestamp - timestamp) > (60*5*1000)) {
    throw new ApiError(httpStatus.FORBIDDEN, `Timestamp expired, signature timestamp should be within 5 minutes of sending the request`);
  }
  //
  const message = `${chainId}:${timestamp}`; // todo proper message
  const validSignature = await isValidSignature(
    account,
    ethers.utils.toUtf8Bytes(message),
    ethers.utils.arrayify(signature),
    network.jsonRPCProvider
  );
  if (!validSignature) {
    throw new ApiError(httpStatus.FORBIDDEN, `Invalid signature, make sure you correctly signed this request, learn more here ...}`); // todo add link for signature generation
  }
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