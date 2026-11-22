import {ethers} from "ethers";
import {catchAsync} from "../utils";
import {Network} from "../models/network";
import {Alerts} from "../models/alert/alerts";
import {Signers} from "../models/signer/signers";
import {Configuration} from "../config/config-manager";

interface GetNetworkConfigBody {
  chainId: number;
}

export const getNetworkConfig = catchAsync(async (req, res) => {
  const params = req.query as unknown as GetNetworkConfigBody;
  const network = Network.instances.get(params.chainId.toString())!;
  // the address registrations are bound to, and the guardian an undeployed account's initializer installs; a signer
  // whose address cannot be read answers 500, as register does
  const guardianAddress = network.guardian
    ? ethers.utils.getAddress(await Signers.instance().getSigner(network.guardian)!.signer())
    : undefined;
  // No RPC call here: a network known to lack Multicall3 (the settled check) refuses undeployed accounts, and a check
  // still running or failed reads as the configured switch.
  const configured = Configuration.instance().counterfactualAccounts;
  const erc6492 = configured.erc6492 && network.counterfactualSupported !== false;
  const result: Record<string, any> = {
    name: network.name,
    chainId: params.chainId,
    // absent on a network without a guardian
    guardianAddress,
    counterfactualAccounts: {
      erc6492,
      storeInitData: erc6492 && network.guardian ? configured.storeInitData : "never",
    },
    // the module requests use when they do not name one, until the Sunset date; absent on a chain without a fallback
    moduleAddress: network.fallbackModule ? ethers.utils.getAddress(network.fallbackModule.address) : undefined,
    // every module a request can name with moduleAddress (recoveryPeriod in seconds)
    modules: network.modules.map((module) => ({
      address: ethers.utils.getAddress(module.address),
      version: module.version,
      recoveryPeriod: module.recoveryPeriod,
    })),
    sponsorships: {
      execution: {
        enabled: false,
      },
      finalization: {
        enabled: false,
      }
    }
  };
  //
  const _alertChannels = Alerts.instance().getAlertChannels(network.alert ?? "");
  const alertChannels: string[] = [];
  if (_alertChannels){
    _alertChannels.forEach(channel => alertChannels.push(channel.channelName));
    result["alertChannels"] = alertChannels;
  }
  //
  if (network.executeRecoveryRequestConfig.enabled){
    result.sponsorships.execution = {
      enabled: true,
      rateLimit: network.executeRecoveryRequestConfig.rateLimit,
    }
  }
  if (network.finalizeRecoveryRequestConfig.enabled){
    result.sponsorships.finalization = {
      enabled: true,
      rateLimit: network.finalizeRecoveryRequestConfig.rateLimit,
    }
  }
  //
  res.send(result);
});