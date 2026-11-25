# Safe Recovery Service

## Installation

Install dependencies using [Bun](https://bun.sh):

```bash
bun install
```

### Environment Setup

1. Fill in the env variables in `.env` with your a url to your database:
```bash
cp .env.example .env
```

### Database Setup

1. Check the migration status:
```bash
bunx prisma migrate status
```
2. If the database schema is not up to date, run the following command:
```bash
bunx prisma migrate dev
```

### Prisma Setup

Generate Prisma client (run after `bun install`, schema changes, or to resolve TypeScript type issues):
```bash
bunx prisma generate
```

## Configuration

Write your own configuration based on `config.example.json`
```bash
cp config.example.json config.json
```

### Overview

This configuration file is used to set up and customize the service. It consists of four main sections: `options`, `signers`, `alerts`, and `networks`.

#### Options

* `env`: The environment in which the service is running. Can be `"production"`, `"development"` or `"development:indexer"`. The indexer only runs in `"production"` and `"development:indexer"`; in any other environment it is paused on every network (no RPC polling, no event storage, no `IndexerData` writes). `"development:indexer"` otherwise behaves exactly like `"development"`. (required)
* `port`: The port number where the server will run. (required)
* `indexerAlert`: Specifies the alert id to use for the alert system. (required)
* `trustProxy`: Specifies whether the app is sitting behind a proxy and trusts this proxy. (optional, default: true)
* `skipFirstAccountSetupAlert`: When set to `true`, suppresses the first alert for `GuardianAdded` or `ChangedThreshold` events if the account has no previously indexed events on the current chain. This avoids noisy alerts during initial account setup. (optional, default: `false`)
* `sentryDSN`: Optional field for [sentry](sentry.io) logging purposes. (optional)
* `moduleFallbackDeprecation`: ISO 8601 date (e.g. `"2026-11-15"`) since which a request that names no recovery module is deprecated. Once set, such requests are answered with a `Deprecation` header ([RFC 9745](https://www.rfc-editor.org/rfc/rfc9745)). (optional)
* `moduleFallbackSunset`: ISO 8601 date announced as the end of requests that name no recovery module. Once set, such requests are answered with a `Sunset` header ([RFC 8594](https://www.rfc-editor.org/rfc/rfc8594)). The header only announces the date: the service keeps serving such requests after it, until the operator removes `fallback: true` from the network's modules (see [Recovery modules in requests](#recovery-modules-in-requests)). Must be later than `moduleFallbackDeprecation`. (optional)
* `authentication`: A secret every request must carry: `{"apiKey": "..."}` (in the path) or `{"bearerToken": "..."}` (in the `Authorization` header), never both. Omitted or `~`: no authentication. See [Authentication](#authentication). (optional)
* `counterfactualAccounts`: What the service does with accounts that are not deployed yet (see [Counterfactual accounts](#counterfactual-accounts-erc-6492)). Omitted, `null` or `~`: `{"erc6492": true, "storeInitData": "never"}`, the behavior before this option existed. (optional)
	+ `erc6492`: `true` or `false` (also `"true"` / `"false"` in any case). With `false`, every signature wrapped with ERC-6492 is refused, deployed account or not. Default `true`.
	+ `storeInitData`: `"never"`, `"with-guardian"` or `"always"`: whether a registration of an undeployed account keeps its deployment call (see [Init data of undeployed accounts](#init-data-of-undeployed-accounts)). Default `"never"`.
	+ Any other key, any other value, or `storeInitData` other than `"never"` with `erc6492: false` fails the boot. The values are logged once at boot (`counterfactual accounts configured`).

#### Signers

* A list of signer objects, each with a unique `id`.
* Each signer can have one of two types of configurations:
	+ `privateKey`: A private key for signing.
	+ `awsKMS`: An AWS Key Management Service ([KMS](https://aws.amazon.com/kms/)) configuration, which includes:
		- `accessKeyId`: The AWS access key ID.
		- `secretAccessKeyId`: The secret access key ID.
		- `region`: The AWS region.
		- `kmsKeyId`: The KMS key ID.

#### Alerts

* A list of alert objects, each with a unique `id`.
* Each alert can have one or multiple channels configured:
	+ `email`: Can be configured using either:
		- `smtp`: With `from`, `host`, `port`, `secure`, and `auth`.
            * `smtp` authentication can be done using either:
                + `oauth2`: Requires `user` and `accessToken`.
                + `login`: Requires `user` and `password`.
		- `webhook`: With a webhook `endpoint` and an optional `authorizationHeader`.
	+ `sms`: Can be configured using either:
		- `twilio`: With `accountSid`, `authToken`, and `fromNumber` settings in [Twilio](https://www.twilio.com).
		- `webhook`: With a webhook `endpoint` and an optional `authorizationHeader`.
* For channels that are configured with webhook, webhooks will get called either with a POST request or a GET request
  - `POST webhook.endpoint` webhook service is responsible to deliver the message to the target specified, example requests payloads:
  	- `{channel: "email", taget: target, subject: subject, ["html" or "text"]: message}`
    - `{channel: "sms", target: target, text: message}`
    - Response should be a status code between 200-299, which should indicate that the message was sent successfully.
  - `GET webhook.endpoint` used to check the health and availability of the webhook service, the request will contain a query parameter `channel=email or sms`, response can be any status code between 200-299

#### Networks

* A list of network objects, each with a unique `id`.
* Each network can have the following settings:
	+ `enabled`: A boolean indicating whether the network is enabled.
	+ `chainId`: Number of chain ID of the network.
	+ `jsonRpcEndpoint`: The JSON-RPC endpoint of the network.
	+ `recoveryModules`: The Social Recovery Module deployments this network serves and indexes. Each entry has:
	  * `address`: The module address. It must be one of the [supported recovery modules](#supported-recovery-modules); any other address fails at boot.
	  * `fallback`: Optional, `true` on at most one v0.1.0 module. Requests that do not name a module (see [Recovery modules in requests](#recovery-modules-in-requests)) use it, and `/v1/config/getNetworkConfig` returns it as `moduleAddress`. Requests can name any listed module, but only modules with `indexer.enabled: true` are indexed and alerted on. A network without a fallback requires `moduleAddress` on `create`, `signature/request`, `fetchByAddress` and `listByAddress`.
	  * `indexer`: Specifies whether the indexer covers this module, and the first indexing block for its first run
	    - `enabled`: A boolean indicating whether this module is indexed.
	    - `startBlock`: A number that specifies from which block the indexer starts indexing this module (should be the block at which the module was deployed). Note: this value is ignored once the module has a recorded last indexed block. A module added to a running service is indexed from this block, and alerts are sent for the events found on the way.
	+ `recoveryModuleAddress` (legacy): A network with a single module can set this field and a network-level `indexer` block (same fields as above) instead of `recoveryModules`. The module is then the network's fallback. A network uses one shape or the other, not both. A database indexed by a version without `recoveryModules` must be started once on this legacy field, set to the module indexed so far: only it says which module the existing indexed rows came from. Until then, a network configured with `recoveryModules` refuses to start indexing. The same holds for recovery and custodial signature requests made before requests named their module: at boot they are assigned to the legacy field's module, and with `recoveryModules` the service exits while any of them is unassigned.
	+ `executeRecoveryRequests`: Controls whether the service will execute the recovery after all required signatures are collected. It has a `enabled` boolean field, and requires the `id` of a `signer` to be specified if enabled.
      + `rateLimit`: Controls the rate limiting for recovery executions by the service (omitted or `~` if no rate limit)
        * `maxPerAccount`: The maximum number of recovery executions allowed per account within the specified period.
        * `period`: The time period for which the rate limit is applied.
	+ `finalizeRecoveryRequests`: Controls whether the service will finalize the recovery after the grace period is over. It has a `enabled` boolean field, and requires the `id` of a `signer` to be specified if enabled.
	  + `rateLimit`: Controls the rate limiting for recovery finalizations by the service (omitted or `~` if no rate limit)
        * `maxPerAccount`: The maximum number of recovery finalizations allowed per account within the specified period.
        * `period`: The time period for which the rate limit is applied.
	+ `alerts`: Optionally specifies the alert to use for this network with with an alert `id`.
	+ `multicall3`: Optional, the Multicall3 address used to verify ERC-6492 signatures of accounts that are not deployed yet (see [Counterfactual accounts](#counterfactual-accounts-erc-6492)). Defaults to the canonical `0xcA11bde05977b3631167028862bE2a173976CA11`; must be a valid address.
	+ `deployAccounts`: Optional, lets the service pay for deploying an account that registered before it was deployed, from the init data it kept (see [Sponsored deployment](#sponsored-deployment-of-undeployed-accounts)). Omitted, `null`, `~` or `"enabled": false`: no sponsorship, and nothing else in the block is read but its key names.
	  * `enabled`: `true` to sponsor deployments on this network.
	  * `signer`: The `id` of the signer that pays (required when enabled). It must be declared in `signers`.
	  * `factories`: The factories whose calls the service pays for (required when enabled): a non-empty list of distinct, non-zero addresses. An account whose stored `_factory` is not listed is not deployed.
	  * `requireGuardian`: Whether the deployment must install this network's guardian on one of its modules, checked in simulation right before paying. Default `true`.
	  * `maxGas`: The highest gas limit a deployment may be sent with. Default `1000000`. The service refuses a deployment whose estimate, raised by 25 %, is above it, and the chain executor never sends one with a higher limit.
	  * `rateLimit`: Omitted or `~` for no limit; else `period` (e.g. `"1d"`, required) and at least one of `maxPerTarget` (deployments per verified email address or phone number) and `maxTotal` (deployments on the network), over the rolling period.

	  Booleans and numbers may also be given as strings (what `${ENV::VAR}` yields). The boot fails on:

	  | Setting | Fails when |
	  | --- | --- |
	  | the block | not an object, `~` or `null`; a key other than the six above |
	  | `enabled` | neither a boolean nor `"true"` / `"false"` |
	  | `signer` | missing or empty when enabled, or not a declared signer |
	  | `factories` | not a non-empty list, an entry that is not an address, the zero address, or an address listed twice (any case); the message names the entry's index |
	  | `requireGuardian` | not a boolean |
	  | `maxGas` | not a positive integer |
	  | `rateLimit` | not an object or `~`; no `period`, a `period` that does not parse or is zero; no `maxPerTarget` and no `maxTotal`; a limit that is not a positive integer; another key |
	  | the network | has no `guardian`: nothing registers without one, so no init data is stored |

	  And warns at boot (the service starts): `account deployment signer is also the guardian` (allowed, but a dedicated signer keeps the guardian's key and its transaction queue apart), `account deployment sponsorship has no rate limit`, and `account deployment sponsorship enabled but no init data is stored` (`options.counterfactualAccounts.storeInitData` is `"never"`: init data stored under an earlier setting can still be deployed). Each enabled network logs `account deployment sponsorship configured` once, with `signerId`, `factoryCount`, `requireGuardian`, `maxGas` and `rateLimit`.

##### Supported recovery modules

Each variant has the same address on every network. The service takes a module's version and recovery period from this list, and after startup compares the code deployed at each configured address with its pinned code hash, logging an error on a mismatch. The v0.1.0 modules return `"0.0.1"` from `VERSION()`.

| Version | Recovery period | Address |
| --- | --- | --- |
| v0.1.0 | 3 minutes | `0x949d01d424bE050D09C16025dd007CB59b3A8c66` |
| v0.1.0 | 3 days | `0x38275826E1933303E508433dD5f289315Da2541c` |
| v0.1.0 | 7 days | `0x088f6cfD8BB1dDb1BB069CCb3fc1A98927D233f2` |
| v0.1.0 | 14 days | `0x9BacD92F4687Db306D7ded5d4513a51EA05df25b` |
| v0.2.0 | 3 minutes | `0x4dF6081A82E07A7cD99aEf91C72d12a5138e468B` |
| v0.2.0 | 3 days | `0x00480F5ecC008995469fA7e12c70Ef3DC9FEe7fD` |
| v0.2.0 | 7 days | `0xEaC444E2F28469E641215F129874Aff8294cAfE0` |
| v0.2.0 | 14 days | `0x4d92D03a47468d9FC62495d85E3F205b4616FC5c` |

> [!WARNING]
> The 3-minute variants are for testnets only. The service cannot tell a testnet from a mainnet, so never list them on a mainnet network.

> [!TIP]
The config file supports loading values from `.env`. Use `${ENV::VAR_NAME}` anywhere inside a string value and the named environment variable will be substituted in at boot. Examples: `"privateKey": "${ENV::PRIVATE_KEY}"` loads the whole field from the env variable, while `"jsonRpcEndpoint": "https://rpc.example.com/${ENV::RPC_API_KEY}"` only substitutes the key segment. Multiple substitutions in one string are supported. Missing env variables throw at boot.
> 

## Authentication

`options.authentication` restricts the service to the clients that hold a secret, ahead of the SIWE checks of each endpoint. One of the two can be set:

* `apiKey`: the key is the first path segment of every URL, e.g. `POST /<apiKey>/v1/auth/register` or `GET /<apiKey>/v1/config/getNetworkConfig`. Any other first segment is answered with a 401 (`Invalid API key`), so is a request that leaves the key out (`/v1/...`).
* `bearerToken`: every request under `/v1` needs an `Authorization: Bearer <bearerToken>` header (the scheme in any case). Without one the service answers 401 `Bearer token required`, with a wrong token 401 `Invalid bearer token`, both with a `WWW-Authenticate: Bearer` challenge ([RFC 6750](https://www.rfc-editor.org/rfc/rfc6750)).

The value needs at least 16 characters: letters, digits, `-`, `.`, `_` and `~` for an API key, plus `+`, `/` and trailing `=` for a bearer token (e.g. `openssl rand -hex 32`). Load it with `${ENV::VAR_NAME}` rather than writing it into `config.json`. It is compared in constant time and never logged: request log lines show the key segment as `:apiKey` (also when it is wrong), and Sentry events redact the key, literal or percent-encoded. Proxies and load balancers in front of the service log URLs, though, so an API key ends up in their access logs; prefer the bearer token when the clients can set headers.

CORS preflight requests (`OPTIONS`) are answered without the secret, since browsers send them without credentials. A change of secret takes a restart.

## Recovery modules in requests

A network can serve several recovery modules, and a Safe can have more than one enabled while it moves its guardians from v0.1.0 to v0.2.0. A recovery hash, and every guardian signature over it, is valid on one module only (its EIP-712 domain holds the module address), so each recovery flow is bound to one module.

* The requests that start a flow take an optional `moduleAddress`: `POST /v1/recoveries/create` and `POST /v1/auth/signature/request`. It must be one of the network's configured modules (see `modules` in `GET /v1/config/getNetworkConfig`), else the request fails with a 400. The module is saved on the request.
* The later steps use the module saved on the request and do not accept `moduleAddress`: `POST /v1/recoveries/sign`, `/execute`, `/finalize` and `POST /v1/auth/signature/submit`. `GET /v1/recoveries/fetchById` returns the request's `moduleAddress` and its `recoveryHash`.
* The reads `GET /v1/recoveries/fetchByAddress` and `/listByAddress` take an optional `moduleAddress` and return the requests made on that module only. Every module starts each account's recovery nonce at 0, so requests made on different modules can share a nonce.
* `GET /v1/config/getNetworkConfig` lists every configured module as `modules: [{address, version, recoveryPeriod}]` (`recoveryPeriod` in seconds). `moduleAddress` remains the network's fallback module.

When `moduleAddress` is omitted, the network's fallback module is used, as before. This default is deprecated: such responses carry the `Deprecation` and `Sunset` headers once `options.moduleFallbackDeprecation` and `options.moduleFallbackSunset` are set (both exposed to browser clients), and each use is logged (`moduleFallback: true`). The headers only announce the dates: the service does not reject such requests after the Sunset date. The operator ends the fallback by removing `fallback: true` from the network's `recoveryModules` (a legacy `recoveryModuleAddress` is always the fallback), after which `create`, `signature/request`, `fetchByAddress` and `listByAddress` require `moduleAddress` and fail with a 400 without it. The later steps keep using the module saved on the request. Reads without `moduleAddress` return the fallback module's requests only.

`create` and `signature/request` check, for the module named or the fallback:

* the account is a deployed Safe. An account with no code (not deployed yet) is answered with a 400 that tells it apart and says whether the service can deploy it ([Sponsored deployment](#sponsored-deployment-of-undeployed-accounts)):
  ```json
  {"code": 400, "message": "Account 0x… is not deployed on this network (11155111)", "details": {"reason": "account-not-deployed", "sponsoredDeployment": true}}
  ```
  `sponsoredDeployment` is `true` when the network sponsors deployments and the account's stored init data names a sponsored factory. An account with code that is not a Safe is answered `Account address is not a safe smart contract account`, as before, and so is an account whose code cannot be read;
* the module is enabled on the Safe and holds guardians for it; otherwise the response says to pass the `moduleAddress` of the module that holds them. A disabled module keeps its stored guardians, so both are checked;
* the proposed owners can be set by the module: none is the zero address, `0x0000000000000000000000000000000000000001`, the Safe itself or one of its guardians on that module, and none is listed twice. v0.1.0 used to accept such proposals but could never finalize them; they are now rejected for both versions;
* with no `moduleAddress`, a `create` signature that is not valid for the fallback but is valid for another configured module fails with an error naming that module.

An empty signature (`0x`) is accepted on v0.2.0 modules only, where it is checked with EIP-1271 (a Safe guardian that approved the recovery hash). v0.1.0 cannot execute it, so it is rejected there.

**Migrating clients:** read `modules` from `/v1/config/getNetworkConfig`, sign the recovery hash of the module the Safe uses (its `getRecoveryHash`, at that module's `nonce`), and send that module as `moduleAddress` to `create`, `signature/request`, `fetchByAddress` and `listByAddress`.

**Migrating a deployment:** apply the database migrations (`bunx prisma migrate deploy`). Requests made before this version have no module; at boot they are assigned to the module of a legacy `recoveryModuleAddress` config (see [Networks](#networks)).

## Counterfactual accounts (ERC-6492)

A Safe can register auth methods and subscribe to alerts before it is deployed. The client wraps the request's `signature` with [ERC-6492](https://eips.ethereum.org/EIPS/eip-6492): `abi.encode(address factory, bytes factoryCalldata, bytes signature)` followed by the 32-byte magic suffix `0x6492649264926492649264926492649264926492649264926492649264926492`, where `factory` and `factoryCalldata` are the call that deploys the Safe (for a Safe, its `SafeProxyFactory.createProxyWithNonce` call). No other request field changes.

* **Auth** (`POST /v1/auth/register`, `GET /v1/auth/registrations`, `POST /v1/auth/delete`, `POST /v1/auth/metadata`): standard ERC-6492. The SIWE `address` is the Safe, and the inner signature is the Safe signature a deployed Safe would give (the owners' signatures of the SafeMessage, up to the threshold). The service deploys the Safe in simulation and calls its `isValidSignature`, so the Safe's threshold applies.
* **Alerts** (`POST /v1/alerts/subscribe`, `GET /v1/alerts/subscriptions`, `POST /v1/alerts/unsubscribe`): the SIWE `address` is an owner and the inner signature is that owner's SIWE signature, as for a deployed Safe, but the wrapper's deployment data describes the **account** (the request's `account`, or the subscription's for `unsubscribe`), not the signer. The service reads the owners of the simulated deployment and requires the signer to be one of them.

The recovery endpoints (`/v1/recoveries/*`) do not accept wrapped signatures: the module checks guardian signatures on chain with EIP-1271, which needs a deployed contract. `POST /v1/auth/signature/request` and `/submit` carry no signature and need the Safe deployed with the module enabled and the service's guardian added, so a registration made before deployment can be used once that is done. A user who lost the wallet before deploying can have the service deploy the account (see [Sponsored deployment](#sponsored-deployment-of-undeployed-accounts)).

Rules:

* A signature without the suffix is checked exactly as before.
* `options.counterfactualAccounts.erc6492: false` refuses every signature that ends with the suffix, on every endpoint above, whether or not the account is deployed, before the wrapper is decoded and with no chain call. The SIWE message's nonce stays free, so the same message can be sent again with an unwrapped signature.
* Once the account has code, the deployment data is ignored and the inner signature is checked against the deployed account, so a client may keep sending wrapped signatures after deployment.
* The check is one `eth_call` to Multicall3's `aggregate3` (the factory call, then `isValidSignature` or `getOwners` on the account in the state the factory call left). Nothing is broadcast. Multicall3 is expected at `0xcA11bde05977b3631167028862bE2a173976CA11` unless the network sets `multicall3`. On a network where it is not deployed, wrapped signatures of undeployed accounts are rejected (deployed accounts keep working), and a warning is logged after boot (`counterfactual accounts unsupported`).
* The deployment data is chosen by the client: a factory can only deploy at addresses derived from itself, so deployment data that is not the account's own cannot put code (or owners) at its address, and the request fails.

Deviations from ERC-6492:

1. On the alerts endpoints, the deployment data describes the account while the inner signature belongs to the SIWE address (an owner). A standard ERC-6492 verifier would reject such a signature; it is specific to these endpoints.
2. No "prepare" call: when the account already has code, the factory call is not run, not even in simulation.
3. No nesting: the inner signature is never unwrapped again, so an owner that is itself an undeployed contract is not supported.
4. The verifier is Multicall3, not the EIP's `ValidateSigOffchain` deployless contract (same result for these two calls).

Errors:

| Status | Message | When |
| --- | --- | --- |
| 400 | `ERC-6492 signatures are not accepted by this service` | the signature ends with the magic suffix and `options.counterfactualAccounts.erc6492` is `false` |
| 400 | `SIWE Message: malformed ERC-6492 signature` | the signature ends with the magic suffix but does not decode |
| 400 | `ERC-6492 signatures are not supported on this network (<chainId>): Multicall3 is not deployed at <address>` | the account is not deployed and the network has no Multicall3 |
| 400 | `SIWE Message: the ERC-6492 deployment data does not deploy <account> on chain <chainId>` | auth: the factory call reverts, or leaves no code at the account |
| 403 | `SIWE Message: invalid signature, ...` | auth: the simulated Safe rejects the signature (e.g. fewer owner signatures than its threshold); alerts: the inner signature is not the SIWE address's |
| 400 | `Unable to fetch owners for account '<account>' on chain <chainId>: the account is not deployed. Wrap the signature ...` | alerts: the account has no code and the signature is not wrapped |
| 400 | `Unable to fetch owners for account '<account>' on chain <chainId>: the ERC-6492 deployment data does not deploy it` | alerts: the factory call reverts, or the account gives no owners after it |
| 400 | `Unable to fetch owners for account '<account>' on chain <chainId>: it does not answer getOwners()` | alerts: the deployed account is not a Safe |
| 403 | `Owner must be a valid owner for the account provided` | alerts: the SIWE address is not an owner of the account |

Building the wrapper with abstractionkit and ethers v5:

```ts
const [factory, factoryCalldata] = SafeAccountV0_3_0.createFactoryAddressAndData(owners, {threshold});
// auth: `signature` is the Safe signature over the SIWE message (getSafeMessageEip712Data, each owner's
//       _signTypedData, then SafeAccountV0_3_0.buildSignaturesFromSingerSignaturePairs)
// alerts: `signature` is the owner's signMessage(siweMessage.prepareMessage())
const wrapped = ethers.utils.hexConcat([
  ethers.utils.defaultAbiCoder.encode(["address", "bytes", "bytes"], [factory, factoryCalldata, signature]),
  "0x6492649264926492649264926492649264926492649264926492649264926492",
]);
```

`GET /v1/auth/registrations` and `GET /v1/alerts/subscriptions` take `signature` in the query string. A wrapped signature for a two-owner Safe with abstractionkit's default setup is about 2 KB of hex, well under the usual header limits (Node's default is 16 KB), but a Safe with a very large initializer may not fit. Accepting `POST` for these two reads is a possible follow-up.

Apart from the init data below, nothing is stored about how a registration or subscription was made: the log lines `auth registration requested`, `auth registration created` (with a verified-target token), `auth account metadata updated`, `alert subscription created` and `alert subscription removed` carry `accountDeployed`.

### Init data of undeployed accounts

An account that registers before it is deployed has an address nobody can deploy once the wallet that made it is lost: the factory call that creates it is gone with the wallet. When `options.counterfactualAccounts.storeInitData` allows it, `POST /v1/auth/register` keeps the deployment call it just verified in simulation, the `factory` and `factoryCalldata` of the ERC-6492 wrapper, as two reserved keys of the account's [metadata](#account-metadata):

* `_factory`: the factory address, checksummed.
* `_factoryData`: the calldata of the factory call, lower-case `0x` hex.

They are the ERC-6492 deployment call: calling `_factory` with `_factoryData` deploys the account. For a Safe built as above it is a plain `SafeProxyFactory.createProxyWithNonce` call, which also fits a UserOperation's `factory` / `factoryData`; other deployment data fits a UserOperation only when its factory returns the account's address. The account lookup (`POST /v1/auth/accounts`) and `GET /v1/auth/registrations` return them, so a wallet can deploy the account and start a recovery. No request field is added and no response changes: a wallet sees whether its init data was kept in `GET /v1/auth/registrations` (`metadata._factory`).

What is kept, the first rule that matches winning:

| `storeInitData` | Registration | Kept | Log fields |
| --- | --- | --- | --- |
| `never` | any | nothing | none |
| any | deployed account, or unwrapped signature | nothing | none |
| any | `factoryCalldata` over 16384 bytes | nothing | `guardianInstalled`, `initData: "too-large"` |
| `with-guardian` | deploying does not install the guardian | nothing | `guardianInstalled: false`, `initData: "no-guardian"` |
| `with-guardian` | deploying installs the guardian | the two keys | `guardianInstalled: true`, `guardianModule`, `initData: "kept"` |
| `always` | either | the two keys | `guardianInstalled` as found, `guardianModule` when found, `initData: "kept"` |

* **The guardian check** runs in the same `eth_call` as the signature check, after the factory call: for each of the network's modules, in config order, the account's `isModuleEnabled(module)` and the module's `isGuardian(account, guardian)`, where the guardian is the address the registration is bound to (`guardianAddress`). The guardian is installed when both answer `true` for one module. The init code is never decoded. It runs only when `storeInitData` is not `"never"`, so under `"never"` the log lines have none of these fields.
* **The registration is accepted either way.** Init data that is not kept never removes keys stored before. A later registration of the account, still undeployed, replaces both keys with the data it verified. The keys stay after the account is deployed, and go with the account's last registration on the chain, as all metadata does.
* **With a code**, the init data waits with the pending request (as the app's metadata does) and is written when `POST /v1/auth/submit` answers the registration (`auth registration created` with `verification: "otp"`, `auth registration already exists` and `auth registration submitted again` then carry `initData: "kept"`). An account deployed between `register` and `/submit` still gets its keys written. A request whose code is never submitted keeps its copy in the database, up to about 33 KB of hex.
* **With a `verifiedTargetToken`**, the init data is written right after the registration. A `register` for a target that is already registered still answers 409; sent with a `verifiedTargetToken`, it first stores the init data it carries, under the same rules (`auth registration init data stored`). That repairs a `register` that failed between the two writes: send it again with the token and a newly signed SIWE message (the first message is refused for its nonce). Without a token, a 409 writes nothing.
* The log lines never carry `_factory`, `_factoryData` or the signature; `guardianModule` is a configured, public module address.

`GET /v1/config/getNetworkConfig` tells a wallet what to expect on a network:

```json
{"name": "sepolia", "chainId": 11155111, "guardianAddress": "0x...", "counterfactualAccounts": {"erc6492": true, "storeInitData": "with-guardian"}, "...": "..."}
```

* `guardianAddress`: the address of the network's guardian, checksummed; absent on a network without one. A signer whose address cannot be read answers 500, as `register` does.
* `counterfactualAccounts.erc6492`: the configured switch, and `false` once the service knows Multicall3 is missing on the network. The endpoint makes no RPC call, so it can read `true` for a moment after boot on such a network.
* `counterfactualAccounts.storeInitData`: the configured policy when `erc6492` above is `true` and the network has a guardian, else `"never"`.

**Wallets.** To be recoverable before it is deployed, an account's initializer must install the guardian itself: under `"with-guardian"`, nothing else is kept, and an account built with abstractionkit's default initializer (which enables the 4337 module only) registers with `guardianInstalled: false`. The expected way is the delegate call of Safe's `setup()` (`setupModules()`) to a contract of the wallet's choosing that enables the recovery module and adds the guardians for `address(this)`. The service does not provide that contract and does not need to know it: it only reads the state the deployment leaves. The guardian's address, from `getNetworkConfig`, is part of the account's address from then on. Before using the keys:

* Read `eth_getCode` first, and ignore the keys once the account has code. They were verified once, at registration: calling `_factory` with `_factoryData` then put code at this address that accepted the account's signature (and, under `"with-guardian"`, had this guardian on a configured module). Nothing checks it again.
* Match `_factory` against the factories you know before calling it. CREATE2 binds an address to its factory, so the data can only deploy the registrant's own account, but the factory is the registrant's choice. Only the account can write the keys: the write needs a request signed by the account, verified by simulating that very deployment.
* The keys are written by the service, unlike the app's keys: the guidance that metadata is a name the app stored, not a statement by the service, holds for the app's keys only.
* The init data shows the owner set (or a passkey's public key) before it is on chain, to whoever proves a registered target and to the operator, who stores it in plaintext.

**Operators.** The service stores and returns the data, and deploys an account from it only when the network sponsors deployments and lists the account's factory (`deployAccounts`, see [Sponsored deployment](#sponsored-deployment-of-undeployed-accounts)). Turning `erc6492` off locks undeployed accounts that already registered out of `registrations`, `delete` and `metadata` until they are deployed. Changing `storeInitData` purges nothing: under `"never"` no new keys are written, and the stored ones stay and are still returned. The guardian's address is part of such an account's init data, so changing a network's guardian signer leaves undeployed accounts installing the old one (they then register with `guardianInstalled: false`), and an account has the same address on two networks only if its initializer is the same on both: one that installs the network's guardian alone needs both networks to use the same guardian. Registrations made before this version have no init data; an account that is still undeployed gets it by sending `register` again with a `verifiedTargetToken` (the 409 above).

### Sponsored deployment of undeployed accounts

A user who lost the wallet before the account's first transaction gets its init data back from the account lookup, but cannot recover: `signature/request` and `recoveries/create` read the account on chain, and the user's new key has no funds to deploy it. When a network sets `deployAccounts` (see [Networks](#networks)), the service pays for that deployment: it sends the stored `_factory` call with the configured signer, for the holder of a `verifiedTargetToken` whose target is registered for the account on that chain. No wallet signature is needed, since the owner key may be lost.

**Recovering an account that was never deployed:**

1. Verify the email address or phone number: `POST /v1/auth/verification/request`, then `/submit` with the code, for a `verifiedTargetToken` (valid 10 minutes).
2. Look the account up: `POST /v1/auth/accounts` answers its `account`, `chainId` and `metadata`, with `_factory` / `_factoryData` when its init data was kept.
3. If `eth_getCode` of the account is empty, ask for the deployment: `POST /v1/auth/accounts/deploy`. `signature/request` answers the not-deployed error with `details.sponsoredDeployment` telling whether this will work (see [Recovery modules in requests](#recovery-modules-in-requests)).
4. Wait for it: poll `GET /v1/auth/accounts/deployment` (or `eth_getCode`) until `status` is `deployed`. A `pending` answer can take minutes on a congested chain.
5. Start the recovery as for any deployed account: `POST /v1/auth/signature/request` with the new owners, the codes to `/v1/auth/signature/submit`, then the recovery request.

#### `POST /v1/auth/accounts/deploy`

```json
{"account": "0x…", "chainId": 11155111, "verifiedTargetToken": "<token>"}
```

Sent with `Cache-Control: no-store`:

```json
202 {"account": "0x…", "chainId": 11155111, "status": "pending"}
200 {"account": "0x…", "chainId": 11155111, "status": "deployed", "transactionHash": "0x…"}
```

`account` is lower case, as in the lookup. `transactionHash` is present when this service's transaction deployed the account; an account deployed some other way answers `deployed` without it, and no deployment is recorded for it. Calling the endpoint again while a deployment is pending answers `pending` and sends nothing; calling it after a failure starts the next attempt. An account is not tried again, on that chain, ever, after three attempts that were mined and failed (`reverted`, `no-code`: they spent the signer's gas), or after ten attempts in all (attempts that were never mined, `interrupted` or `expired` for instance, count toward these ten only).

The checks run in this order, the first that matches answering; nothing is sent on a refusal, and nothing is read on chain before the account's code:

| Status | `details.reason` | Message | When |
| --- | --- | --- | --- |
| 403 | `sponsorship-disabled` | `Deployment sponsorship is not enabled for this network (<chainId>)` | the network does not set `deployAccounts` (checked before the token) |
| 403 | (none) | `Invalid or expired verifiedTargetToken` | the token is unknown or expired |
| 403 | `not-registered` | `This verifiedTargetToken's target is not registered for this account on this chain` | no registration of the token's channel and target for the account on this chain |
| 200 | | | the service deployed the account (its hash), or the account has code (then a pending or failed deployment of it is recorded as deployed) |
| 202 | | | a deployment is pending (a pending one older than three hours is taken as interrupted, and this request makes the next attempt) |
| 409 | `attempts-exhausted` | `The sponsored deployment of this account failed on chain 3 times; it will not be tried again` | three attempts were mined and failed |
| 409 | `attempts-exhausted` | `The sponsored deployment of this account was attempted 10 times; it will not be tried again` | ten attempts in all |
| 409 | `no-init-data` | `No init data is stored for this account on this chain` | no `_factory` / `_factoryData` in the account's metadata |
| 403 | `factory-not-sponsored` | `The factory of this account is not sponsored on this network (<chainId>)` | `_factory` is not in `deployAccounts.factories` |
| 429 | `limit-target` | `You are only allowed <n> sponsored deployments every <period>` | the token's target reached `maxPerTarget` |
| 429 | `limit-total` | `Sponsored deployments are used up on this network for now, try again later` | the network reached `maxTotal` |
| 409 | `sponsorship-unavailable` | `Sponsored deployments are temporarily unavailable on this network (<chainId>)` | Multicall3 is not deployed on the network |
| 409 | `deployment-would-fail` | `The init data stored for this account does not deploy it on this chain` | in simulation the factory call reverts or leaves no Safe at the account; called from the paying signer it reverts or names another address; or its gas estimate reverts |
| 403 | `no-guardian` | `Deploying this account does not install this service's guardian` | `requireGuardian` and, in simulation, no configured module has the guardian |
| 403 | `gas-limit` | `Deploying this account needs more gas than this network sponsors` | the estimate raised by 25 % is above `maxGas` |
| 503 | `sponsorship-unavailable` | `Sponsored deployments are temporarily unavailable on this network (<chainId>)` | the fee source fails, or the signer's balance does not cover the gas limit at the current maximum fee |
| 202 | | | the deployment is queued |

No message quotes the factory, the calldata or the target. The simulation is the one of [Counterfactual accounts](#counterfactual-accounts-erc-6492) (one `eth_call` to Multicall3: the factory call, then `getThreshold()` on the account and the guardian check of the init data), run again at the time of paying.

#### `GET /v1/auth/accounts/deployment`

`?account=0x…&chainId=11155111`, no credential, sent with `Cache-Control: no-store`:

```json
200 {"account": "0x…", "chainId": 11155111, "status": "failed", "failureReason": "would-revert", "attempts": 1, "requestedAt": "2026-11-25T10:00:00.000Z"}
404 {"code": 404, "message": "No sponsored deployment was requested for this account on this chain"}
```

`status` is `pending`, `deployed` or `failed`; `transactionHash` is there once mined (for `failed`, the hash of a mined revert); `failureReason` is one of `would-revert`, `retries-exhausted`, `expired`, `reverted`, `gas-limit-exceeded`, `interrupted` (the service stopped while it was pending) and `no-code` (mined without reverting, but still no code at the account after five reads over 15 seconds, so that a node behind the others is not taken for a failure). `attempts` is the number of attempts so far. It exists because the token lives 10 minutes and a deployment can take longer, and because `eth_getCode` cannot show a failure. Anyone who knows the address can read it; it shows that a deployment was asked for through this service, its state and its hash. A client starts a new attempt with the `POST`, with a token.

#### Limits

Over the rolling window `rateLimit.period`, per network:

* `maxPerTarget`: the deployments asked for with tokens of this channel and target;
* `maxTotal`: the deployments on the network.

Both count accounts, whatever the outcome: a failed attempt keeps its slot (failures that cost gas must not be free), and the account being asked for is left out, so retrying it never counts twice. The count that admits a deployment and its claim are made in one database transaction holding a lock for the network (a Postgres advisory lock), so requests sent at once, to one process or several on the same database, never admit more deployments than the limits allow, and a request refused for a limit leaves nothing that counts. A first count before the chain checks refuses most requests over a limit early. A reached total limit is logged as a warning (`sponsored deployment limit reached`, `limit: "total"`), a per-target one at info.

#### Errors with `details`

An error response is `{"code", "message"}`. Errors a client is expected to act on also carry `details`, an object with at least `reason`: the refusals of `POST /v1/auth/accounts/deploy` above, and the not-deployed error of `create` and `signature/request`. Tell them apart by `details.reason`, not by the message. Every other error is answered as before.

#### `getNetworkConfig`

`sponsorships.deployment` tells a wallet, before it registers, whether its factory will be sponsored:

```json
"sponsorships": {"execution": {"enabled": false}, "finalization": {"enabled": false}, "deployment": {"enabled": true, "factories": ["0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67"], "requireGuardian": true, "rateLimit": {"maxPerTarget": 2, "maxTotal": 50, "period": 86400}}}
```

`enabled` is the configured switch, and `false` once Multicall3 is known to be missing on the network (no RPC call is made). Disabled, it is `{"enabled": false}`. `factories` are checksummed; `period` is in seconds; `rateLimit` is absent without one.

**Wallets.** Read `sponsorships.deployment.factories` before choosing a factory: init data with another factory is never deployed by the service. Poll the `GET` (or `eth_getCode`) after asking; a `pending` answer can take minutes. The service deploys exactly the stored call, so whatever it installs (the guardian among it) is what the account gets.

**Operators.**

* Fund the paying signer and watch its balance: a request it cannot pay for is refused with a 503 and an error line (`sponsored deployment signer underfunded`, with the address, the balance and the estimated cost).
* Use a dedicated signer. It shares a transaction queue with any execution or finalization signer of the same `id` on the network, and a stuck deployment delays what is queued behind it.
* **List only factories you know, whose result does not depend on the caller: the service's key calls every listed factory with calldata the registrant chose.** The factory fixes the contract that is called, not the singleton or the initializer inside the call, which run arbitrary code (the usual way to install the guardian is a delegate call from Safe's `setup()`). What bounds the cost is `maxGas` (enforced by the chain executor on the transaction, whatever the estimate said), three mined failures per account, the limits and the token. Before paying, the service simulates the deployment again, and calls the factory from the paying signer: a factory that answers another address for that sender is refused. A factory whose address depends on its caller in a way the answer does not show is caught after mining (`no-code`), after one paid attempt.
* Someone who deploys the account between the estimate and mining makes the transaction revert on the address collision, using most of its gas: that is one of the account's three mined failures.
* The limits count accounts, failures included.
* The service is single-instance: the claim and the limits hold across processes on one database, but the queue is in memory, and at boot every deployment still pending from the previous run is checked: deployed if the account has code, else failed as `interrupted` (log line `orphaned sponsored deployments released`, with the counts).
* Accounts registered while no init data was kept cannot be deployed by the service; there is no backfill.
* Deploying puts the owner set on chain earlier than the user would have; the request needs a verified, registered target.

The log lines (`component: "sponsored-deployment"`) are `sponsored deployment requested`, `refused`, `limit reached`, `signer underfunded`, `confirmed`, `found deployed`, `failed`, `left no code` and `orphaned sponsored deployments released`. They carry the deployment's id, the account, the chain, the signer id, the token's `verificationId`, the attempt and the outcome; never `_factory`, `_factoryData`, the target or the token.

**Migrating a deployment:** apply the database migrations (`bunx prisma migrate deploy`): they add the `SponsoredDeployment` table.

## Verifying an email address or phone number

A client can prove that the user controls an email address or phone number once, with a one-time code, and get a short-lived `verifiedTargetToken`. The token then replaces the second code of three requests: listing the accounts registered with the target, registering it with the guardian, and subscribing it to alerts. It also asks for the [sponsored deployment](#sponsored-deployment-of-undeployed-accounts) of an account registered with the target. No wallet signature is needed to verify a target; registering and subscribing still need theirs.

### `POST /v1/auth/verification/request`

```json
{"channel": "email", "target": "user@example.com"}
```

`channel` is `email` or `sms`. The response is `{"challengeId": "<id>"}`, and a code is sent to the target, after the response.

* Every valid target gets a code, registered or not, and the response is the same for all.
* The target is normalized as for `register`: an email address is trimmed and lower-cased, a phone number becomes E.164 (checked with Twilio Lookup when the channel uses Twilio).
* The code is sent through the first alert that offers the channel, among the `alerts` of each enabled network that has a `guardian` (config order), then `options.indexerAlert`.
* A request within 60 seconds of the latest one for the same channel and target returns the same `challengeId` and sends no new code, so a client that asks twice keeps a code that works. The challenge returned may already be used or dead (5 wrong codes): a new code is only sent once the 60 seconds have passed.
* At most 10 codes are sent to a channel and target within 24 hours. Past that, or once the target had 10 wrong codes within 24 hours (across its challenges), the request returns the latest `challengeId` and sends nothing, until older codes or failures leave the window. The client cannot tell this from a slow message.

| Status | Message | When |
| --- | --- | --- |
| 400 | `"channel" must be one of [email, sms]` (Joi) | the body does not validate |
| 400 | `Target channel '<channel>' is not supported` | no such alert offers the channel |
| 403 | `Target is not compatible with the '<channel>' channel` | the email address or phone number is invalid |

### `POST /v1/auth/verification/submit`

```json
{"challengeId": "<id>", "challenge": "123456"}
```

The response, sent with `Cache-Control: no-store`:

```json
{"verifiedTargetToken": "<43 characters>", "verifiedTargetTokenExpiresAt": "2026-11-19T12:10:00.000Z"}
```

* A code is valid for 10 minutes and can be used once. A challenge is dead after 5 wrong codes, and every submit for a channel and target is refused once it had 10 wrong codes within 24 hours.
* The token proves control of the channel and normalized target, not of an account. It is valid for 10 minutes (`verifiedTargetTokenExpiresAt`) and can be used several times until then. It is a bearer secret: keep it in memory, never in a URL, a log or storage. The service stores only its SHA-256 hash and never logs either.

| Status | Message | When |
| --- | --- | --- |
| 404 | `challengeId not found` | no such challenge |
| 400 | `challengeId already verified` | the challenge was already used |
| 403 | `challengeId has been expired` | the code is more than 10 minutes old |
| 403 | `Invalid challenge` | wrong code (counted) |
| 403 | `Too many invalid challenges, request a new code` | 5 wrong codes on this challenge |
| 403 | `Too many invalid challenges for this target, try again later` | 10 wrong codes for the channel and target within 24 hours |
| 500 | `Channel '<channel>' no longer exists, please contact support` | the alert that sent the code was removed from the config |

A submit counts its try with one atomic conditional update before the code is checked, so parallel submits cannot get more tries than allowed, and the update that marks the challenge verified also stores the token's hash, so two right codes at once yield one token. The cooldown and the 10-code cap are best effort: parallel requests can each get a new challenge and a code.

### Using the verified-target token

Wherever it is accepted, a token that is unknown, expired or (for `register` and `subscribe`) issued for another channel or target is refused with one answer, and a malformed one fails validation:

| Status | Message | When |
| --- | --- | --- |
| 400 | `"verifiedTargetToken" must be a valid token` | not 43 base64url characters |
| 403 | `Invalid or expired verifiedTargetToken` | unknown, expired, or issued for another channel or target |

`register` and `subscribe` check the token after the target and before the SIWE message. A refused token therefore leaves the message's nonce unused: the client can send the same signed message again without the token, and get the usual code. The token must still be valid when the request arrives, so a client whose signature takes long to collect (a Safe whose owners sign over hours) should sign first and verify last.

#### Looking up accounts: `POST /v1/auth/accounts`

```json
{"verifiedTargetToken": "<token>"}
```

The response, sent with `Cache-Control: no-store`, lists the accounts registered with the token's target on its channel (the registrations made with `POST /v1/auth/register`), for a user who lost the owner key or forgot the Safe address:

```json
{"accounts": [
  {"account": "0x1111111111111111111111111111111111111111", "chainId": 11155111, "registeredAt": "2026-11-20T10:00:00.000Z", "metadata": {"label": "Savings"}},
  {"account": "0x2222222222222222222222222222222222222222", "chainId": 11155111, "registeredAt": "2026-11-21T10:00:00.000Z", "metadata": {"label": "Spending", "_factory": "0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67", "_factoryData": "0x1688f0b9..."}}
]}
```

* One entry per account and chain, addresses lower-cased, sorted by account then `chainId`. The list can be empty. Alert subscriptions are not included.
* `registeredAt`: when the token's target was registered for the account on that chain (the earliest, if it was registered twice), in ISO 8601. It is the only hint for accounts registered without metadata.
* `metadata`: the account's [metadata](#account-metadata) on that chain, `{}` when there is none. It is the same whichever of the account's targets the lookup is made with. An account that registered before it was deployed may carry its deployment call (`_factory`, `_factoryData`, see [Init data of undeployed accounts](#init-data-of-undeployed-accounts)).
* Only the networks the service has enabled: registrations on a network that was removed or disabled are left out.
* The registrations are read as stored, with no on-chain check. A Safe whose owner has since removed the guardian or the module is still listed until its registration is deleted (`POST /v1/auth/delete`), so a client should check the guardian on chain before starting a recovery.
* It can be called again while the token is valid, e.g. to refresh the list after a registration.

#### Registering: `POST /v1/auth/register`

The usual body plus `"verifiedTargetToken": "<token>"`. The registration is created at once, with no code sent, and the response is the one `POST /v1/auth/submit` gives: `{"registrationId": "<id>", "guardianAddress": "0x..."}`. The account's SIWE signature is still required, with the same statement. One token can register the target for several accounts and chains while it is valid. The checks run in this order: guardian enabled on the network (400), channel offered by the network's alert (400), target (403), token (403), SIWE message (400 / 403), an existing registration (409, which still stores the [init data](#init-data-of-undeployed-accounts) of an undeployed account). Without `verifiedTargetToken` nothing changes: a code is sent and the response is `{"challengeId": "<id>"}`. Both paths take the optional `metadata` of [Account metadata](#account-metadata).

#### Subscribing to alerts: `POST /v1/alerts/subscribe`

The usual body plus `"verifiedTargetToken": "<token>"`. The subscription is created active, with no code sent and no `POST /v1/alerts/activate`, and the response is `{"subscriptionId": "<id>", "active": true}`. The owner's SIWE signature and the owner check are still required. The checks run in this order: channel offered by `options.indexerAlert` (400), target (403), token (403), SIWE message (400 / 403), owner check (400 / 403), an existing active subscription (409). Without `verifiedTargetToken` nothing changes: a code is sent and the response is `{"subscriptionId": "<id>"}`.

The token is never accepted by the recovery endpoints: `POST /v1/auth/signature/request` always sends codes of its own, and a token cannot delete a registration or a subscription either.

The log lines are `target verification requested` (`challengeId`, `channel`, `reused`, and `limit`: `locked` or `capped` when nothing was sent), `target verification completed` and `target verification refused` (`challengeId`, `channel`, `statusCode` for a refusal), `verified target token refused` (`use`: `lookup`, `register`, `subscribe` or `deploy`, `reason`: `unknown`, `expired` or `mismatch`, `verificationId` when the token was found), `account lookup completed` (`verificationId`, `channel`, `accountCount`), `auth registration created` (`registrationId`, `account`, `chainId`, `channel`, `verification`: `token` or `otp`, and for a token `verificationId` and `accountDeployed`; written by `POST /v1/auth/submit` too) and `alert subscription created` (with `active: true`, `verification: "token"` and `verificationId` for a token). The target, the code, the token, its hash and the accounts found are never logged.

**Operators: sending a code to any target costs money.** `POST /v1/auth/verification/request` needs no signature, so one request makes the service send a message. Each target gets at most 10 codes a day, but rotating targets is only bounded by `options.rateLimit` (per IP, over all routes), as it already is for `register` and `subscribe`. For SMS this is the pattern of SMS pumping. Restrict the destination countries at the SMS provider (Twilio's geo permissions), turn on its fraud protection and usage alerts, set `options.rateLimit` with this endpoint in mind, limit requests per client at whatever fronts the service, and set `options.authentication` when only a backend should call the service. Behind a backend every request comes from the same IP, so the per-IP limit does not limit an end user there. For email, use a provider that handles bounces: codes sent to addresses that never asked for one hurt the sender's reputation.

**Migrating a deployment:** apply the database migrations (`bunx prisma migrate deploy`): they add the `TargetVerification` table and an index on `AuthRegistration (channel, target)`.

## Account metadata

An app can store a small object with an account when it registers it with the guardian: the name the user gave the account, a hint, an id of its own. The account lookup (`POST /v1/auth/accounts`) returns it, so that a user who lost the owner key can tell their accounts apart. The service validates it, stores it and returns it, and does nothing else with it.

`metadata` is a JSON object of string keys to string values. It belongs to the account on a chain: one object shared by all the account's registrations there (email address and phone number), whichever registration it was written with.

| Rule | Limit | Message when broken (400) |
| --- | --- | --- |
| Type | a JSON object (not `null`, not an array) whose values are all strings; `{}` means none | `"metadata" must be an object of string values` |
| Entries | at most 10 | `"metadata" must have at most 10 entries` |
| Reserved keys | no key starting with `_` (reserved for the service) | `"metadata" keys starting with an underscore are reserved` |
| Key | 1 to 32 ASCII characters (letters, digits, `_`, `.`, `:`, `-`), starting with a letter or a digit | `"metadata" keys must be 1 to 32 characters of letters, digits, underscore, dot, colon or hyphen, and start with a letter or a digit` |
| Value | a non-empty string | `"metadata" values must be non-empty strings` |
| Value length | at most 256 UTF-16 code units (JavaScript's `String.length`) | `"metadata" values must be at most 256 characters long` |
| Value characters | no control characters (tab, CR and LF included), unpaired surrogates, U+2028, U+2029, or bidi embedding, override and isolate controls (U+202A to U+202E, U+2066 to U+2069) | `"metadata" values must not contain control characters` |
| Visible character | at least one character that is neither white space nor invisible (format characters such as U+200B, U+FEFF and the direction marks, other default-ignorable code points such as variation selectors, and the braille blank U+2800); these stay allowed next to a visible one | `"metadata" values must contain a visible character` |
| Whole object | at most 2048 bytes as compact JSON in UTF-8 | `"metadata" must be at most 2048 bytes as JSON` |

The rules are checked in this order and the first one broken is answered. No message quotes a key or a value. Nothing is trimmed, normalized or case-folded, and key order is not kept. The visible-character rule is best effort: a few rare symbols are drawn blank by most fonts and still pass, so an interface must cope with a name that looks empty. A deployment without this feature answers a request with `metadata` with 400 `"metadata" is not allowed`, which is how a client tells.

One key has a documented meaning: `label`, the name the user gave the account. The service never looks at it. Prefix your app's own keys (`myapp.profileId`).

Keys starting with `_` are reserved for the service, and a request that sends one is refused. The service stores two: `_factory` and `_factoryData`, the deployment call of an account that registered before it was deployed (see [Init data of undeployed accounts](#init-data-of-undeployed-accounts)); unlike the app's keys, they are written by the service. Reads return them as part of the object, and writes keep them: a write replaces the app's keys only, and `{}` removes the app's keys only. They do not count against the limits above, which apply to what an app sends. Send only your app's own keys: drop any key starting with `_` before writing an object back.

**Writing it.** `POST /v1/auth/register` takes an optional `metadata`:

* With a `verifiedTargetToken`, it is stored with the registration. Without, it is kept with the pending request and stored when `POST /v1/auth/submit` creates the registration. A request that fails (an existing registration, a refused token, a SIWE error) stores nothing.
* Present, it replaces the account's object on that chain whole (no merge; the service's reserved keys stay), and `{}` removes it. Left out, the stored object is kept, so adding a phone number to an account keeps its label.
* The account's SIWE signature authorizes the request, with the `register` statement as before. A `verifiedTargetToken` alone never writes metadata.

`POST /v1/auth/metadata` changes it later (see below).

**Reading it.** `POST /v1/auth/accounts` returns it in each entry, and `GET /v1/auth/registrations` (signed by the account) next to the registrations: `{"registrations": [...], "metadata": {"label": "Savings"}}`, `{}` when there is none. Nothing else returns it: not `/v1/auth/signature/*`, not a log line.

**Deleting it.** It is deleted with the account's last registration on that chain (`POST /v1/auth/delete`), also when the last two are deleted at once.

Registrations made before this version have `metadata: {}` until their app sets it; there is no backfill.

### `POST /v1/auth/metadata`

```json
{"account": "0x...", "chainId": 11155111, "metadata": {"label": "Savings"}, "message": "<SIWE message>", "signature": "0x..."}
```

Replaces the account's metadata on the chain, whole; `{}` removes it. The service's reserved keys stay. The response is `{"metadata": {"label": "Savings"}}`, the object as stored, reserved keys included. The account signs the SIWE message (ERC-6492 accepted, as for the other auth endpoints) with this statement:

`I request to update the metadata stored for my account with Safe Recovery Service`

The checks run in this order: the body (400), the SIWE message (400 / 403), a registration of the account on the chain (404). The signature comes first, so the endpoint does not tell an unsigned caller whether an account is registered. There is no guardian check: the metadata stays editable if the network's guardian is later removed from the config.

| Status | Message | When |
| --- | --- | --- |
| 400 | `"metadata" is required` | `metadata` is left out |
| 400 | `"metadata" <rule>` | see the rules above |
| 400 / 403 | `SIWE Message: ...` | as for the other signed endpoints |
| 404 | `No registrations found for this account on this chainId` | the account has no registration on the chain |

Guidance for apps and interfaces:

* **Untrusted text.** Whoever can sign for an account and verify an email address or phone number chooses what its metadata says, and whoever proves that target later sees it. Someone talked out of a verification code can therefore find a stranger's account, with a label of the stranger's choosing, in their own lookup. Render values as plain text, never as HTML or a link, truncate them, and present them as a name the app stored, not as a statement by the service.
* **Not a secret.** Everyone who controls a target registered for the account can read it, and the operator stores it in plaintext. Never put a password, a recovery phrase or anything that grants access in it; a hint is a reminder, not a second factor. An opaque id that only your app can resolve is the safest content.
* **Not signed.** The SIWE message authorizes the request, not the object. A party holding a signed message can pair it with other metadata while the message is still accepted (5 minutes, up to 24 hours with `expirationTime`) and its nonce is free (the nonce store is per process: on another replica, or after a restart). The worst outcome is a wrong label.
* **Advisory only.** Metadata never authorizes, selects or filters anything: a recovery is decided by the registrations' codes and the guardian's signature, as before.

Best effort (there is no transaction):

* Writes to one account and chain at once (email and phone registered in parallel, both with `metadata`, or a `POST /v1/auth/metadata` meanwhile): a write changes the row only if it is still as the write read it, and reads it again otherwise, so a write made in between is merged, not lost (the app's keys of the last write win). After 3 tries the request answers 500 and writes nothing.
* A `register` (with a `verifiedTargetToken`) or a `/submit` that fails between creating the registration and writing the metadata answers 500 and leaves the registration with the stored metadata unchanged. The `/submit` keeps the metadata with the pending request: the same code sent again answers with the registration already created and stores it. The `register`, sent again with a new SIWE message and its token, gets 409 (the same message is refused for its nonce): the app sets its metadata with `POST /v1/auth/metadata`, and the 409 itself stores the [init data](#init-data-of-undeployed-accounts) of an undeployed account, which no other request can write.
* A `POST /v1/auth/delete` of the account's last registration on the chain removes the metadata first. If deleting the registration then fails, it answers 500 and the registration stays, without its metadata; the app sets it again with `POST /v1/auth/metadata`.
* When the account's last registration on the chain is deleted while a `register` of the same account and chain is in flight, the new registration can end up without the metadata it sent.
* When it is deleted after a `POST /v1/auth/metadata` passed its registration check and before it writes, the metadata is left without a registration. It is never returned (both reads start from a registration), but it reappears if the account registers again on that chain without `metadata`.
* `/submit` creates one registration per `challengeId`. Called again with the right code while the code is valid, it answers with that registration (`registrationId`, `guardianAddress`) and creates no other. It answers 400 `challengeId already verified` when the registration is not there: deleted since, or still being created by a call made at the same moment. A `/submit` that fails while looking for or creating the registration (500) gives the challenge back, so the same code can be sent again.
* `/submit` does not register a target twice for an account on a chain. When another challenge, or a `register` with a `verifiedTargetToken`, registered it while the code was pending, it answers with that registration, and still stores the metadata sent with its own `register`. Two different challenges submitted at the same moment can still create one each.
* The metadata sent with a `register` that waits for its code is written when the code is submitted, up to 10 minutes later, over what is stored then. Metadata written in between (`POST /v1/auth/metadata`, another registration) is replaced: the last code submitted wins, not the last request signed.
* The copy kept with a pending request whose code is never submitted stays in the database, with the request.

The log lines `auth registration requested` and `auth registration created` carry `metadataEntries` (the number of entries) when metadata was sent, `auth account metadata updated` (`account`, `chainId`, `metadataEntries`, 0 when removed, `accountDeployed`) is written by `POST /v1/auth/metadata`, `auth registration submitted again` (`challengeId`, `registrationId`, `account`, `chainId`, `channel`) says that a `/submit` sent again for a challenge found the registration already there, `auth registration already exists` (the same fields) says that a first `/submit` found the target registered meanwhile, through another challenge or a `verifiedTargetToken` (both lines are written when the registration is found, before any pending metadata is stored, so neither says that the request succeeded), `registration challenge not released` (warn, `challengeId`) says that a `/submit` could not create its registration nor give the challenge back (the target is then registered again, with a new code), `pending registration metadata not cleared` (warn, `challengeId`) says that a registration was created but the copy kept with its request could not be cleared, and `account metadata not removed with the last registration` (warn, `account`, `chainId`) says that a registration was deleted but the check made after it failed. The object, its keys and its values are never logged.

**Migrating a deployment:** apply the database migrations (`bunx prisma migrate deploy`): they add the `AuthAccountMetadata` table and a nullable `metadata` column on `AuthRegistrationRequest`. Both are additive, so the migration can be applied while an older version runs.

## Running

Start the development server:
```bash
bun run dev
```
or

Start the production server:
```bash
bun run start
```

## Logging

The service writes one JSON line per event to stdout (pino), ready for Loki / Grafana. Every line carries `time`, `level`, `service`, `env` and a static `msg`, with identifiers (never secrets) as fields. `LOG_LEVEL` (default `info`), `LOG_PRETTY=true` (local, human-readable output) and `ENVIRONMENT` (the `env` field) configure it; `bun run logging:selftest` checks the redaction rules.
