import httpStatus from "http-status";
import {ethers} from "ethers";

// Looking up the accounts registered with an email address or phone number (POST /v1/auth/accounts/request and
// /v1/auth/accounts/submit). The rules live here, apart from the database, so they are tested without one;
// auth.service.ts applies them.

// A code is valid for 10 minutes, like the other OTPs.
export const ACCOUNT_LOOKUP_VALIDITY_MS = 10 * 60 * 1000;
// Wrong codes after which a challenge is dead.
export const ACCOUNT_LOOKUP_MAX_TRIES = 5;
// A request within this time of the latest challenge for the same channel and target gets that challenge back
// (no new challenge, no new code).
export const ACCOUNT_LOOKUP_COOLDOWN_MS = 60 * 1000;
// Wrong codes per channel and target across all its challenges within the window, after which every submit for
// that target is refused (and no code is sent) until older failures leave the window.
export const ACCOUNT_LOOKUP_TARGET_MAX_FAILURES = 10;
export const ACCOUNT_LOOKUP_TARGET_WINDOW_MS = 24 * 60 * 60 * 1000;

export interface LookupNetwork {
  guardian?: string;
  alert?: string;
}

export interface LookupChallenge {
  verified: boolean;
  tries: number;
  expiresAt: Date;
}

export interface LookupRejection {
  status: number;
  message: string;
}

export interface LookupAccount {
  account: string;
  chainId: number;
}

/**
 * The channel that sends and checks lookup codes: the first network (in config order) with a guardian whose alert
 * offers the channel. Registrations only exist on networks with a guardian.
 */
export function selectLookupChannel<C>(
  channel: string,
  networks: readonly LookupNetwork[],
  getChannel: (alertId: string, channel: string) => C | undefined,
): {alertId: string, alertChannel: C} | undefined {
  for (const network of networks) {
    if (!network.guardian || !network.alert) continue;
    const alertChannel = getChannel(network.alert, channel);
    if (alertChannel) return {alertId: network.alert, alertChannel};
  }
  return undefined;
}

// The seed the code is hashed with: the channel and the normalized target.
export const lookupChallengeSeed = (channel: string, target: string): string => `${channel}:${target}`;

// The Postgres advisory lock key that serializes the requests and submits of one channel and target (64 bits).
export const lookupLockKey = (channel: string, target: string): bigint =>
  BigInt.asIntN(64, BigInt(ethers.utils.id(`account-lookup:${channel}:${target}`).slice(0, 18)));

export const withinCooldown = (createdAt: Date, now: Date): boolean =>
  now.getTime() - createdAt.getTime() < ACCOUNT_LOOKUP_COOLDOWN_MS;

export const targetWindowStart = (now: Date): Date => new Date(now.getTime() - ACCOUNT_LOOKUP_TARGET_WINDOW_MS);

export const targetLocked = (targetFailures: number): boolean => targetFailures >= ACCOUNT_LOOKUP_TARGET_MAX_FAILURES;

/**
 * Why a submit is refused before its code is checked, or undefined. targetFailures is the number of wrong codes for
 * the challenge's channel and target within the window, this challenge's included.
 */
export function lookupSubmitRejection(challenge: LookupChallenge, now: Date, targetFailures: number): LookupRejection | undefined {
  if (challenge.verified) {
    return {status: httpStatus.BAD_REQUEST, message: "challengeId already verified"};
  }
  if (challenge.expiresAt <= now) {
    return {status: httpStatus.FORBIDDEN, message: "challengeId has been expired"};
  }
  if (challenge.tries >= ACCOUNT_LOOKUP_MAX_TRIES) {
    return {status: httpStatus.FORBIDDEN, message: "Too many invalid challenges, request a new code"};
  }
  if (targetLocked(targetFailures)) {
    return {status: httpStatus.FORBIDDEN, message: "Too many invalid challenges for this target, try again later"};
  }
  return undefined;
}

/**
 * The accounts a lookup returns: registrations on a chain the service has enabled, one entry per (account, chainId),
 * lower-case, sorted by account then chainId.
 */
export function lookupAccounts(registrations: readonly LookupAccount[], enabledChainIds: readonly number[]): LookupAccount[] {
  const enabled = new Set(enabledChainIds);
  const accounts = new Map<string, LookupAccount>();
  for (const registration of registrations) {
    if (!enabled.has(registration.chainId)) continue;
    const account = registration.account.toLowerCase();
    accounts.set(`${account}:${registration.chainId}`, {account, chainId: registration.chainId});
  }
  return [...accounts.values()].sort((a, b) => {
    if (a.account !== b.account) return a.account < b.account ? -1 : 1;
    return a.chainId - b.chainId;
  });
}
