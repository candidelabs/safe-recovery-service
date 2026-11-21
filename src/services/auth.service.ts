import httpStatus from "http-status";
import {BigNumber} from "ethers";
import {Prisma} from "@prisma/client";
import {ApiError, validateSIWEMessage,} from "../utils";
import {prisma} from "../config/prisma-client";
import {ModuleSelection, Network} from "../models/network";
import {Alerts} from "../models/alert/alerts";
import {Signers} from "../models/signer/signers";
import {MessageStatements} from "../utils/constants";
import {LookupAccount, lookupAccounts} from "../utils/account-lookup";
import {AccountMetadata, storedAccountMetadata} from "../utils/account-metadata";
import {checkRecoveryModule} from "./recovery-modules.service";
import {requireVerifiedTarget} from "./verification.service";
import logger from "../utils/logger";

const log = logger.child({ component: "auth" });

// The metadata of an account on a chain (src/utils/account-metadata.ts), one AuthAccountMetadata row shared by its
// registrations there: replaced whole, and removed when empty. The object, its keys and its values are never logged:
// log lines carry metadataEntries, the number of entries.
const writeAccountMetadata = async (account: string, chainId: number, metadata: AccountMetadata) => {
  account = account.toLowerCase();
  if (Object.keys(metadata).length === 0) {
    await prisma.authAccountMetadata.deleteMany({where: {account, chainId}});
    return;
  }
  const upsert = () => prisma.authAccountMetadata.upsert({
    where: {account_chainId: {account, chainId}},
    create: {account, chainId, metadata},
    update: {metadata},
  });
  try {
    await upsert();
  } catch (e) {
    // Two first writes at once (email and phone registered in parallel): the other one created the row, so this one
    // becomes an update. Anything else, or a second conflict, propagates.
    if (!(e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002")) throw e;
    await upsert();
  }
};

const readAccountMetadata = async (account: string, chainId: number): Promise<AccountMetadata> => {
  const row = await prisma.authAccountMetadata.findFirst({
    where: {account: account.toLowerCase(), chainId},
    select: {metadata: true},
  });
  return storedAccountMetadata(row?.metadata);
};

// The log field for metadata that was sent or written: its number of entries, never the object.
const metadataLogFields = (metadata?: AccountMetadata) => metadata === undefined ? {} : {metadataEntries: Object.keys(metadata).length};

// The registration that /submit (after its code) and register (with a verifiedTargetToken) create, then the account's
// metadata when some was sent (left out, the stored one is kept). The registration comes first: a request that stops in
// between leaves a registration with its previous metadata, never metadata without a registration.
const storeRegistration = async (
  network: Network,
  account: string,
  chainId: number,
  channel: string,
  target: string,
  metadata?: AccountMetadata,
) => {
  const signer = Signers.instance().getSigner(network.guardian!)!;
  const guardian = await signer.signer();
  const registration = await prisma.authRegistration.create(
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
  if (metadata !== undefined) {
    await writeAccountMetadata(account, chainId, metadata);
  }
  return registration;
};

export const createRegistration = async (
  account: string,
  chainId: number,
  channel: string,
  target: string,
  message: string,
  signature: string,
  verifiedTargetToken?: string,
  metadata?: AccountMetadata,
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
  const verification = verifiedTargetToken === undefined
    ? undefined
    : await requireVerifiedTarget(verifiedTargetToken, "register", {channel, target: sanitizedTarget});
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
    const registration = await storeRegistration(network, account, chainId, channel, target, metadata);
    log.info(
      {
        registrationId: registration.id, account: registration.account, chainId, channel, verification: "token",
        verificationId: verification.verificationId, accountDeployed: !counterfactual, ...metadataLogFields(metadata),
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
        // kept until /submit creates the registration (null when none was sent)
        metadata,
        challengeHash,
        verified: false,
        tries: 0,
        expiresAt: new Date(Date.now() + 10*60*1000)
      }
    }
  );
  // the target (email / phone number) and the OTP are never logged
  log.info(
    {
      challengeId: authRegistrationRequest.id, account: account.toLowerCase(), chainId, channel, accountDeployed: !counterfactual,
      ...metadataLogFields(metadata),
    },
    "auth registration requested"
  );
  return {challengeId: authRegistrationRequest.id};
};

export const submitRegistrationChallenge = async (challengeId: string, challenge: string) => {
  const registrationRequest = await prisma.authRegistrationRequest.findFirst({where: {id: {equals: challengeId}}});
  if (!registrationRequest){
    throw new ApiError(httpStatus.NOT_FOUND, `challengeId not found`);
  }
  // the metadata sent with register, if any (== null: a column that was never written reads as null, or undefined in
  // the tests' in-memory tables)
  const pendingMetadata = registrationRequest.metadata == null ? undefined : storedAccountMetadata(registrationRequest.metadata);
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
    pendingMetadata,
  );
  log.info(
    {
      registrationId: registration.id, account: registration.account, chainId: registration.chainId, channel: registration.channel, verification: "otp",
      ...metadataLogFields(pendingMetadata),
    },
    "auth registration created"
  );
  // Cleared once applied, not before: a failed store keeps it for a retry. The registration exists either way.
  if (pendingMetadata !== undefined) {
    try {
      await prisma.authRegistrationRequest.update({
        data: {metadata: Prisma.DbNull},
        where: {id: registrationRequest.id}
      });
    } catch (err) {
      log.warn({ challengeId: registrationRequest.id, err }, "pending registration metadata not cleared");
    }
  }
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
  // read from a registration only: a metadata row left without one is never returned
  const metadata = registrations.length > 0 ? await readAccountMetadata(account, chainId) : {};
  return {registrations, metadata};
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
  // The account's metadata on this chain goes with its last registration there, and first: a request that stops in
  // between leaves a registration without metadata, never metadata without a registration.
  const account = authRegistration.account.toLowerCase();
  const registrationCount = await prisma.authRegistration.count({where: {account, chainId: authRegistration.chainId}});
  if (registrationCount <= 1) {
    await prisma.authAccountMetadata.deleteMany({where: {account, chainId: authRegistration.chainId}});
  }
  //
  await prisma.authRegistration.delete({
    where: {id: registrationId}
  });
  return true;
};

// The accounts registered with the target a verifiedTargetToken proves (POST /v1/auth/accounts), with when each was
// first registered and its metadata; the rule is in src/utils/account-lookup.ts. It can be called again while the token
// lives. Neither the target, the accounts found nor their metadata are logged.
export const listAccounts = async (verifiedTargetToken: string): Promise<LookupAccount[]> => {
  const {verificationId, channel, target} = await requireVerifiedTarget(verifiedTargetToken, "lookup");
  // Registrations as stored: no on-chain check (the guardian may have been removed since).
  const registrations = await prisma.authRegistration.findMany({
    where: {channel, target, chainId: {in: Network.supportedChainIds}},
    select: {account: true, chainId: true, createdAt: true},
  });
  // the metadata of the accounts found, in one query
  const metadataRows = registrations.length === 0 ? [] : await prisma.authAccountMetadata.findMany({
    where: {
      account: {in: [...new Set(registrations.map(({account}) => account.toLowerCase()))]},
      chainId: {in: Network.supportedChainIds},
    },
    select: {account: true, chainId: true, metadata: true},
  });
  const accounts = lookupAccounts(registrations, Network.supportedChainIds, metadataRows);
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