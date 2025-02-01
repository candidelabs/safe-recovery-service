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