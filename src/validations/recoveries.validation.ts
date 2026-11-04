import Joi from "joi";
import {ethereumAddress, hexBigInt, hexString, newOwners} from "./custom.validation";
import {Network} from "../models/network";

// moduleAddress names the recovery module a flow runs on; when omitted, the chain's fallback module is
// used until the Sunset date. Later steps (sign, execute, finalize) use the module saved on the request.
export const create = {
  body: Joi.object().keys({
    account: Joi.custom(ethereumAddress).required(),
    newOwners: newOwners,
    newThreshold: Joi.number().integer().min(1).max(Joi.ref('newOwners.length')).required(),
    chainId: Joi.number().integer().valid(...Network.supportedChainIds).required(),
    moduleAddress: Joi.custom(ethereumAddress),
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
    moduleAddress: Joi.custom(ethereumAddress),
    nonce: Joi.custom(hexBigInt).required(),
  }),
};

export const listByAddress = {
  query: Joi.object().keys({
    account: Joi.custom(ethereumAddress).required(),
    chainId: Joi.number().integer().valid(...Network.supportedChainIds).required(),
    moduleAddress: Joi.custom(ethereumAddress),
    // nonce comparison operators
    nonce: Joi.custom(hexBigInt),
    nonce__lt: Joi.custom(hexBigInt),
    nonce__gt: Joi.custom(hexBigInt),
    nonce__lte: Joi.custom(hexBigInt),
    nonce__gte: Joi.custom(hexBigInt),
    // createdAt comparison operators (ISO date strings)
    createdAt: Joi.date().iso(),
    createdAt__lt: Joi.date().iso(),
    createdAt__gt: Joi.date().iso(),
    createdAt__lte: Joi.date().iso(),
    createdAt__gte: Joi.date().iso(),
    // equality filters
    status: Joi.string().valid("PENDING", "EXECUTED", "FINALIZED", "EXECUTION-IN-PROGRESS", "FINALIZATION-IN-PROGRESS"),
    executed: Joi.boolean(),
    finalized: Joi.boolean(),
    // ordering
    orderBy: Joi.string().valid("createdAt", "nonce"),
    order: Joi.string().valid("asc", "desc").default("desc"),
    // pagination
    limit: Joi.number().integer().min(1).max(50).default(20),
    offset: Joi.number().integer().min(0).default(0),
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
