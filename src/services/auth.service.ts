import httpStatus from "http-status";
import {BigNumber, ethers} from "ethers";
import {
  ApiError, getSocialModuleInstance,
  isValidSignature,
} from "../utils";
import {prisma} from "../config/prisma-client";
import {Network} from "../models/network";
import {Alerts} from "../models/alert/alerts";
import {Signers} from "../models/signer/signers";

export const createRegistration = async (account: string, chainId: number, channel: string, target: string, timestamp: number, signature: string) => {
  const network = Network.instances.get(chainId.toString())!;
  if (!network.guardian){
    throw new ApiError(httpStatus.BAD_REQUEST, `Recovery Guardian is not enabled on this network`);
  }
  const alertChannel = Alerts.instance().getAlertChannel(network.alert ?? "", channel);
  if (!alertChannel){
    throw new ApiError(httpStatus.BAD_REQUEST, `Target channel '${channel}' is not supported on this network`);
  }
  //
  const _target = await alertChannel.sanitizeTarget(target);
  if (!_target) {
    throw new ApiError(httpStatus.FORBIDDEN, `Target '${target}' is not compatible with '${channel}' channel`);
  }
  target = _target;
  //
  const currentTimestamp = Date.now();
  // timestamp should be within 5 minutes of signature timestamp
  if (Math.abs(currentTimestamp - timestamp) > (60*5*1000)) {
    throw new ApiError(httpStatus.FORBIDDEN, `Timestamp expired, signature timestamp should be within 5 minutes of sending the request`);
  }
  const message = `${chainId}:${channel}:${target}:${timestamp}`; // todo proper message
  const validSignature = await isValidSignature(
    account,
    ethers.utils.toUtf8Bytes(message),
    ethers.utils.arrayify(signature),
    network.jsonRPCProvider
  );
  if (!validSignature) {
    throw new ApiError(httpStatus.FORBIDDEN, `Invalid signature, make sure you correctly signed this request, learn more here ...}`); // todo add link for signature generation
  }
  //
  const existingRegistration = await prisma.authRegistration.findFirst({
    where: {
      account: {equals: account.toLowerCase()},
      chainId: {equals: chainId},
      channel: {equals: channel},
      target: {equals: target.toLowerCase()},
    }
  });
  if (existingRegistration){
    throw new ApiError(httpStatus.CONFLICT, `An active registration already exists for ${account} on chainId ${chainId} using ${target} as ${channel}`);
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
      data: {tries: registrationRequest.tries + 1},
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

export const fetchRegistrations = async (account: string, chainId: number, timestamp: number, signature: string) => {
  const network = Network.instances.get(chainId.toString())!;
  //
  const currentTimestamp = Date.now();
  // timestamp should be within 5 minutes of signature timestamp
  if (Math.abs(currentTimestamp - timestamp) > (60*5*1000)) {
    throw new ApiError(httpStatus.FORBIDDEN, `Timestamp expired, signature timestamp should be within 5 minutes of sending the request`);
  }
  //
  const message = `${chainId}:${timestamp}`; // todo proper message
  const validSignature = await isValidSignature(
    account,
    ethers.utils.toUtf8Bytes(message),
    ethers.utils.arrayify(signature),
    network.jsonRPCProvider
  );
  if (!validSignature) {
    throw new ApiError(httpStatus.FORBIDDEN, `Invalid signature, make sure you correctly signed this request, learn more here ...}`); // todo add link for signature generation
  }
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

export const deleteRegistration = async (registrationId: string, timestamp: number, signature: string) => {
  const authRegistration = await prisma.authRegistration.findFirst({where: {id: {equals: registrationId},}});
  if (!authRegistration){
    throw new ApiError(httpStatus.NOT_FOUND, `Could not find registration with this id`);
  }
  //
  const currentTimestamp = Date.now();
  // timestamp should be within 5 minutes of signature timestamp
  if (Math.abs(currentTimestamp - timestamp) > (60*5*1000)) {
    throw new ApiError(httpStatus.FORBIDDEN, `Timestamp expired, signature timestamp should be within 5 minutes of sending the request`);
  }
  //
  const network = Network.instances.get(authRegistration.chainId.toString())!;
  const message = `${registrationId}:${timestamp}`; // todo proper message
  const validSignature = await isValidSignature(
    authRegistration.account,
    ethers.utils.toUtf8Bytes(message),
    ethers.utils.arrayify(signature),
    network.jsonRPCProvider
  );
  if (!validSignature) {
    throw new ApiError(httpStatus.FORBIDDEN, `Invalid signature, make sure you correctly signed this request, learn more here ...}`); // todo add link for signature generation
  }
  //
  await prisma.authRegistration.delete({
    where: {id: registrationId}
  });
  return true;
};

export const requestSignature = async (account: string, newOwners: string[], newThreshold: number, chainId: number) => {
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
  const socialRecoveryModule = getSocialModuleInstance(network.recoveryModuleAddress, network.jsonRPCProvider);
  const recoveryNonce: BigNumber = await socialRecoveryModule.nonce(account);
  const isGuardianEnabled = await socialRecoveryModule.isGuardian(account, guardianAddress);
  if (!isGuardianEnabled){
    throw new ApiError(httpStatus.BAD_REQUEST, `This account has not set '${guardianAddress}' as a guardian`);
  }
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
  const socialRecoveryModule = getSocialModuleInstance(network.recoveryModuleAddress, network.jsonRPCProvider);
  const signer = Signers.instance().getSigner(network.guardian)!;
  const guardianAddress = (await signer.signer()).toLowerCase();
  const isGuardianEnabled = await socialRecoveryModule.isGuardian(signatureRequest.account, guardianAddress);
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
      data: {tries: challengeRequest.tries + 1},
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
    const recoveryHash = await socialRecoveryModule.getRecoveryHash(
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