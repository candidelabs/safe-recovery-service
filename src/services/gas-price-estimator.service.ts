import {BigNumber} from "ethers";
import {parseUnits} from "ethers/lib/utils";
import {scaleBigNumber, scientificToRealNumber, trimDecimalOverflow} from "../utils";
import {Network} from "../models/network";

const infuraGasAPIChains = new Set([1, 10, 56, 100, 8453, 42161, 11155111, 11155420, 84532, 421614 ]);
const polygonGasStationChains = new Set([137, 80002]);

export class GasPriceEstimator {
  private static _instance: GasPriceEstimator | null = null;

  private constructor() {
    //
  }

  public static instance(): GasPriceEstimator {
    if (!GasPriceEstimator._instance) {
      GasPriceEstimator._instance = new GasPriceEstimator();
    }
    return GasPriceEstimator._instance;
  }

  private async _fetchFromInfuraGasAPI(chainId: number): Promise<[BigNumber, BigNumber, BigNumber]> {
    const uri = `https://gas-api.metaswap.codefi.network/networks/${chainId.toString()}/suggestedGasFees`;
    const response = await fetch(uri);
    const suggestedGasFees = await response.json();
    const baseFee = parseUnits(trimDecimalOverflow(suggestedGasFees["estimatedBaseFee"], 9), "gwei");
    const maxFeePerGas = parseUnits(trimDecimalOverflow(suggestedGasFees["high"]["suggestedMaxFeePerGas"], 9), "gwei");
    const maxPriorityFeePerGas = parseUnits(trimDecimalOverflow(suggestedGasFees["high"]["suggestedMaxPriorityFeePerGas"], 9), "gwei");
    return [baseFee, maxFeePerGas, maxPriorityFeePerGas];
  }

  private async _fetchFromPolygonGasStation(testnet: boolean): Promise<[BigNumber, BigNumber, BigNumber]> {
    const uri = !testnet ? "https://gasstation.polygon.technology/v2" : "https://gasstation-testnet.polygon.technology/v2";
    const response = await fetch(uri);
    const gasFees = await response.json();
    //
    const estimatedBaseFee = trimDecimalOverflow(scientificToRealNumber(gasFees["estimatedBaseFee"]), 9);
    const estimatedMaxFee = trimDecimalOverflow(scientificToRealNumber(gasFees["fast"]["maxFee"]), 9);
    const estimatedMaxPriorityFee = trimDecimalOverflow(scientificToRealNumber(gasFees["fast"]["maxPriorityFee"]), 9);
    //
    const baseFee = parseUnits(estimatedBaseFee, "gwei");
    const maxFeePerGas = parseUnits(estimatedMaxFee, "gwei");
    const maxPriorityFeePerGas = parseUnits(estimatedMaxPriorityFee, "gwei");
    return [baseFee, maxFeePerGas, maxPriorityFeePerGas];
  }

  private async _fetchFromProviderFeeData(network: Network): Promise<[BigNumber, BigNumber, BigNumber]> {
    const feeData = await network.jsonRPCProvider.getFeeData();
    const baseFee = feeData.lastBaseFeePerGas!;
    const maxFeePerGas = feeData.maxFeePerGas!;
    const maxPriorityFeePerGas = feeData.maxPriorityFeePerGas!;
    return [baseFee, maxFeePerGas, maxPriorityFeePerGas];
  }

  private async _fetchFromProviderGasPrice(network: Network): Promise<[BigNumber, BigNumber, BigNumber]> {
    const baseFee = (await network.jsonRPCProvider.getBlock("latest")).baseFeePerGas!;
    const gasPrice = await network.jsonRPCProvider.getGasPrice();
    const maxFeePerGas = scaleBigNumber(gasPrice, 1.1);
    const maxPriorityFeePerGas = scaleBigNumber(gasPrice, 1.05);
    return [baseFee, maxFeePerGas, maxPriorityFeePerGas];
  }

  public async estimate(chainId: number, scaleFactor: number): Promise<[BigNumber, BigNumber, BigNumber]> {
    let baseFee: BigNumber;
    let maxFeePerGas: BigNumber;
    let maxPriorityFeePerGas: BigNumber;
    const network = Network.instances.get(chainId.toString())!;
    if (infuraGasAPIChains.has(chainId)){
      [baseFee, maxFeePerGas, maxPriorityFeePerGas] = await this._fetchFromInfuraGasAPI(chainId);
    }else if (polygonGasStationChains.has(chainId)){
      [baseFee, maxFeePerGas, maxPriorityFeePerGas] = await this._fetchFromPolygonGasStation(chainId === 80002);
    }else{
      [baseFee, maxFeePerGas, maxPriorityFeePerGas] = await this._fetchFromProviderFeeData(network);
    }
    baseFee = scaleBigNumber(baseFee, scaleFactor);
    maxFeePerGas = scaleBigNumber(maxFeePerGas, scaleFactor);
    maxPriorityFeePerGas = scaleBigNumber(maxPriorityFeePerGas, scaleFactor);
    return [baseFee, maxFeePerGas, maxPriorityFeePerGas];
  }

}