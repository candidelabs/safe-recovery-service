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
    console.log(e);
    return helpers.message({
      custom: `{{#label}} must be a valid SIWE (EIP-4361) message: ${e}`,
    });
  }
  return value;
};