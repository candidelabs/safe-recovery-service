import Joi from "joi";
import {ethereumAddress, hexString, siweMessage} from "./custom.validation";
import {Network} from "../models/network";

export const subscribe = {
  body: Joi.object().keys({
    account: Joi.custom(ethereumAddress).required(),
    owner: Joi.custom(ethereumAddress).required(),
    chainId: Joi.number().integer().valid(...Network.supportedChainIds).required(),
    channel: Joi.string().valid(...["email", "sms"]).required(),
    target: Joi.string().required(),
    message: Joi.custom(siweMessage).required(),
    signature: Joi.custom(hexString).required(),
  }),
};

export const activate = {
  body: Joi.object().keys({
    subscriptionId: Joi.string().required(),
    challenge: Joi.string().required(),
  }),
};

export const subscriptions = {
  query: Joi.object().keys({
    account: Joi.custom(ethereumAddress).required(),
    owner: Joi.custom(ethereumAddress).required(),
    chainId: Joi.number().integer().valid(...Network.supportedChainIds).required(),
    message: Joi.custom(siweMessage).required(),
    signature: Joi.custom(hexString).required(),
  }),
};

export const unsubscribe = {
  body: Joi.object().keys({
    subscriptionId: Joi.string().required(),
    owner: Joi.custom(ethereumAddress).required(),
    chainId: Joi.number().integer().valid(...Network.supportedChainIds).required(),
    message: Joi.custom(siweMessage),
    signature: Joi.custom(hexString),
  }),
};