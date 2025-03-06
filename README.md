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

* `env`: The environment in which the service is running. Can be either `"development"` or `"production"`.
* `port`: The port number where the server will run.
* `sentryDSN`: Optional field for [sentry](sentry.io) logging purposes.

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
    	- `webhook`: With a URL.
	+ `sms`: Can be configured using either:
		- `twilio`: With `accountSid`, `authToken`, and `fromNumber` settings in [Twilio](https://www.twilio.com).
		- `webhook`: With a URL.
* Alerts are optional.

#### Networks

* A list of network objects, each with a unique `id`.
* Each network can have the following settings:
	+ `enabled`: A boolean indicating whether the network is enabled.
	+ `chainId`: Number of chain ID of the network.
	+ `jsonRpcEndpoint`: The JSON-RPC endpoint of the network.
	+ `recoveryModuleAddress`: The address of the recovery module.
	+ `executeRecoveryRequests`: Controls whether the service will execute the recovery after all required signatures are collected. It has a `enabled` boolean field, and requires the `id` of a `signer` to be specified if enabled.
      + `rateLimit`: Controls the rate limiting for recovery executions by the service (omitted or `~` if no rate limit)
        * `maxPerAccount`: The maximum number of recovery executions allowed per account within the specified period.
        * `period`: The time period for which the rate limit is applied.
	+ `finalizeRecoveryRequests`: Controls whether the service will finalize the recovery after the grace period is over. It has a `enabled` boolean field, and requires the `id` of a `signer` to be specified if enabled.
	  + `rateLimit`: Controls the rate limiting for recovery finalizations by the service (omitted or `~` if no rate limit)
        * `maxPerAccount`: The maximum number of recovery finalizations allowed per account within the specified period.
        * `period`: The time period for which the rate limit is applied.
	+ `alerts`: Optionally specifies the alert to use for this network with with an alert `id`.

> [!TIP]
The config file supports loading values from `.env`. Prefix the value with `ENV::` followed by the name of the env variable. Example: `privateKey: ENV::PRIVATE_KEY` loads the value of the `PRIVATE_KEY` .env variable into the `privateKey` field
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
