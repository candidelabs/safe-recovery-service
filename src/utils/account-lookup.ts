import httpStatus from "http-status";

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

export const withinCooldown = (createdAt: Date, now: Date): boolean =>
  now.getTime() - createdAt.getTime() < ACCOUNT_LOOKUP_COOLDOWN_MS;

export const targetWindowStart = (now: Date): Date => new Date(now.getTime() - ACCOUNT_LOOKUP_TARGET_WINDOW_MS);

// Whether a target is locked, given its tries within the window (not counting the try being checked).
export const targetLocked = (targetFailures: number): boolean => targetFailures >= ACCOUNT_LOOKUP_TARGET_MAX_FAILURES;

export const ALREADY_VERIFIED: LookupRejection = {status: httpStatus.BAD_REQUEST, message: "challengeId already verified"};
export const EXPIRED: LookupRejection = {status: httpStatus.FORBIDDEN, message: "challengeId has been expired"};
export const TOO_MANY_TRIES: LookupRejection = {status: httpStatus.FORBIDDEN, message: "Too many invalid challenges, request a new code"};
export const TARGET_LOCKED: LookupRejection = {status: httpStatus.FORBIDDEN, message: "Too many invalid challenges for this target, try again later"};
export const INVALID_CHALLENGE: LookupRejection = {status: httpStatus.FORBIDDEN, message: "Invalid challenge"};

/**
 * Why a submit's try could not be counted: the conditional update that counts it (not verified, not expired, fewer
 * than ACCOUNT_LOOKUP_MAX_TRIES tries) matched nothing, so the challenge, read again, fails one of those.
 */
export function refusedTry(challenge: LookupChallenge, now: Date): LookupRejection {
  if (challenge.verified) return ALREADY_VERIFIED;
  if (challenge.expiresAt <= now) return EXPIRED;
  return TOO_MANY_TRIES;
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
