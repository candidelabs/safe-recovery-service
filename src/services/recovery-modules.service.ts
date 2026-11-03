import {ethers} from "ethers";
import {Network} from "../models/network";
import {prisma} from "../config/prisma-client";
import logger from "../utils/logger";

const log = logger.child({ component: "recovery-modules" });

// Rows indexed before modules were tracked (the IndexerData cursor and the event rows) have no
// moduleAddress, and a SQL migration cannot know which module they came from. A legacy
// 'recoveryModuleAddress' config names it, so they are assigned to that module. With 'recoveryModules'
// any assignment would be a guess (the fallback need not be the module indexed so far), and a wrong one
// mislabels events and hands one module another's cursor, so this throws instead.
export const assignLegacyRows = async (network: Network): Promise<void> => {
  const chainId = network.chainId;
  const where = {chainId, moduleAddress: null};
  const module = network.legacyModule;
  if (!module){
    const counts = await Promise.all([
      prisma.indexerData.count({where}),
      prisma.guardianAddedEvent.count({where}),
      prisma.guardianRevokedEvent.count({where}),
      prisma.thresholdChangedEvent.count({where}),
      prisma.recoveryExecutedEvent.count({where}),
      prisma.recoveryFinalizedEvent.count({where}),
      prisma.recoveryCanceledEvent.count({where}),
    ]);
    const count = counts.reduce((sum, rows) => sum + rows, 0);
    if (count > 0){
      throw new Error(
        `Network '${network.name}' has ${count} rows indexed before recovery modules were tracked, and 'recoveryModules' ` +
        `does not say which module they came from. Start once with the legacy 'recoveryModuleAddress' set to the module ` +
        `indexed so far, then switch to 'recoveryModules'.`
      );
    }
    return;
  }
  const data = {moduleAddress: module.address};
  const context = { chainId, network: network.name, moduleAddress: module.address, module: module.label };
  const cursor = await prisma.indexerData.findFirst({where});
  if (cursor){
    // A second legacy cursor would break the one-row-per-module rule; keep the module's own row.
    if (await prisma.indexerData.findFirst({where: {chainId, moduleAddress: module.address}})){
      log.warn({ ...context, latestIndexedBlock: cursor.latestIndexedBlock }, "legacy indexer cursor left unassigned");
    } else {
      await prisma.indexerData.update({data, where: {id: cursor.id}});
      log.info({ ...context, latestIndexedBlock: cursor.latestIndexedBlock }, "legacy indexer cursor assigned");
    }
  }
  const results = await Promise.all([
    prisma.guardianAddedEvent.updateMany({where, data}),
    prisma.guardianRevokedEvent.updateMany({where, data}),
    prisma.thresholdChangedEvent.updateMany({where, data}),
    prisma.recoveryExecutedEvent.updateMany({where, data}),
    prisma.recoveryFinalizedEvent.updateMany({where, data}),
    prisma.recoveryCanceledEvent.updateMany({where, data}),
  ]);
  const count = results.reduce((sum, result) => sum + result.count, 0);
  if (count > 0){
    log.info({ ...context, count }, "legacy indexed events assigned");
  }
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
