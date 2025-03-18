import {Network} from "../models/network";
import {BigNumber, ethers, UnsignedTransaction} from "ethers";
import {GasPriceEstimator} from "../services/gas-price-estimator.service";
import {hexValue} from "ethers/lib/utils";
import {SiweErrorType, SiweMessage} from "siwe";
import {ApiError} from "./error";
import httpStatus from "http-status";

export const delay = (ms: number) => new Promise(res => setTimeout(res, ms));
export const e164Regex = /^\+?[1-9]\d{1,14}$/;

const bigIntHandler = (key: string, value: any) => (typeof value === 'bigint' ? value.toString(16)._0x() : value);
export function JsonBigIntParser(object: Record<string, any> | Record<string, any>[]): Record<string, any> | Record<string, any>[]{
  if (Array.isArray(object)) {
    const jsonObjects: Record<string, any> | Record<string, any>[] = [];
    for (const _object of object) {
      jsonObjects.push(JsonBigIntParser(_object));
    }
    return jsonObjects;
  }else{
    return JSON.parse(JSON.stringify(object, bigIntHandler));
  }
}

export async function populateTxGasPricesAndLimits(network: Network, sender: string, to: string, value: bigint, callData: string){
  const nonce = await network.jsonRPCProvider.getTransactionCount(sender, "pending");
  const tx: UnsignedTransaction = {
    type: 2,
    to,
    data: callData,
    chainId: network.chainId,
    nonce,
    gasLimit: "0x0",
    value: hexValue(value)
  }
  //
  const gasLimit = await network.jsonRPCProvider.estimateGas({to: tx.to, data: tx.data, value: value});
  tx.gasLimit = hexValue(scaleBigNumber(gasLimit, 1.25));
  const [baseFee, maxFeePerGas, maxPriorityFeePerGas] = await GasPriceEstimator.instance().estimate(network.chainId, 1.50);
  tx.maxFeePerGas = hexValue(maxFeePerGas);
  tx.maxPriorityFeePerGas = hexValue(maxPriorityFeePerGas);
  return tx;
}

export function scaleBigNumber(value: BigNumber, scale: number) {
  const oneBN: BigNumber = ethers.utils.parseUnits("1", 18);
  const bnForSure = BigNumber.from(value);
  const numberBN = ethers.utils.parseUnits(scale.toString(), 18);

  return bnForSure.mul(numberBN).div(oneBN);
}

export function trimDecimalOverflow(n: string, decimals: number){
  n+=""
  if(n.indexOf(".") === -1) return n
  const arr = n.split(".");
  const fraction = arr[1] .substr(0, decimals);
  return arr[0] + "." + fraction;
}


export function scientificToRealNumber(input: string): string {
  const scientificRegex = /^[+\-]?\d+(\.\d*)?[eE][+\-]?\d+$/;
  const isScientificNotation = scientificRegex.test(input);

  if (isScientificNotation) {
    const realNumber = Number(input);
    return realNumber.toFixed(18);
  } else {
    return input;
  }
}

export function periodToSeconds(period: string): number {
  const match = period.match(/^(\d+)(ms|[smhd])$/);
  if (!match) {
    throw new Error("Invalid period format. Expected format like '1h', '5m', '24h', '500ms', etc...");
  }
  const value = parseInt(match[1], 10);
  const unit = match[2];
  switch (unit) {
    case 'ms':
      return value / 1000;
    case 's':
      return value;
    case 'm':
      return value * 60;
    case 'h':
      return value * 60 * 60;
    case 'd':
      return value * 60 * 60 * 24;
    default:
      throw new Error("Unsupported unit. Supported units are 'ms', 's', 'm', 'h', 'd'.");
  }
}

export function parseSeconds(seconds: number): string {
  const units = [
    { unit: 'year', seconds: 365 * 24 * 60 * 60 },
    { unit: 'month', seconds: 30 * 24 * 60 * 60 },
    { unit: 'week', seconds: 7 * 24 * 60 * 60 },
    { unit: 'day', seconds: 24 * 60 * 60 },
    { unit: 'hour', seconds: 60 * 60 },
    { unit: 'minute', seconds: 60 },
    { unit: 'second', seconds: 1 }
  ];

  let remainingSeconds = seconds;
  const parts: string[] = [];

  for (const { unit, seconds: unitSeconds } of units) {
    const count = Math.floor(remainingSeconds / unitSeconds);
    if (count > 0) {
      parts.push(`${count} ${unit}${count > 1 ? 's' : ''}`);
      remainingSeconds %= unitSeconds;
    }
  }

  return parts.join(', ') || '0 seconds';
}

export function escapeHtml(text: string) {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
};

export function toNormalCase(input: string): string {
  // First, handle different separators and convert to array of words
  let words = input
    // Replace kebab-case (-) with spaces
    .replace(/-/g, ' ')
    // Replace snake_case (_) with spaces
    .replace(/_/g, ' ')
    // Split camelCase by detecting uppercase letters
    .replace(/([A-Z])/g, ' $1')
    // Split on spaces and filter out empty strings
    .split(/\s+/)
    .filter(word => word.length > 0);

  // Capitalize first letter of each word and join with spaces
  return words
    .map(word =>
      word.charAt(0).toUpperCase() +
      word.slice(1).toLowerCase()
    )
    .join(' ');
}

const nonceTracker: Set<string> = new Set();
export function verifySiweMessageData(message: SiweMessage, account: string, chainId: number, statement: string): [boolean, string] {
  const messageAccount = message.address.toLowerCase();
  if (message.version !== "1"){
    return [false, `this service only accepts messages (siwe) that are formatted in version '1'`];
  }
  if (messageAccount !== account.toLowerCase()){
    return [false, `invalid account address in signed message (expected: ${account}, actual ${messageAccount})`];
  }
  if (message.statement !== statement){
    return [false, `invalid message statement in signed message (expected: ${statement}, actual ${message.statement})`];
  }
  if (!message.chainId){
    return [false, `chainId in signed message MUST be specified`];
  }
  if (message.chainId !== chainId){
    return [false, `invalid chainId in signed message (expected: ${chainId}, actual ${message.chainId})`];
  }
  const messageIdentifier = ethers.utils.defaultAbiCoder.encode(
    ["address", "uint256", "string", "string"],
    [messageAccount, message.chainId, message.statement, message.nonce]
  );
  if (nonceTracker.has(messageIdentifier)){
    return [false, `nonce has been already used in a previous request, please use a random nonce`];
  }
  if (!message.issuedAt){
    return [false, `issuedAt in signed message MUST be specified`];
  }
  const messageTimestamp = Date.parse(message.issuedAt);
  if (Number.isNaN(messageTimestamp)){
    return [false, `issuedAt could not be parsed in signed message, please make sure it is correctly formatted`];
  }
  const currentTimestamp = Date.now();
  if (message.notBefore){
    const notBeforeTimestamp = Date.parse(message.notBefore);
    if (Number.isNaN(notBeforeTimestamp)){
      return [false, `notBefore could not be parsed in signed message, please make sure it is correctly formatted`];
    }
    if (notBeforeTimestamp > currentTimestamp) {
      return [false, `notBeforeTimestamp has not yet passed, this signature cannot be used until then`];
    }
  }
  if (message.expirationTime){
    const expirationTimestamp = Date.parse(message.expirationTime);
    if (Number.isNaN(expirationTimestamp)){
      return [false, `expirationTime could not be parsed in signed message, please make sure it is correctly formatted`];
    }
    if (expirationTimestamp < currentTimestamp) {
      return [false, `expirationTimestamp has passed and signature has expired`];
    }
  }else{
    if ((currentTimestamp - messageTimestamp) > (60*5*1000)) {
      return [false, `issuedAt is valid only for 5 minutes and signature is already expired`];
    }
  }
  nonceTracker.add(messageIdentifier);
  return [true, ""];
}

export async function validateSIWEMessage(message: string, account: string, chainId: number, statement: string, signature: string) {
  const network = Network.instances.get(chainId.toString())!;
  const siweMessage = new SiweMessage(message);
  const [success, errorMessage] = verifySiweMessageData(siweMessage, account, chainId, statement);
  if (!success){
    throw new ApiError(httpStatus.BAD_REQUEST, `SIWE Message: ${errorMessage}`);
  }
  const validSignature = await siweMessage.verify({signature}, {provider: network.jsonRPCProvider, suppressExceptions: true});
  if (!validSignature.success) {
    throw new ApiError(httpStatus.FORBIDDEN, `SIWE Message: invalid signature, make sure you correctly signed this request, learn more here ...`); // todo add link for signature generation
  }
  return true;
}

