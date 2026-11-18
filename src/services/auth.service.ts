import httpStatus from "http-status";
import {BigNumber} from "ethers";
import {Prisma} from "@prisma/client";
import {ApiError, validateSIWEMessage,} from "../utils";
import {prisma} from "../config/prisma-client";
import {ModuleSelection, Network} from "../models/network";
import {Alerts} from "../models/alert/alerts";
import {Signers} from "../models/signer/signers";
import {MessageStatements} from "../utils/constants";
import {
  ACCOUNT_LOOKUP_VALIDITY_MS,
  LookupAccount,
  LookupRejection,
  lookupAccounts,
  lookupChallengeSeed,
  lookupLockKey,
  lookupSubmitRejection,
  selectLookupChannel,
  targetLocked,
  targetWindowStart,
  withinCooldown,
} from "../utils/account-lookup";
import {checkRecoveryModule} from "./recovery-modules.service";
import logger from "../utils/logger";

const log = logger.child({ component: "auth" });

export const createRegistration = async (account: string, chainId: number, channel: string, target: string, message: string, signature: string) => {
  const network = Network.instances.get(chainId.toString())!;
  if (!network.guardian){
    throw new ApiError(httpStatus.BAD_REQUEST, `Recovery Guardian is not enabled on this network`);
  }
  const alertChannel = Alerts.instance().getAlertChannel(network.alert ?? "", channel);
  if (!alertChannel){
    throw new ApiError(httpStatus.BAD_REQUEST, `Target channel '${channel}' is not supported on this network`);
  }
  //
  const sanitizedTarget = await alertChannel.sanitizeTarget(target);
  if (!sanitizedTarget) {
    throw new ApiError(httpStatus.FORBIDDEN, `Target is not compatible with the '${channel}' channel`);
  }
  //
  let statement = MessageStatements["auth-register"];
  statement = statement.replace("{{target}}", target);
  statement = statement.replace("{{channel}}", channel);
  // the account signs; an ERC-6492-wrapped signature of an account that is not deployed yet is verified in simulation
  const {counterfactual} = await validateSIWEMessage(message, account, chainId, statement, signature);
  //
  target = sanitizedTarget;
  const existingRegistration = await prisma.authRegistration.findFirst({
    where: {
      account: {equals: account.toLowerCase()},
      chainId: {equals: chainId},
      channel: {equals: channel},
      target: {equals: target.toLowerCase()},
    }
  });
  if (existingRegistration){
    throw new ApiError(httpStatus.CONFLICT, `An active registration already exists for ${account} on chainId ${chainId} on the '${channel}' channel`);
  }
  //
  const [challenge, challengeHash] = await alertChannel.generateChallenge(account.toLowerCase());
  await alertChannel.sendMessage("otpVerification", target, {
    "subject": "OTP Verification for Safe Recovery",
    "otp": challenge
  });
  //
  let authRegistrationRequest = await prisma.authRegistrationRequest.create(
    {
      data: {
        account: account.toLowerCase(),
        chainId,
        channel,
        target,
        challengeHash,
        verified: false,
        tries: 0,
        expiresAt: new Date(Date.now() + 10*60*1000)
      }
    }
  );
  // the target (email / phone number) and the OTP are never logged
  log.info(
    { challengeId: authRegistrationRequest.id, account: account.toLowerCase(), chainId, channel, accountDeployed: !counterfactual },
    "auth registration requested"
  );
  return authRegistrationRequest.id;
};

export const submitRegistrationChallenge = async (challengeId: string, challenge: string) => {
  const registrationRequest = await prisma.authRegistrationRequest.findFirst({where: {id: {equals: challengeId}}});
  if (!registrationRequest){
    throw new ApiError(httpStatus.NOT_FOUND, `challengeId not found`);
  }
  //
  const network = Network.instances.get(registrationRequest.chainId.toString())!;
  if (!network.guardian){
    throw new ApiError(httpStatus.BAD_REQUEST, `Recovery Guardian is not enabled on this network`);
  }
  const alertChannel = Alerts.instance().getAlertChannel(network.alert ?? "", registrationRequest.channel);
  if (!alertChannel){
    throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, `Channel '${registrationRequest.channel}' no longer exists, please contact support`);
  }
  //
  const currentDate = new Date(Date.now());
  if (registrationRequest.expiresAt < currentDate){
    throw new ApiError(httpStatus.FORBIDDEN, `challengeId has been expired`);
  }
  //
  const validChallenge = await alertChannel.verifyChallenge(
    challenge,
    registrationRequest.challengeHash,
    registrationRequest.account.toLowerCase()
  );
  if (!validChallenge){
    await prisma.authRegistrationRequest.update({
      data: {tries: {increment: 1}},
      where: {id: registrationRequest.id}
    });
    throw new ApiError(httpStatus.FORBIDDEN, `Invalid challenge`);
  }
  //
  await prisma.authRegistrationRequest.update({
    data: {verified: true, verifiedAt: currentDate},
    where: {id: registrationRequest.id}
  });
  //
  const signer = Signers.instance().getSigner(network.guardian)!
  const guardian = await signer.signer();
  const registration = await prisma.authRegistration.create(
    {
      data: {
        account: registrationRequest.account.toLowerCase(),
        chainId: registrationRequest.chainId,
        channel: registrationRequest.channel,
        target: registrationRequest.target,
        guardian
      }
    }
  );
  //
  return [registration.id, guardian];
};

export const fetchRegistrations = async (account: string, chainId: number, message: string, signature: string) => {
  //
  let statement = MessageStatements["auth-fetch"];
  await validateSIWEMessage(message, account, chainId, statement, signature);
  //
  const registrations = await prisma.authRegistration.findMany({
    where: {
      account: {equals: account.toLowerCase()},
      chainId: {equals: chainId},
    },
    select: {
      id: true,
      channel: true,
      target: true
    }
  });
  return registrations;
};

export const deleteRegistration = async (registrationId: string, message: string, signature: string) => {
  const authRegistration = await prisma.authRegistration.findFirst({where: {id: {equals: registrationId},}});
  if (!authRegistration){
    throw new ApiError(httpStatus.NOT_FOUND, `Could not find registration with this id`);
  }
  //
  let statement = MessageStatements["auth-delete"];
  statement = statement.replace("{{id}}", authRegistration.id);
  await validateSIWEMessage(message, authRegistration.account, authRegistration.chainId, statement, signature);
  //
  await prisma.authRegistration.delete({
    where: {id: registrationId}
  });
  return true;
};

// Account lookup by a verified email address or phone number (accounts/request, accounts/submit); the rules are in
// src/utils/account-lookup.ts. Neither the target, the code nor the accounts found are logged.

// The enabled networks, in config order.
const enabledNetworks = () => Network.supportedChainIds.map((chainId) => Network.instances.get(chainId.toString())!);

// Serializes the requests and submits of one channel and target until the transaction ends.
const lockLookupTarget = (tx: Prisma.TransactionClient, channel: string, target: string) =>
  tx.$executeRaw`SELECT pg_advisory_xact_lock(${lookupLockKey(channel, target).toString()}::bigint)`;

// Wrong codes for a channel and target within the window, across its challenges.
const lookupTargetFailures = async (tx: Prisma.TransactionClient, channel: string, target: string, now: Date) => {
  const {_sum} = await tx.authAccountLookupRequest.aggregate({
    _sum: {tries: true},
    where: {channel, target, createdAt: {gte: targetWindowStart(now)}},
  });
  return _sum.tries ?? 0;
};

export const requestAccountLookup = async (channel: string, target: string) => {
  const selected = selectLookupChannel(
    channel,
    enabledNetworks(),
    (alertId, channelName) => Alerts.instance().getAlertChannel(alertId, channelName),
  );
  if (!selected){
    throw new ApiError(httpStatus.BAD_REQUEST, `Target channel '${channel}' is not supported`);
  }
  const {alertId, alertChannel} = selected;
  const sanitizedTarget = await alertChannel.sanitizeTarget(target);
  if (!sanitizedTarget) {
    throw new ApiError(httpStatus.FORBIDDEN, `Target is not compatible with the '${channel}' channel`);
  }
  target = sanitizedTarget;
  // The answer does not tell whether the target has registrations: a challenge is always made (or, within the
  // cooldown, the latest one returned) and the code is only sent when there is something to list.
  const now = new Date();
  const lookup = await prisma.$transaction(async (tx) => {
    await lockLookupTarget(tx, channel, target);
    const latest = await tx.authAccountLookupRequest.findFirst({
      where: {channel, target},
      orderBy: {createdAt: "desc"},
      select: {id: true, createdAt: true},
    });
    if (latest && withinCooldown(latest.createdAt, now)) {
      return {challengeId: latest.id, reused: true, code: undefined};
    }
    const registrations = await tx.authRegistration.count({
      where: {channel, target, chainId: {in: Network.supportedChainIds}},
    });
    const failures = await lookupTargetFailures(tx, channel, target, now);
    const [challenge, challengeHash] = await alertChannel.generateChallenge(lookupChallengeSeed(channel, target));
    const lookupRequest = await tx.authAccountLookupRequest.create({
      data: {
        channel,
        target,
        alertId,
        challengeHash,
        verified: false,
        tries: 0,
        expiresAt: new Date(now.getTime() + ACCOUNT_LOOKUP_VALIDITY_MS),
      }
    });
    const code = registrations > 0 && !targetLocked(failures) ? challenge : undefined;
    return {challengeId: lookupRequest.id, reused: false, code};
  });
  const code = lookup.code;
  if (code) {
    // not awaited, and only once the response is written, so sending does not change its timing
    setImmediate(() => {
      void alertChannel.sendMessage("accountLookupOtp", target, {
        "subject": "Your Safe account lookup code",
        "otp": code,
      });
    });
  }
  log.info({ challengeId: lookup.challengeId, channel, reused: lookup.reused }, "account lookup requested");
  return lookup.challengeId;
};

export const submitAccountLookup = async (challengeId: string, challenge: string): Promise<LookupAccount[]> => {
  const lookupRequest = await prisma.authAccountLookupRequest.findFirst({
    where: {id: {equals: challengeId}},
    select: {channel: true, target: true},
  });
  if (!lookupRequest){
    throw new ApiError(httpStatus.NOT_FOUND, `challengeId not found`);
  }
  const {channel, target} = lookupRequest;
  const now = new Date();
  // Under the target's lock, so parallel submits cannot use more tries than allowed. Refusals are returned rather
  // than thrown: throwing would roll back the try just counted.
  const rejection = await prisma.$transaction(async (tx): Promise<LookupRejection | undefined> => {
    await lockLookupTarget(tx, channel, target);
    const current = await tx.authAccountLookupRequest.findUnique({where: {id: challengeId}});
    if (!current) {
      return {status: httpStatus.NOT_FOUND, message: `challengeId not found`};
    }
    const refused = lookupSubmitRejection(current, now, await lookupTargetFailures(tx, channel, target, now));
    if (refused) {
      return refused;
    }
    const alertChannel = Alerts.instance().getAlertChannel(current.alertId, channel);
    if (!alertChannel) {
      return {status: httpStatus.INTERNAL_SERVER_ERROR, message: `Channel '${channel}' no longer exists, please contact support`};
    }
    const validChallenge = await alertChannel.verifyChallenge(challenge, current.challengeHash, lookupChallengeSeed(channel, target));
    if (!validChallenge) {
      await tx.authAccountLookupRequest.update({
        data: {tries: {increment: 1}},
        where: {id: current.id}
      });
      return {status: httpStatus.FORBIDDEN, message: `Invalid challenge`};
    }
    await tx.authAccountLookupRequest.update({
      data: {verified: true, verifiedAt: now},
      where: {id: current.id}
    });
    return undefined;
  });
  if (rejection) {
    log.info({ challengeId, channel, statusCode: rejection.status }, "account lookup refused");
    throw new ApiError(rejection.status, rejection.message);
  }
  // Registrations as stored: no on-chain check (the guardian may have been removed since).
  const registrations = await prisma.authRegistration.findMany({
    where: {channel, target, chainId: {in: Network.supportedChainIds}},
    select: {account: true, chainId: true},
  });
  const accounts = lookupAccounts(registrations, Network.supportedChainIds);
  log.info({ challengeId, channel, accountCount: accounts.length }, "account lookup verified");
  return accounts;
};

export const requestSignature = async (
  account: string,
  newOwners: string[],
  newThreshold: number,
  chainId: number,
  {module: recoveryModule}: ModuleSelection,
) => {
  const network = Network.instances.get(chainId.toString())!;
  if (!network.guardian){
    throw new ApiError(httpStatus.BAD_REQUEST, `Recovery Guardian is not enabled on this network`);
  }
  const signer = Signers.instance().getSigner(network.guardian)!;
  const guardianAddress = (await signer.signer()).toLowerCase();
  account = account.toLowerCase();
  newOwners = newOwners.map((e) => e.toLowerCase());
  //
  const accountRegistrations = await prisma.authRegistration.findMany({
    where: {
      account: {equals: account},
      chainId
    }
  });
  if (accountRegistrations.length == 0){
    throw new ApiError(httpStatus.BAD_REQUEST, `No registrations found for this account on this chainId`);
  }
  const guardians = await checkRecoveryModule(network, recoveryModule, account, newOwners);
  if (!guardians.includes(guardianAddress)){
    throw new ApiError(httpStatus.BAD_REQUEST, `This account has not set '${guardianAddress}' as a guardian`);
  }
  const recoveryNonce: BigNumber = await recoveryModule.contract.nonce(account);
  //
  const requiredVerifications = Math.floor(accountRegistrations.length/2)+1;
  const authSignatureRequest = await prisma.authSignatureRequest.create({
    data: {
      account,
      newOwners,
      newThreshold,
      chainId,
      nonce: recoveryNonce.toBigInt(),
      requiredVerifications,
      moduleAddress: recoveryModule.address,
    }
  });
  const auths: {challengeId: string, channel: string, target: string}[] = [];
  let deleteRequest: [boolean, string] = [false, ""];
  for (const registration of accountRegistrations){
    const alertChannel = Alerts.instance().getAlertChannel(network.alert ?? "", registration.channel);
    if (!alertChannel){
      deleteRequest = [true, `Channel '${registration.channel}' is no longer supported on this network, please contact support`];
      break;
    }
    const [challenge, challengeHash] = await alertChannel.generateChallenge(account);
    const signatureRequestVerification = await prisma.signatureRequestVerification.create({
      data: {
        channel: registration.channel,
        target: registration.target,
        challengeHash,
        verified: false,
        tries: 0,
        expiresAt: new Date(Date.now() + 10*60*1000),
        authSignatureRequestId: authSignatureRequest.id,
      }
    });
    alertChannel.sendMessage("otpVerification", registration.target, {
      "subject": "OTP Verification for Safe Recovery",
      "otp": challenge
    });
    auths.push({
      challengeId: signatureRequestVerification.id,
      channel: registration.channel,
      target: await alertChannel.maskTarget(registration.target),
    })
  }
  if (deleteRequest[0]){
    throw new ApiError(httpStatus.BAD_REQUEST, deleteRequest[1]);
  }
  return {
    requestId: authSignatureRequest.id,
    requiredVerifications,
    auths,
  };
};

export const submitSignatureRequestChallenge = async (requestId: string, challengeId: string, challenge: string) => {
  const signatureRequest = await prisma.authSignatureRequest.findFirst({where: {id: {equals: requestId}}});
  if (!signatureRequest){
    throw new ApiError(httpStatus.NOT_FOUND, `requestId not found`);
  }
  //
  const network = Network.instances.get(signatureRequest.chainId.toString())!;
  if (!network.guardian){
    throw new ApiError(httpStatus.BAD_REQUEST, `Recovery Guardian is not enabled on this network`);
  }
  // The module saved on the request: a signature for another module would look valid but never verify on chain.
  const recoveryModule = network.requireRequestModule(signatureRequest.moduleAddress);
  const signer = Signers.instance().getSigner(network.guardian)!;
  const guardianAddress = (await signer.signer()).toLowerCase();
  const isGuardianEnabled = await recoveryModule.contract.isGuardian(signatureRequest.account, guardianAddress);
  if (!isGuardianEnabled){
    throw new ApiError(httpStatus.BAD_REQUEST, `This account has not set '${guardianAddress}' as a guardian`);
  }
  //
  const challengeRequest = await prisma.signatureRequestVerification.findFirst({
    where: {
      id: {equals: challengeId},
      authSignatureRequestId: {equals: requestId},
    }
  });
  if (!challengeRequest){
    throw new ApiError(httpStatus.NOT_FOUND, `challengeId not found for this requestId`);
  }
  if (challengeRequest.verified){
    throw new ApiError(httpStatus.BAD_REQUEST, `challengeId already verified`);
  }
  //
  const alertChannel = Alerts.instance().getAlertChannel(network.alert ?? "", challengeRequest.channel);
  if (!alertChannel){
    throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, `Channel '${challengeRequest.channel}' no longer exists, please contact support`);
  }
  //
  const currentDate = new Date(Date.now());
  if (challengeRequest.expiresAt < currentDate){
    throw new ApiError(httpStatus.FORBIDDEN, `challengeId has been expired`);
  }
  //
  const validChallenge = await alertChannel.verifyChallenge(
    challenge,
    challengeRequest.challengeHash,
    signatureRequest.account.toLowerCase()
  );
  if (!validChallenge){
    await prisma.signatureRequestVerification.update({
      data: {tries: {increment: 1}},
      where: {id: challengeRequest.id}
    });
    throw new ApiError(httpStatus.FORBIDDEN, `Invalid challenge`);
  }
  //
  await prisma.signatureRequestVerification.update({
    data: {verified: true, verifiedAt: currentDate},
    where: {id: challengeId}
  });
  //
  const challenges  = await prisma.signatureRequestVerification.findMany({
    where: {
      authSignatureRequestId: {equals: requestId},
    }
  });
  let collectedVerifications = 0;
  for (const challenge of challenges) {
    if (challenge.verified) collectedVerifications++;
  }
  if (collectedVerifications >= signatureRequest.requiredVerifications){
    const recoveryHash = await recoveryModule.getRecoveryHash(
      signatureRequest.account,
      signatureRequest.newOwners,
      signatureRequest.newThreshold,
      signatureRequest.nonce,
    );
    const signature = await signer.sign(recoveryHash);
    await prisma.authSignatureRequest.update({
      data: {
        guardian: guardianAddress,
        signature,
      },
      where: {id: signatureRequest.id}
    });
    return {
      success: true,
      signer: guardianAddress,
      signature,
    };
  }
  //
  return {success: true};
};