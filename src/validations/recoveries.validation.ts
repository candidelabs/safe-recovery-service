import Joi from "joi";
import {ethereumAddress, hexBigInt, hexString} from "./custom.validation";
import {Network} from "../models/network";

export const create = {
  body: Joi.object().keys({
    account: Joi.custom(ethereumAddress).required(),
    newOwners: Joi.array().items(Joi.custom(ethereumAddress).required()).min(1),
    newThreshold: Joi.number().integer().min(1).max(Joi.ref('newOwners.length')).required(),
    chainId: Joi.number().integer().valid(...Network.supportedChainIds).required(),
    signer: Joi.custom(ethereumAddress).required(),
    signature: Joi.custom(hexString).required(),
  }),
};

export const sign = {
  body: Joi.object().keys({
    id: Joi.string().required(),
    signer: Joi.custom(ethereumAddress).required(),
    signature: Joi.custom(hexString).required(),
  }),
};

export const fetchByAddress = {
  query: Joi.object().keys({
    account: Joi.custom(ethereumAddress).required(),
    chainId: Joi.number().integer().valid(...Network.supportedChainIds).required(),
    nonce: Joi.custom(hexBigInt).required(),
  }),
};

export const fetchById = {
  query: Joi.object().keys({
    id: Joi.string().required(),
  }),
};

export const finalizeOrExecute = {
  body: Joi.object().keys({
    id: Joi.string().required(),
  }),
};
