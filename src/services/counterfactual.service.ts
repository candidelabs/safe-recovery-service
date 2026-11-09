import {Network} from "../models/network";
import logger from "../utils/logger";

const log = logger.child({ component: "counterfactual" });

// After boot: a network without Multicall3 rejects ERC-6492 signatures of undeployed accounts (deployed accounts
// keep working). Warms the per-network check and says so once; never blocks or ends the process.
export const warnIfCounterfactualUnsupported = async (): Promise<void> => {
  await Promise.all(Network.instances.instances.map(async (network) => {
    const context = { chainId: network.chainId, network: network.name, multicall3: network.multicall3 };
    try {
      if (!(await network.supportsCounterfactual())) {
        log.warn(context, "counterfactual accounts unsupported");
      }
    } catch (error) {
      log.error({ ...context, err: error }, "multicall3 check failed");
    }
  }));
};
