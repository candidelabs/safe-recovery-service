import httpStatus from "http-status";
import {ethers} from "ethers";
import {
  ApiError,
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
  const currentTimestamp = Math.ceil(Date.now()/1000);
  // timestamp should be within 5 minutes of signature timestamp
  if (Math.abs(currentTimestamp - timestamp) > (60*5)) {
    throw new ApiError(httpStatus.FORBIDDEN, `Timestamp expired, signature timestamp should be within 5 minutes of sending the request`);
  }
  const message = `${chainId}:${channel}:${target}:${timestamp}`; // todo proper message
  const validSignature = await isValidSignature(
    account,
    ethers.utils.arrayify(message),
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
    "subject": "",
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
  const currentTimestamp = Math.ceil(Date.now()/1000);
  // timestamp should be within 5 minutes of signature timestamp
  if (Math.abs(currentTimestamp - timestamp) > (60*5)) {
    throw new ApiError(httpStatus.FORBIDDEN, `Timestamp expired, signature timestamp should be within 5 minutes of sending the request`);
  }
  //
  const message = `${chainId}:${timestamp}`; // todo proper message
  const validSignature = await isValidSignature(
    account,
    ethers.utils.arrayify(message),
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

export const deleteRegistration = async (registrationId: string, chainId: number, timestamp: number, signature: string) => {
  const network = Network.instances.get(chainId.toString())!;
  //
  const authRegistration = await prisma.authRegistration.findFirst({where: {id: {equals: registrationId},}});
  if (!authRegistration){
    throw new ApiError(httpStatus.NOT_FOUND, `Could not find registration with this id`);
  }
  //
  const currentTimestamp = Math.ceil(Date.now()/1000);
  // timestamp should be within 5 minutes of signature timestamp
  if (Math.abs(currentTimestamp - timestamp) > (60*5)) {
    throw new ApiError(httpStatus.FORBIDDEN, `Timestamp expired, signature timestamp should be within 5 minutes of sending the request`);
  }
  //
  const message = `${registrationId}:${chainId}:${timestamp}`; // todo proper message
  const validSignature = await isValidSignature(
    authRegistration.account,
    ethers.utils.arrayify(message),
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