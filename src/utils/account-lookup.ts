// Listing the accounts registered with a verified email address or phone number (POST /v1/auth/accounts). The rule
// lives here, apart from the database, so it is tested without one; auth.service.ts applies it.

import {AccountMetadata, storedAccountMetadata} from "./account-metadata";

/** A registration found for the target. */
export interface LookupRegistration {
  account: string;
  chainId: number;
  createdAt: Date;
}

/** A stored metadata row (AuthAccountMetadata) of one of the accounts found. */
export interface LookupMetadataRow {
  account: string;
  chainId: number;
  metadata: unknown;
}

export interface LookupAccount {
  account: string;
  chainId: number;
  registeredAt: string;
  metadata: AccountMetadata;
}

const lookupKey = (account: string, chainId: number) => `${account.toLowerCase()}:${chainId}`;

/**
 * The accounts a lookup returns: registrations on a chain the service has enabled, one entry per (account, chainId),
 * lower-case, sorted by account then chainId. `registeredAt` is the earliest registration of the account on the chain
 * (ISO 8601), `metadata` the row of the same account and chain, else `{}`.
 */
export function lookupAccounts(
  registrations: readonly LookupRegistration[],
  enabledChainIds: readonly number[],
  metadataRows: readonly LookupMetadataRow[] = [],
): LookupAccount[] {
  const enabled = new Set(enabledChainIds);
  const metadata = new Map<string, unknown>();
  for (const row of metadataRows) {
    metadata.set(lookupKey(row.account, row.chainId), row.metadata);
  }
  const earliest = new Map<string, LookupRegistration>();
  for (const registration of registrations) {
    if (!enabled.has(registration.chainId)) continue;
    const account = registration.account.toLowerCase();
    const key = lookupKey(account, registration.chainId);
    const found = earliest.get(key);
    if (!found || registration.createdAt < found.createdAt) {
      earliest.set(key, {account, chainId: registration.chainId, createdAt: registration.createdAt});
    }
  }
  return [...earliest.values()]
    .map(({account, chainId, createdAt}) => ({
      account,
      chainId,
      registeredAt: createdAt.toISOString(),
      metadata: storedAccountMetadata(metadata.get(lookupKey(account, chainId))),
    }))
    .sort((a, b) => {
      if (a.account !== b.account) return a.account < b.account ? -1 : 1;
      return a.chainId - b.chainId;
    });
}
