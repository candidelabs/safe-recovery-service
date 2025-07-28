import Joi from "joi";
import {Network} from "../models/network";

export const getNetworkConfig = {
  query: Joi.object().keys({
    chainId: Joi.number().integer().valid(...Network.supportedChainIds).required(),
  }),
};