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

* the module is enabled on the Safe and holds guardians for it; otherwise the response says to pass the `moduleAddress` of the module that holds them. A disabled module keeps its stored guardians, so both are checked;
* the proposed owners can be set by the module: none is the zero address, `0x0000000000000000000000000000000000000001`, the Safe itself or one of its guardians on that module, and none is listed twice. v0.1.0 used to accept such proposals but could never finalize them; they are now rejected for both versions;
* with no `moduleAddress`, a `create` signature that is not valid for the fallback but is valid for another configured module fails with an error naming that module.

An empty signature (`0x`) is accepted on v0.2.0 modules only, where it is checked with EIP-1271 (a Safe guardian that approved the recovery hash). v0.1.0 cannot execute it, so it is rejected there.

**Migrating clients:** read `modules` from `/v1/config/getNetworkConfig`, sign the recovery hash of the module the Safe uses (its `getRecoveryHash`, at that module's `nonce`), and send that module as `moduleAddress` to `create`, `signature/request`, `fetchByAddress` and `listByAddress`.

**Migrating a deployment:** apply the database migrations (`bunx prisma migrate deploy`). Requests made before this version have no module; at boot they are assigned to the module of a legacy `recoveryModuleAddress` config (see [Networks](#networks)).

## Counterfactual accounts (ERC-6492)

A Safe can register auth methods and subscribe to alerts before it is deployed. The client wraps the request's `signature` with [ERC-6492](https://eips.ethereum.org/EIPS/eip-6492): `abi.encode(address factory, bytes factoryCalldata, bytes signature)` followed by the 32-byte magic suffix `0x6492649264926492649264926492649264926492649264926492649264926492`, where `factory` and `factoryCalldata` are the call that deploys the Safe (for a Safe, its `SafeProxyFactory.createProxyWithNonce` call). No other request field changes.

* **Auth** (`POST /v1/auth/register`, `GET /v1/auth/registrations`, `POST /v1/auth/delete`): standard ERC-6492. The SIWE `address` is the Safe, and the inner signature is the Safe signature a deployed Safe would give (the owners' signatures of the SafeMessage, up to the threshold). The service deploys the Safe in simulation and calls its `isValidSignature`, so the Safe's threshold applies.
* **Alerts** (`POST /v1/alerts/subscribe`, `GET /v1/alerts/subscriptions`, `POST /v1/alerts/unsubscribe`): the SIWE `address` is an owner and the inner signature is that owner's SIWE signature, as for a deployed Safe, but the wrapper's deployment data describes the **account** (the request's `account`, or the subscription's for `unsubscribe`), not the signer. The service reads the owners of the simulated deployment and requires the signer to be one of them.

The recovery endpoints (`/v1/recoveries/*`) do not accept wrapped signatures: the module checks guardian signatures on chain with EIP-1271, which needs a deployed contract. `POST /v1/auth/signature/request` and `/submit` carry no signature and need the Safe deployed with the module enabled and the service's guardian added, so a registration made before deployment can be used once that is done.

Rules:

* A signature without the suffix is checked exactly as before.
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

Nothing is stored about how a registration or subscription was made: the log lines `auth registration requested`, `alert subscription created` and `alert subscription removed` carry `accountDeployed`.

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
