import {Network} from "../models/network";
import {BigNumber, ethers, UnsignedTransaction} from "ethers";
import {GasPriceEstimator} from "../services/gas-price-estimator.service";
import {hexValue} from "ethers/lib/utils";

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