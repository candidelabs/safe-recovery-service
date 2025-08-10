export enum EventType {
  GuardianAdded,
  GuardianRevoked,
  ChangedThreshold,
  RecoveryExecuted,
  RecoveryFinalized,
  RecoveryCanceled,
}

export const MessageStatements = {
  "auth-register": "I authorize Safe Recovery Service to sign a recovery request for my account after I authenticate using {{target}} (via {{channel}})",
  "auth-fetch": "I request to retrieve all authentication methods currently registered to my account with Safe Recovery Service",
  "auth-delete": "I request to remove the authentication method with registration ID {{id}} from my account on Safe Recovery Service",
  //
  "alerts-subscribe": "I agree to receive Social Recovery Module alert notifications for my account address on all supported chains sent to {{target}} (via {{channel}})",
  "alerts-fetch": "I request to retrieve all Social Recovery Module alert subscriptions linked to my account",
  "alerts-unsubscribe": "I request to unsubscribe all Social Recovery Module alert subscriptions linked to my account",
}