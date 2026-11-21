import Joi from "joi";
import {accountMetadata, ethereumAddress, hexString, newOwners, siweMessage, verifiedTargetToken} from "./custom.validation";
import {Network} from "../models/network";

const channels = ["email", "sms"];

export const register = {
  body: Joi.object().keys({
    account: Joi.custom(ethereumAddress).required(),
    chainId: Joi.number().integer().valid(...Network.supportedChainIds).required(),
    channel: Joi.string().valid(...channels).required(),
    target: Joi.string().required(),
    message: Joi.custom(siweMessage).required(),
    signature: Joi.custom(hexString).required(),
    // from POST /v1/auth/verification/submit: the registration is created at once, with no second code
    verifiedTargetToken: Joi.custom(verifiedTargetToken),
    // the account's metadata on this chain, replaced whole ({} removes it); left out, the stored one is kept
    metadata: Joi.custom(accountMetadata),
  }),
};

export const submit = {
  body: Joi.object().keys({
    challengeId: Joi.string().required(),
    challenge: Joi.string().required(),
  }),
};

export const registrations = {
  query: Joi.object().keys({
    account: Joi.custom(ethereumAddress).required(),
    chainId: Joi.number().integer().valid(...Network.supportedChainIds).required(),
    message: Joi.custom(siweMessage).required(),
    signature: Joi.custom(hexString).required(),
  }),
};

export const requestVerification = {
  body: Joi.object().keys({
    channel: Joi.string().valid(...channels).required(),
    target: Joi.string().required(),
  }),
};

export const submitVerification = {
  body: Joi.object().keys({
    challengeId: Joi.string().required(),
    challenge: Joi.string().required(),
  }),
};

export const accounts = {
  body: Joi.object().keys({
    verifiedTargetToken: Joi.custom(verifiedTargetToken).required(),
  }),
};

export const deleteRegistration = {
  body: Joi.object().keys({
    registrationId: Joi.string().required(),
    message: Joi.custom(siweMessage).required(),
    signature: Joi.custom(hexString).required(),
  }),
};

// moduleAddress: see recoveries.validation.ts; signature/submit signs for the module saved on the request.
export const requestSignature = {
  body: Joi.object().keys({
    account: Joi.custom(ethereumAddress).required(),
    newOwners: newOwners,
    newThreshold: Joi.number().integer().min(1).max(Joi.ref('newOwners.length')).required(),
    chainId: Joi.number().integer().valid(...Network.supportedChainIds).required(),
    moduleAddress: Joi.custom(ethereumAddress),
  }),
};

export const submitSignatureRequestChallenge = {
  body: Joi.object().keys({
    requestId: Joi.string().required(),
    challengeId: Joi.string().required(),
    challenge: Joi.string().required(),
  }),
};