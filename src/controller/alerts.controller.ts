import * as alertsService from "../services/alerts.service";
import {catchAsync} from "../utils";

interface SubscribeBody {
  account: string;
  owner: string;
  chainId: number;
  channel: string;
  target: string;
  message: string;
  signature: string;
}

interface ActivateSubscriptionBody {
  subscriptionId: string;
  challenge: string;
}

interface FetchSubscriptionsBody {
  account: string;
  owner: string;
  chainId: number;
  message: string;
  signature: string;
}

interface UnsubscribeBody {
  subscriptionId: string;
  owner: string;
  chainId: number;
  message: string | null;
  signature: string | null;
}

export const subscribe = catchAsync(async (req, res) => {
  const params = req.body as SubscribeBody;
  const subscriptionId = await alertsService.createSubscription(
    params.account,
    params.owner,
    params.chainId,
    params.channel,
    params.target,
    params.message,
    params.signature,
  );
  res.send({subscriptionId});
});

export const activate = catchAsync(async (req, res) => {
  const params = req.body as ActivateSubscriptionBody;
  await alertsService.activateSubscription(params.subscriptionId, params.challenge);
  res.send({success: true});
});

export const fetchSubscriptions = catchAsync(async (req, res) => {
  const params = req.query as unknown as FetchSubscriptionsBody;
  const subscriptions = await alertsService.fetchSubscriptions(
    params.account,
    params.owner,
    params.chainId,
    params.message,
    params.signature
  );
  res.send({subscriptions});
});

export const unsubscribe = catchAsync(async (req, res) => {
  const params = req.body as UnsubscribeBody;
  await alertsService.unsubscribe(
    params.subscriptionId,
    params.chainId,
    params.owner,
    params.message,
    params.signature
  );
  res.send({success: true});
});