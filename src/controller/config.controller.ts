import {ethers} from "ethers";
import {catchAsync} from "../utils";
import {Network} from "../models/network";
import {Alerts} from "../models/alert/alerts";

interface GetNetworkConfigBody {
  chainId: number;
}

export const getNetworkConfig = catchAsync(async (req, res) => {
  const params = req.query as unknown as GetNetworkConfigBody;
  const network = Network.instances.get(params.chainId.toString())!;
  const result: Record<string, any> = {
    name: network.name,
    chainId: params.chainId,
    // the module requests use when they do not name one; absent on a chain without a fallback
    moduleAddress: network.fallbackModule ? ethers.utils.getAddress(network.fallbackModule.address) : undefined,
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