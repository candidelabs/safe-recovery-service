import Joi from "joi";
import {SiweMessage} from "siwe";

export const ethereumAddress: Joi.CustomValidator = (value, helpers) => {
  if (!value.match(/^0x[a-fA-F0-9]{40}$/)) {
    return helpers.message({
      custom: "{{#label}} must be a valid ethereum address",
    });
  }
  return value;
};

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const SENTINEL_ADDRESS = "0x0000000000000000000000000000000000000001"; // head of a Safe's owners list

// The owners a recovery proposes, checked as the module's _validateNewOwners does: at least one, no zero
// or sentinel address, no duplicates. The checks that need the chain (not the Safe itself, not one of its
// guardians) are made by the service.
const newOwner: Joi.CustomValidator = (value, helpers) => {
  const address = String(value).toLowerCase();
  if (address === ZERO_ADDRESS || address === SENTINEL_ADDRESS) {
    return helpers.message({
      custom: "{{#label}} cannot be the zero address or the sentinel address " + SENTINEL_ADDRESS,
    });
  }
  return value;
};

export const newOwners = Joi.array()
  .items(Joi.custom(ethereumAddress).custom(newOwner).required())
  .min(1)
  .unique((a: string, b: string) => a.toLowerCase() === b.toLowerCase());

export const hexString: Joi.CustomValidator = (value, helpers) => {
  if (!value.match(/^0x[a-fA-F0-9]*$/)) {
    return helpers.message({
      custom: "{{#label}} must be a valid hexadecimal string",
    });
  }
  return value;
};

export const ethereumPrivateKey: Joi.CustomValidator = (value, helpers) => {
  if (
    !value.match(/^0x[a-fA-F0-9]{64}$/)
    || "0x"+(value as string).replace("0x", "") == "0x0000000000000000000000000000000000000000000000000000000000000000"
  ) {
    return helpers.message({
      custom: "{{#label}} must be a valid ethereum private key",
    });
  }
  return value;
};

export const hexBigInt: Joi.CustomValidator = (value, helpers) => {
  if (!/^0x[0-9a-fA-F]+$/.test(value)) {
    return helpers.message({
      custom: "{{#label}} must be a valid hexadecimal number",
    });
  }
  return value;
}

export const siweMessage: Joi.CustomValidator = (value, helpers) => {
  try {
    new SiweMessage(value);
  } catch (e) {
    // not logged: a malformed SIWE message is the client's problem and the text may carry the message itself
    return helpers.message({
      custom: `{{#label}} must be a valid SIWE (EIP-4361) message: ${e}`,
    });
  }
  return value;
};