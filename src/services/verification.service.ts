import httpStatus from "http-status";
import {ApiError} from "../utils";
import {prisma} from "../config/prisma-client";
import {Network} from "../models/network";
import {Alerts} from "../models/alert/alerts";
import {Configuration} from "../config/config-manager";
import {
  ALREADY_VERIFIED,
  INVALID_CHALLENGE,
  TARGET_LOCKED,
  VERIFICATION_MAX_TRIES,
  VERIFIED_TARGET_TOKEN_VALIDITY_MS,
  VERIFICATION_VALIDITY_MS,
  VerificationRejection,
  VerifiedTarget,
  hashVerifiedTargetToken,
  newVerifiedTargetToken,
  refusedTry,
  refusedVerifiedTargetToken,
  selectVerificationChannel,
  targetCapped,
  targetLocked,
  targetWindowStart,
  verificationAlertIds,
  verificationChallengeSeed,
  withinCooldown,
} from "../utils/target-verification";
import logger from "../utils/logger";

// Verifying an email address or phone number (POST /v1/auth/verification/request and /submit) and checking the
// verifiedTargetToken it yields (requireVerifiedTarget). The rules are in src/utils/target-verification.ts. Neither the
// target, the code, the token nor its hash is logged.

const log = logger.child({ component: "verification" });

// The enabled networks, in config order.
const enabledNetworks = () => Network.supportedChainIds.map((chainId) => Network.instances.get(chainId.toString())!);

// Wrong codes (tries) and codes sent (rows: a row is created only when a code is sent) for a channel and target
// within the window, across its challenges.
const targetActivity = async (channel: string, target: string, now: Date) => {
  const {_sum, _count} = await prisma.targetVerification.aggregate({
    _sum: {tries: true},
    _count: {_all: true},
    where: {channel, target, createdAt: {gte: targetWindowStart(now)}},
  });
  return {tries: _sum.tries ?? 0, codes: _count._all};
};

// Takes back a try counted for a code that was not checked or was right, so tries count wrong codes.
const giveTryBack = (id: string) => prisma.targetVerification.update({
  data: {tries: {decrement: 1}},
  where: {id}
});

const verificationRefused = (challengeId: string, channel: string, rejection: VerificationRejection) => {
  log.info({ challengeId, channel, statusCode: rejection.status }, "target verification refused");
  return new ApiError(rejection.status, rejection.message);
};

export const requestVerification = async (channel: string, target: string): Promise<string> => {
  const selected = selectVerificationChannel(
    channel,
    verificationAlertIds(enabledNetworks(), Configuration.instance().indexerAlert),
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
  // Every valid target gets a code, registered or not, and the answer is the same. The cooldown and the cap are
  // plain reads: parallel requests can all miss them, and each makes a challenge and sends a code. Guessing stays
  // capped by the tries counted on submit.
  const now = new Date();
  const latest = await prisma.targetVerification.findFirst({
    where: {channel, target},
    orderBy: {createdAt: "desc"},
    select: {id: true, createdAt: true},
  });
  if (latest && withinCooldown(latest.createdAt, now)) {
    log.info({ challengeId: latest.id, channel, reused: true }, "target verification requested");
    return latest.id;
  }
  // A locked or capped target has rows within the window, so latest is set: its id is returned, nothing is sent.
  const {tries, codes} = await targetActivity(channel, target, now);
  const limit = targetLocked(tries) ? "locked" : targetCapped(codes) ? "capped" : undefined;
  if (limit && latest) {
    log.info({ challengeId: latest.id, channel, reused: true, limit }, "target verification requested");
    return latest.id;
  }
  const [challenge, challengeHash] = await alertChannel.generateChallenge(verificationChallengeSeed(channel, target));
  const verification = await prisma.targetVerification.create({
    data: {
      channel,
      target,
      alertId,
      challengeHash,
      verified: false,
      tries: 0,
      expiresAt: new Date(now.getTime() + VERIFICATION_VALIDITY_MS),
    }
  });
  // not awaited, and only once the response is written, so sending does not change its timing
  setImmediate(() => {
    void alertChannel.sendMessage("targetVerificationOtp", target, {
      "subject": "Your Safe Recovery verification code",
      "otp": challenge,
    });
  });
  log.info({ challengeId: verification.id, channel, reused: false }, "target verification requested");
  return verification.id;
};

export const submitVerification = async (challengeId: string, challenge: string) => {
  const verification = await prisma.targetVerification.findFirst({where: {id: {equals: challengeId}}});
  if (!verification){
    throw new ApiError(httpStatus.NOT_FOUND, `challengeId not found`);
  }
  const {id, channel, target} = verification;
  const alertChannel = Alerts.instance().getAlertChannel(verification.alertId, channel);
  if (!alertChannel){
    throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, `Channel '${channel}' no longer exists, please contact support`);
  }
  const now = new Date();
  // The try is counted before the code is checked, by one conditional update: each update is atomic, so however many
  // submits arrive at once, at most VERIFICATION_MAX_TRIES codes are checked per challenge, and the target total
  // read afterwards includes every try counted before this one.
  const counted = await prisma.targetVerification.updateMany({
    data: {tries: {increment: 1}},
    where: {id, verified: false, expiresAt: {gt: now}, tries: {lt: VERIFICATION_MAX_TRIES}},
  });
  if (counted.count === 0) {
    const current = await prisma.targetVerification.findUnique({where: {id}});
    throw verificationRefused(challengeId, channel, refusedTry(current ?? verification, now));
  }
  if (targetLocked((await targetActivity(channel, target, now)).tries - 1)) {
    await giveTryBack(id);
    throw verificationRefused(challengeId, channel, TARGET_LOCKED);
  }
  const validChallenge = await alertChannel.verifyChallenge(challenge, verification.challengeHash, verificationChallengeSeed(channel, target));
  if (!validChallenge) {
    // the try stays counted
    throw verificationRefused(challengeId, channel, INVALID_CHALLENGE);
  }
  // Single use, and one token per challenge: the update that marks it verified also stores the token's hash, so of
  // two right codes at once only one matches, and the other gets a 400.
  const verifiedTargetToken = newVerifiedTargetToken();
  const verifiedTargetTokenExpiresAt = new Date(now.getTime() + VERIFIED_TARGET_TOKEN_VALIDITY_MS);
  const verified = await prisma.targetVerification.updateMany({
    data: {
      verified: true,
      verifiedAt: now,
      tries: {decrement: 1},
      tokenHash: hashVerifiedTargetToken(verifiedTargetToken),
      tokenExpiresAt: verifiedTargetTokenExpiresAt,
    },
    where: {id, verified: false},
  });
  if (verified.count === 0) {
    await giveTryBack(id);
    throw verificationRefused(challengeId, channel, ALREADY_VERIFIED);
  }
  log.info({ challengeId, channel }, "target verification completed");
  return {verifiedTargetToken, verifiedTargetTokenExpiresAt};
};

export type VerifiedTargetTokenUse = "lookup" | "register" | "subscribe";

/**
 * The target a verifiedTargetToken proves, or a 403 when the token is unknown, expired or (when `expected` is given)
 * was issued for another channel or target. register and subscribe call it after sanitizeTarget and before the SIWE
 * check, so a refused token leaves the SIWE nonce free and costs no RPC call.
 */
export const requireVerifiedTarget = async (
  verifiedTargetToken: string,
  use: VerifiedTargetTokenUse,
  expected?: VerifiedTarget,
): Promise<{verificationId: string} & VerifiedTarget> => {
  const verification = await prisma.targetVerification.findUnique({
    where: {tokenHash: hashVerifiedTargetToken(verifiedTargetToken)},
    select: {id: true, channel: true, target: true, tokenExpiresAt: true},
  });
  const reason = refusedVerifiedTargetToken(verification, expected, new Date());
  if (reason || !verification) {
    log.info(
      { use, reason, verificationId: verification?.id, statusCode: httpStatus.FORBIDDEN },
      "verified target token refused"
    );
    throw new ApiError(httpStatus.FORBIDDEN, `Invalid or expired verifiedTargetToken`);
  }
  return {verificationId: verification.id, channel: verification.channel, target: verification.target};
};
