// Listing the accounts registered with a verified email address or phone number (POST /v1/auth/accounts). The rule
// lives here, apart from the database, so it is tested without one; auth.service.ts applies it.

export interface LookupAccount {
  account: string;
  chainId: number;
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
