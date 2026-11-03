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
	  * `fallback`: Optional, `true` on at most one v0.1.0 module. Recovery requests, custodial guardian signatures and `/v1/config/getNetworkConfig` use this module; every listed module is indexed and alerted on.
	  * `indexer`: Specifies whether the indexer covers this module, and the first indexing block for its first run
	    - `enabled`: A boolean indicating whether this module is indexed.
	    - `startBlock`: A number that specifies from which block the indexer starts indexing this module (should be the block at which the module was deployed). Note: this value is ignored once the module has a recorded last indexed block. A module added to a running service is indexed from this block, and alerts are sent for the events found on the way.
	+ `recoveryModuleAddress` (legacy): A network with a single module can set this field and a network-level `indexer` block (same fields as above) instead of `recoveryModules`. The module is then the network's fallback. A network uses one shape or the other, not both.
	+ `executeRecoveryRequests`: Controls whether the service will execute the recovery after all required signatures are collected. It has a `enabled` boolean field, and requires the `id` of a `signer` to be specified if enabled.
      + `rateLimit`: Controls the rate limiting for recovery executions by the service (omitted or `~` if no rate limit)
        * `maxPerAccount`: The maximum number of recovery executions allowed per account within the specified period.
        * `period`: The time period for which the rate limit is applied.
	+ `finalizeRecoveryRequests`: Controls whether the service will finalize the recovery after the grace period is over. It has a `enabled` boolean field, and requires the `id` of a `signer` to be specified if enabled.
	  + `rateLimit`: Controls the rate limiting for recovery finalizations by the service (omitted or `~` if no rate limit)
        * `maxPerAccount`: The maximum number of recovery finalizations allowed per account within the specified period.
        * `period`: The time period for which the rate limit is applied.
	+ `alerts`: Optionally specifies the alert to use for this network with with an alert `id`.

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
