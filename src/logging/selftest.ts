// Redaction regression check: `bun src/logging/selftest.ts` (or `npx tsx src/logging/selftest.ts`)
// exits non-zero on failure.
import { serializeError } from "./errors";
import { serializeRequest } from "./http";
import {
  maskSecret,
  registerSecret,
  sanitizePath,
  sanitizeString,
  sanitizeValue,
} from "./sanitize";

const apiKey = "0123456789abcdef0123456789abcdef";
const privateKey = "0x4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318";
const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.c2lnbmF0dXJlLXZhbHVl";
registerSecret("selftest-registered-secret", "SELFTEST_SECRET");
// safe-recovery-service secret shapes (config.json values are registered when the config loads)
const alchemyKey = "AbCdEf123456789GhIjKlMnOpQrStUv";
const awsSecret = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";
const twilioToken = "a1b2c3d4e5f60718293a4b5c6d7e8f90";
const adminToken = "srs-admin-9f8e7d6c5b4a39281706f5e4d3c2b1a0";
const webhookUrl = "https://hooks.example.com/services/T0AB12CD/B0EF34GH/zyxw";
registerSecret(webhookUrl, "alerts.alert-2.email.webhook.endpoint");
const ethersMessage = (url: string) =>
  `missing response (requestBody="{\\"method\\":\\"eth_getLogs\\",\\"params\\":[{\\"fromBlock\\":\\"0x10\\"}],` +
  `\\"id\\":42,\\"jsonrpc\\":\\"2.0\\"}", requestMethod="POST", serverError={}, url="${url}", ` +
  `code=SERVER_ERROR, version=web/5.7.1)`;

const leaks: [string, unknown, string[]][] = [
  ["api key in text", sanitizeString(`key ${apiKey} used`), [apiKey]],
  ["api key in path", sanitizePath(`/api/v3/sepolia/${apiKey}`), [apiKey]],
  ["private key", sanitizeString(`signer ${privateKey}`), [privateKey.slice(6)]],
  ["jwt", sanitizeString(`id token ${jwt}`), [jwt.split(".")[1]]],
  ["bearer", sanitizeString("Authorization: Bearer abcdef123456"), ["abcdef123456"]],
  ["url userinfo", sanitizeString("mongodb://admin:hunter2@db:27017/parse"), ["hunter2"]],
  ["rpc provider", sanitizeString("https://eth-mainnet.g.alchemy.com/v2/AbCd1234EfGh"), ["AbCd"]],
  ["query param", sanitizeString("https://x.io/p?apikey=s3cr3t&page=2"), ["s3cr3t"]],
  ["json pair", sanitizeString('Input: {"secret":"a b c","password":"pw"}'), ["a b c", '"pw"']],
  ["qdb conf", sanitizeString("http::addr=h:9000;username=admin;password=quest;"), ["quest"]],
  ["management key", sanitizeString(`mk_${"ab".repeat(24)}`), ["ab".repeat(24)]],
  ["session token", sanitizeString(`r:${"cd".repeat(16)}`), ["cd".repeat(16)]],
  ["mollie key", sanitizeString("live_abcdefghijklmnopqrstuvwxyz1234"), ["abcdefghijklmnop"]],
  ["registered", sanitizeString("x selftest-registered-secret y"), ["selftest-registered-secret"]],
  [
    "key names",
    sanitizeValue({ a: { apiKey, headers: { authorization: "x1" }, token: "t1" } }),
    [apiKey, "x1", "t1"],
  ],
  ["parse object", sanitizeValue({ obj: { toJSON: () => ({ key: apiKey }) } }), [apiKey]],
  [
    "error",
    serializeError(new Error(`boom ${apiKey}`, { cause: new Error(`inner ${jwt}`) } as any)),
    [apiKey, jwt],
  ],
  [
    "axios",
    serializeError(
      Object.assign(new Error("Request failed"), {
        isAxiosError: true,
        config: { url: `https://rpc.ankr.com/eth/${apiKey}`, headers: { Authorization: "x2" } },
      })
    ),
    [apiKey, "x2"],
  ],
  [
    "request",
    serializeRequest({
      method: "POST",
      originalUrl: `/v1/x/${apiKey}?token=t3`,
      headers: { authorization: "x3" },
      body: { a: "b4" },
    }),
    [apiKey, "t3", "x3", "b4"],
  ],
  // safe-recovery-service shapes
  [
    "ethers alchemy url",
    sanitizeString(ethersMessage(`https://eth-sepolia.g.alchemy.com/v2/${alchemyKey}`)),
    [alchemyKey, "eth_getLogs"],
  ],
  [
    "ethers infura url",
    sanitizeString(ethersMessage(`https://sepolia.infura.io/v3/${apiKey}`)),
    [apiKey, "0x10"],
  ],
  [
    "ethers keyed custom rpc",
    sanitizeString(ethersMessage(`https://rpc.example.com/v1/${alchemyKey}`)),
    [alchemyKey],
  ],
  ["aws secret key", sanitizeString(`credentials ${awsSecret} rejected`), [awsSecret.slice(4)]],
  ["aws access key id", sanitizeString("AKIAIOSFODNN7EXAMPLE rejected"), ["IOSFODNN7EXAMPLE"]],
  ["twilio auth token", sanitizeString(`Authenticate ${twilioToken}`), [twilioToken.slice(4)]],
  ["twilio basic auth", sanitizeString("authorization: Basic QUN4eHg6c2VjcmV0dG9rZW4="), ["QUN4eHg6"]],
  [
    "smtp url userinfo",
    sanitizeString("smtps://alerts%40example.com:Sup3rS3cret@smtp.example.com:465"),
    ["Sup3rS3cret"],
  ],
  ["admin bearer header", sanitizeString(`authorization: Bearer ${adminToken}`), [adminToken.slice(10)]],
  ["registered webhook url", sanitizeString(`POST ${webhookUrl} failed`), ["hooks.example.com"]],
  [
    // token in the path of an unregistered webhook (a real provider host would trip GitHub push protection here)
    "token-bearing webhook path",
    sanitizeString("https://hooks.example.invalid/services/T0AB12CD34/B0EF56GH78/Ab1Cd2Ef3Gh4Ij5Kl6Mn7Op8"),
    ["Ab1Cd2Ef3Gh4Ij5Kl6Mn7Op8"],
  ],
  [
    "config keys",
    sanitizeValue({
      options: { sentryDSN: "https://abc123@o1.ingest.sentry.io/1" },
      signers: [{ id: "s1", privateKey, awsKMS: { accessKeyId: "AKIAIOSFODNN7EXAMPLE", secretAccessKeyId: awsSecret } }],
      alerts: [
        {
          id: "a1",
          channels: {
            email: {
              smtp: { auth: { type: "login", user: "alerts", pass: "hunter22" } },
              webhook: { endpoint: "https://hooks.example.com/x", authorizationHeader: "Bearer tok" },
            },
            sms: { twilio: { accountSid: "AC1", authToken: twilioToken } },
          },
        },
      ],
      networks: { sepolia: { jsonRpcEndpoint: "https://rpc.example.com/v1/k" } },
    }),
    [
      "ingest.sentry.io",
      privateKey.slice(6),
      "IOSFODNN7EXAMPLE",
      awsSecret,
      "hunter22",
      "hooks.example.com",
      "Bearer tok",
      twilioToken,
      "rpc.example.com",
    ],
  ],
  [
    "siwe and otp keys",
    sanitizeValue({ message: "siwe-message", signature: "0xsig", siweMessage: "m", otp: "123456", challenge: "654321" }),
    ["0xsig", '"m"', "123456", "654321"],
  ],
];
const kept: [string, unknown, string[]][] = [
  ["hash field", sanitizeValue({ userOpHash: privateKey }), [privateKey]],
  [
    "identifiers",
    sanitizeValue({ apiKeyId: "Ab12Cd34Ef", secretConfigured: true }),
    ["Ab12Cd34Ef", "true"],
  ],
  ["mask hint", maskSecret(apiKey), ["0123***"]],
  [
    "service identifiers",
    sanitizeValue({
      signerId: "signer-1",
      alertId: "alert-1",
      chainId: 11155111,
      network: "sepolia",
      subscriptionId: "cm1abc",
      recoveryRequestId: "cm2def",
      challengeId: "cm3ghi",
      txHash: privateKey,
      hashes: [privateKey],
    }),
    ["signer-1", "alert-1", "11155111", "sepolia", "cm1abc", "cm2def", "cm3ghi", privateKey],
  ],
];

let failed = 0;
for (const [name, value, needles] of leaks) {
  const out = JSON.stringify(value);
  for (const needle of needles) {
    if (out.includes(needle)) {
      failed++;
      console.error(`FAIL ${name}: still contains a secret`);
    }
  }
}
for (const [name, value, needles] of kept) {
  const out = JSON.stringify(value);
  for (const needle of needles) {
    if (!out.includes(needle)) {
      failed++;
      console.error(`FAIL ${name}: lost ${needle}`);
    }
  }
}
if (maskSecret("short") !== "***") {
  failed++;
  console.error("FAIL short secrets must be fully masked");
}
console.log(failed ? `${failed} redaction check(s) failed` : "redaction checks passed");
process.exit(failed ? 1 : 0);
