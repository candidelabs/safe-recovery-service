import httpStatus from "http-status";
import {BigNumber} from "ethers";
import {ApiError, validateSIWEMessage,} from "../utils";
import {prisma} from "../config/prisma-client";
import {ModuleSelection, Network} from "../models/network";
import {Alerts} from "../models/alert/alerts";
import {Signers} from "../models/signer/signers";
import {MessageStatements} from "../utils/constants";
import {LookupAccount, lookupAccounts} from "../utils/account-lookup";
import {checkRecoveryModule} from "./recovery-modules.service";
import {requireVerifiedTarget} from "./verification.service";
import logger from "../utils/logger";

const log = logger.child({ component: "auth" });

// The registration that /submit (after its code) and register (with a verificationToken) create.
const storeRegistration = async (network: Network, account: string, chainId: number, channel: string, target: string) => {
  const signer = Signers.instance().getSigner(network.guardian!)!;
  const guardian = await signer.signer();
  return prisma.authRegistration.create(
    {
      data: {
        account: account.toLowerCase(),
        chainId,
        channel,
        target,
        guardian
      }
    }
  );
};

export const createRegistration = async (
  account: string,
  chainId: number,
  channel: string,
  target: string,
  message: string,
  signature: string,
  verificationToken?: string,
): Promise<{challengeId: string} | {registrationId: string, guardianAddress: string}> => {
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
  // A token is checked before the SIWE message: a refused token leaves the nonce free (the same signed message can be
  // sent again without the token) and costs no RPC call. It never replaces the account's signature.
  const verification = verificationToken === undefined
    ? undefined
    : await requireVerifiedTarget(verificationToken, "register", {channel, target: sanitizedTarget});
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
  if (verification) {
    // the target was verified: no second code
    const registration = await storeRegistration(network, account, chainId, channel, target);
    log.info(
      {
        registrationId: registration.id, account: registration.account, chainId, channel, verification: "token",
        verificationId: verification.verificationId, accountDeployed: !counterfactual,
      },
      "auth registration created"
    );
    return {registrationId: registration.id, guardianAddress: registration.guardian};
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
  return {challengeId: authRegistrationRequest.id};
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
  const registration = await storeRegistration(
    network,
    registrationRequest.account,
    registrationRequest.chainId,
    registrationRequest.channel,
    registrationRequest.target,
  );
  log.info(
    { registrationId: registration.id, account: registration.account, chainId: registration.chainId, channel: registration.channel, verification: "otp" },
    "auth registration created"
  );
  //
  return [registration.id, registration.guardian];
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

// The accounts registered with the target a verificationToken proves (POST /v1/auth/accounts); the rule is in
// src/utils/account-lookup.ts. It can be called again while the token lives. Neither the target nor the accounts found
// are logged.
export const listAccounts = async (verificationToken: string): Promise<LookupAccount[]> => {
  const {verificationId, channel, target} = await requireVerifiedTarget(verificationToken, "lookup");
  // Registrations as stored: no on-chain check (the guardian may have been removed since).
  const registrations = await prisma.authRegistration.findMany({
    where: {channel, target, chainId: {in: Network.supportedChainIds}},
    select: {account: true, chainId: true},
  });
  const accounts = lookupAccounts(registrations, Network.supportedChainIds);
  log.info({ verificationId, channel, accountCount: accounts.length }, "account lookup completed");
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