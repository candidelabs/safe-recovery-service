import {ethers} from "ethers";
import httpStatus from "http-status";
import {Network} from "../models/network";
import {RecoveryModule} from "../models/recovery-module";
import {prisma} from "../config/prisma-client";
import {ApiError} from "../utils/error";
import {getSafeInstance} from "../utils/contract-source";
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

// Recovery and custodial-signature requests made before requests named their module have no
// moduleAddress. They were made on the module of a legacy 'recoveryModuleAddress' config, so they are
// assigned to it; under 'recoveryModules' that module cannot be known (the fallback may have changed),
// so this throws instead, as assignLegacyRows does. Runs at every boot, whether or not the indexer is
// paused, because the request endpoints need it.
export const assignLegacyRequestRows = async (network: Network): Promise<void> => {
  const chainId = network.chainId;
  const where = {chainId, moduleAddress: null};
  const module = network.legacyModule;
  if (!module){
    const counts = await Promise.all([
      prisma.recoveryRequest.count({where}),
      prisma.authSignatureRequest.count({where}),
    ]);
    const count = counts.reduce((sum, rows) => sum + rows, 0);
    if (count > 0){
      throw new Error(
        `Network '${network.name}' has ${count} recovery or signature requests made before requests named their module, ` +
        `and 'recoveryModules' does not say which module they were made on. Start once with the legacy ` +
        `'recoveryModuleAddress' set to the module requests have used so far, then switch to 'recoveryModules'.`
      );
    }
    return;
  }
  const data = {moduleAddress: module.address};
  const results = await Promise.all([
    prisma.recoveryRequest.updateMany({where, data}),
    prisma.authSignatureRequest.updateMany({where, data}),
  ]);
  const count = results.reduce((sum, result) => sum + result.count, 0);
  if (count > 0){
    log.info({ chainId, network: network.name, moduleAddress: module.address, module: module.label, count }, "legacy requests assigned");
  }
};

// Checks shared by the endpoints that start a flow (recoveries/create, auth/signature/request), whether
// the module came from the request or the fallback: the module must be enabled on the Safe and hold its
// guardians (a disabled module keeps its stored guardians), and the proposed owners must pass the
// contract's _validateNewOwners, which v0.2.0 runs at confirmation and v0.1.0 at finalization. Zero,
// sentinel and duplicate owners are rejected by the Joi schemas. Returns the module's guardians (lower case).
export const checkRecoveryModule = async (
  network: Network,
  module: RecoveryModule,
  account: string,
  newOwners: string[],
): Promise<string[]> => {
  const _account = account.toLowerCase();
  const _newOwners = newOwners.map((owner) => owner.toLowerCase());
  if (_newOwners.includes(_account)){
    throw new ApiError(httpStatus.BAD_REQUEST, `The account cannot be one of its own new owners`);
  }
  let enabled: boolean;
  try {
    enabled = await getSafeInstance(account, network.jsonRPCProvider).isModuleEnabled(module.address);
  } catch (e) {
    throw new ApiError(httpStatus.BAD_REQUEST, `Account address is not a safe smart contract account`);
  }
  const moduleName = `${module.label} recovery module ${ethers.utils.getAddress(module.address)}`;
  if (!enabled){
    throw new ApiError(
      httpStatus.BAD_REQUEST,
      `The ${moduleName} is not enabled on this account; pass moduleAddress to use the module that holds its guardians`
    );
  }
  const guardians = ((await module.contract.getGuardians(account)) as string[]).map((guardian) => guardian.toLowerCase());
  if (guardians.length === 0){
    throw new ApiError(
      httpStatus.BAD_REQUEST,
      `This account has no guardians on the ${moduleName}; pass moduleAddress to use the module that holds its guardians`
    );
  }
  const guardianOwner = _newOwners.find((owner) => guardians.includes(owner));
  if (guardianOwner){
    throw new ApiError(httpStatus.BAD_REQUEST, `New owner ${guardianOwner} is a guardian of this account; a guardian cannot be an owner`);
  }
  return guardians;
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
