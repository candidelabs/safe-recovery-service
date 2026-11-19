import httpStatus from "http-status";
import {createHash, randomBytes} from "node:crypto";

// Verifying an email address or phone number (POST /v1/auth/verification/request and /v1/auth/verification/submit),
// and the verifiedTargetToken that proves it to the account lookup, register and subscribe. The rules live here, apart
// from the database, so they are tested without one; verification.service.ts applies them.

// A code is valid for 10 minutes, like the other OTPs.
export const VERIFICATION_VALIDITY_MS = 10 * 60 * 1000;
// Wrong codes after which a challenge is dead.
export const VERIFICATION_MAX_TRIES = 5;
// A request within this time of the latest challenge for the same channel and target gets that challenge back
// (no new challenge, no new code).
export const VERIFICATION_COOLDOWN_MS = 60 * 1000;
// Wrong codes per channel and target across all its challenges within the window, after which every submit for
// that target is refused (and no code is sent) until older failures leave the window.
export const VERIFICATION_TARGET_MAX_FAILURES = 10;
// Send attempts per channel and target within the window (a code whose send failed counts), after which no code
// is sent until older ones leave it.
export const VERIFICATION_TARGET_MAX_CODES = 10;
export const VERIFICATION_TARGET_WINDOW_MS = 24 * 60 * 60 * 1000;
// How long a verifiedTargetToken is accepted after the right code.
export const VERIFIED_TARGET_TOKEN_VALIDITY_MS = 10 * 60 * 1000;

export interface VerificationNetwork {
  guardian?: string;
  alert?: string;
}

export interface VerificationChallenge {
  verified: boolean;
  tries: number;
  expiresAt: Date;
}

export interface VerificationRejection {
  status: number;
  message: string;
}

/**
 * The alerts that may send a verification code, in order: the alert of each enabled network with a guardian (config
 * order), then options.indexerAlert, so a deployment that only serves alerts can verify targets too.
 */
export function verificationAlertIds(networks: readonly VerificationNetwork[], indexerAlert?: string): string[] {
  const ids: string[] = [];
  for (const network of networks) {
    if (network.guardian && network.alert) ids.push(network.alert);
  }
  if (indexerAlert) ids.push(indexerAlert);
  return ids;
}

/**
 * The channel that sends and checks verification codes: the first alert, in the order given, that offers the channel.
 */
export function selectVerificationChannel<C>(
  channel: string,
  alertIds: readonly string[],
  getChannel: (alertId: string, channel: string) => C | undefined,
): {alertId: string, alertChannel: C} | undefined {
  for (const alertId of alertIds) {
    const alertChannel = getChannel(alertId, channel);
    if (alertChannel) return {alertId, alertChannel};
  }
  return undefined;
}

// The seed the code is hashed with: the channel and the normalized target.
export const verificationChallengeSeed = (channel: string, target: string): string => `${channel}:${target}`;

export const withinCooldown = (createdAt: Date, now: Date): boolean =>
  now.getTime() - createdAt.getTime() < VERIFICATION_COOLDOWN_MS;

export const targetWindowStart = (now: Date): Date => new Date(now.getTime() - VERIFICATION_TARGET_WINDOW_MS);

// Whether a target is locked, given its tries within the window (not counting the try being checked).
export const targetLocked = (targetFailures: number): boolean => targetFailures >= VERIFICATION_TARGET_MAX_FAILURES;

// Whether a target got all the codes it may get within the window, given the send attempts to it there.
export const targetCapped = (targetCodes: number): boolean => targetCodes >= VERIFICATION_TARGET_MAX_CODES;

export const ALREADY_VERIFIED: VerificationRejection = {status: httpStatus.BAD_REQUEST, message: "challengeId already verified"};
export const EXPIRED: VerificationRejection = {status: httpStatus.FORBIDDEN, message: "challengeId has been expired"};
export const TOO_MANY_TRIES: VerificationRejection = {status: httpStatus.FORBIDDEN, message: "Too many invalid challenges, request a new code"};
export const TARGET_LOCKED: VerificationRejection = {status: httpStatus.FORBIDDEN, message: "Too many invalid challenges for this target, try again later"};
export const INVALID_CHALLENGE: VerificationRejection = {status: httpStatus.FORBIDDEN, message: "Invalid challenge"};

/**
 * Why a submit's try could not be counted: the conditional update that counts it (not verified, not expired, fewer
 * than VERIFICATION_MAX_TRIES tries) matched nothing, so the challenge, read again, fails one of those.
 */
export function refusedTry(challenge: VerificationChallenge, now: Date): VerificationRejection {
  if (challenge.verified) return ALREADY_VERIFIED;
  if (challenge.expiresAt <= now) return EXPIRED;
  return TOO_MANY_TRIES;
}

// The verifiedTargetToken.
//
// It proves control of a (channel, normalized target) for VERIFIED_TARGET_TOKEN_VALIDITY_MS and is a bearer secret: a
// client keeps it in memory, never in a URL, a log or storage. Only its SHA-256 hash is stored (enough for 256
// random bits), and neither the token nor the hash is ever logged or put in an error message ("verifiedTargetToken"
// ends in "token", so the log and Sentry redaction also covers it by key name).
//
// What it can do: list the accounts registered with the target; register the target for an account that signs for
// it (POST /v1/auth/register); subscribe the target to the alerts of an account whose owner signs
// (POST /v1/alerts/subscribe). What it can never do: approve a recovery (/v1/auth/signature/*), delete a
// registration, unsubscribe. A registration or subscription still needs a SIWE signature and proof of the target.
// Unlike the per-endpoint codes, which are tied to one account (and owner), the token is tied to the target only:
// whoever holds a victim's token, or talks the victim out of a verification code, can register an account of their
// own with the victim's target or send it that account's alerts, as a phished registration or alerts code allows
// today. The message says what the code does and to never share it.

export type VerifiedTargetTokenRefusal = "unknown" | "expired" | "mismatch";

export interface VerifiedTarget {
  channel: string;
  target: string;
}

export interface VerifiedTargetTokenRow extends VerifiedTarget {
  tokenExpiresAt: Date | null;
}

// 32 random bytes, base64url: 43 characters of [A-Za-z0-9_-].
export const newVerifiedTargetToken = (): string => randomBytes(32).toString("base64url");

export const hashVerifiedTargetToken = (token: string): string => createHash("sha256").update(token).digest("hex");

/**
 * Why a token is refused, or undefined when it is accepted: no row has its hash ("unknown"), it has no expiry or
 * expired at or before now ("expired"), or it was issued for another channel or target than the request's
 * ("mismatch"; only when an expectation is given, the account lookup has none).
 */
export function refusedVerifiedTargetToken(
  verification: VerifiedTargetTokenRow | null | undefined,
  expected: VerifiedTarget | undefined,
  now: Date,
): VerifiedTargetTokenRefusal | undefined {
  if (!verification) return "unknown";
  if (!verification.tokenExpiresAt || verification.tokenExpiresAt <= now) return "expired";
  if (expected && (expected.channel !== verification.channel || expected.target !== verification.target)) return "mismatch";
  return undefined;
}
