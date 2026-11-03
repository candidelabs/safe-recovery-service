import {ethers} from "ethers";
import {Network} from "../models/network";
import {prisma} from "../config/prisma-client";
import logger from "../utils/logger";

const log = logger.child({ component: "recovery-modules" });

// Event rows indexed before modules were tracked have no moduleAddress. They came from the module that
// is now each chain's fallback (the legacy 'recoveryModuleAddress'), which a SQL migration cannot know.
export const assignLegacyEventsToFallbackModules = async (): Promise<number> => {
  let count = 0;
  for (const network of Network.instances.instances){
    if (!network.fallbackModule) continue;
    const where = {chainId: network.chainId, moduleAddress: null};
    const data = {moduleAddress: network.fallbackModule.address};
    const results = await prisma.$transaction([
      prisma.guardianAddedEvent.updateMany({where, data}),
      prisma.guardianRevokedEvent.updateMany({where, data}),
      prisma.thresholdChangedEvent.updateMany({where, data}),
      prisma.recoveryExecutedEvent.updateMany({where, data}),
      prisma.recoveryFinalizedEvent.updateMany({where, data}),
      prisma.recoveryCanceledEvent.updateMany({where, data}),
    ]);
    count += results.reduce((sum, result) => sum + result.count, 0);
  }
  return count;
};

// Compares every module's runtime code with its pinned code hash. Only logs: boot must not depend on the RPC.
export const verifyRecoveryModuleCode = async (): Promise<void> => {
  await Promise.all(Network.instances.instances.flatMap((network) => network.modules.map(async (module) => {
    const context = { chainId: network.chainId, network: network.name, moduleAddress: module.address, module: module.label };
    let code: string;
    try {
      code = await network.jsonRPCProvider.getCode(module.address);
    } catch (error) {
      log.warn({ ...context, err: error }, "recovery module code check skipped");
      return;
    }
    if (code === "0x"){
      log.error(context, "recovery module not deployed");
      return;
    }
    const codeHash = ethers.utils.keccak256(code);
    if (codeHash !== module.codeHash){
      log.error({ ...context, codeHash, expectedCodeHash: module.codeHash }, "recovery module code hash mismatch");
    }
  })));
};
