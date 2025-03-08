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

* `env`: The environment in which the service is running. Can be either `"development"` or `"production"`. (required)
* `port`: The port number where the server will run. (required)
* `indexerAlert`: Specifies the alert id to use for the alert system. (required)
* `trustProxy`: Specifies whether the app is sitting behind a proxy and trusts this proxy. (optional, default: true)
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
    + `indexer`: Specifies whether the indexer is enabled, and the first indexing block for first time run
      * `enabled`: A boolean indicating whether the indexer is enabled.
      * `startBlock`: A number that specifies from which block should the indexer start indexing (should be the block at which the recovery module was deployed), Note: this value will be ignored after the first time the indexer starts as it'll rely on its recorded last indexed block

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
