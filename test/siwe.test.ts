// Unit tests of the SIWE message checks (issuedAt window) and the nonce store: no database, no chain (a fake
// JSON-RPC provider), no app boot.
import {ethers} from "ethers";
import {generateNonce, SiweMessage} from "siwe";
import {
  SiweNonceStore,
  siweNonces,
  validateOwnerSIWEMessage,
  validateSIWEMessage,
  verifySiweMessageData,
} from "../src/utils/utilities";
import {ERC6492_MAGIC, MULTICALL3_ADDRESS} from "../src/utils/erc6492";
import {Network} from "../src/models/network";

const CHAIN_ID = 11155111;
const MINUTE = 60 * 1000;
const NOW = Date.now(); // the fake clock starts here, so the entries it leaves outlive the tests on the real clock
const statement = "I request to retrieve all Social Recovery Module alert subscriptions linked to my account";
const owner = ethers.Wallet.createRandom();
const stranger = ethers.Wallet.createRandom();

const NONCE_USED = "nonce has been already used in a previous request, please use a random nonce";
const TOO_OLD = "issuedAt is valid only for 5 minutes and signature is already expired";
const IN_THE_FUTURE = "issuedAt is in the future";

const at = (offsetMs: number) => new Date(NOW + offsetMs);

const siweMessage = (fields: {issuedAt: Date; expirationTime?: Date; notBefore?: Date; nonce?: string}) => new SiweMessage({
  domain: "example.com",
  address: owner.address,
  statement,
  uri: "https://example.com",
  chainId: CHAIN_ID,
  version: "1",
  nonce: fields.nonce ?? generateNonce(),
  issuedAt: fields.issuedAt.toISOString(),
  expirationTime: fields.expirationTime?.toISOString(),
  notBefore: fields.notBefore?.toISOString(),
});

const check = (message: SiweMessage) => verifySiweMessageData(message, owner.address, CHAIN_ID, statement);

describe("verifySiweMessageData time window", () => {
  beforeEach(() => jest.useFakeTimers({now: NOW}));
  afterEach(() => jest.useRealTimers());

  it("rejects an issuedAt more than 5 minutes old, even with a far-future expirationTime", () => {
    for (const expirationTime of [at(365 * 24 * 60 * MINUTE), at(MINUTE), undefined]) {
      expect(check(siweMessage({issuedAt: at(-5 * MINUTE - 1), expirationTime}))).toEqual([false, TOO_OLD]);
    }
    expect(check(siweMessage({issuedAt: at(-30 * 24 * 60 * MINUTE), expirationTime: at(365 * 24 * 60 * MINUTE)})))
      .toEqual([false, TOO_OLD]);
  });

  it("accepts an issuedAt up to 5 minutes old", () => {
    expect(check(siweMessage({issuedAt: at(-5 * MINUTE)}))).toEqual([true, ""]);
    expect(check(siweMessage({issuedAt: at(-5 * MINUTE), expirationTime: at(365 * 24 * 60 * MINUTE)}))).toEqual([true, ""]);
  });

  it("rejects an issuedAt more than 60 seconds ahead", () => {
    expect(check(siweMessage({issuedAt: at(MINUTE + 1)}))).toEqual([false, IN_THE_FUTURE]);
    expect(check(siweMessage({issuedAt: at(365 * 24 * 60 * MINUTE)}))).toEqual([false, IN_THE_FUTURE]);
    expect(check(siweMessage({issuedAt: at(10 * MINUTE), expirationTime: at(20 * MINUTE)}))).toEqual([false, IN_THE_FUTURE]);
  });

  it("accepts an issuedAt up to 60 seconds ahead (clock skew)", () => {
    expect(check(siweMessage({issuedAt: at(MINUTE)}))).toEqual([true, ""]);
  });

  it("accepts a fresh message with or without expirationTime", () => {
    expect(check(siweMessage({issuedAt: at(0)}))).toEqual([true, ""]);
    expect(check(siweMessage({issuedAt: at(0), expirationTime: at(2 * MINUTE)}))).toEqual([true, ""]);
    expect(check(siweMessage({issuedAt: at(0), expirationTime: at(365 * 24 * 60 * MINUTE)}))).toEqual([true, ""]);
  });

  it("rejects an expired expirationTime", () => {
    expect(check(siweMessage({issuedAt: at(-2 * MINUTE), expirationTime: at(-1)})))
      .toEqual([false, "expirationTimestamp has passed and signature has expired"]);
  });

  it("rejects a notBefore that has not passed", () => {
    expect(check(siweMessage({issuedAt: at(0), notBefore: at(30 * 1000)})))
      .toEqual([false, "notBeforeTimestamp has not yet passed, this signature cannot be used until then"]);
  });
});

describe("SiweNonceStore", () => {
  it("rejects a held identifier until it is released", () => {
    const store = new SiweNonceStore();
    expect(store.reserve("a", 2000, 1000)).toBe(true);
    expect(store.reserve("a", 2000, 1000)).toBe(false);
    expect(store.reserve("b", 2000, 1000)).toBe(true);
    store.release("a");
    expect(store.size).toBe(1);
    expect(store.reserve("a", 2000, 1000)).toBe(true);
  });

  it("prunes expired entries on each reservation", () => {
    const store = new SiweNonceStore();
    store.reserve("a", 2000, 1000);
    store.reserve("b", 3000, 1000);
    expect(store.reserve("c", 5000, 1999)).toBe(true); // nothing expired yet
    expect(store.size).toBe(3);
    expect(store.reserve("d", 5000, 2000)).toBe(true); // drops "a"
    expect(store.size).toBe(3);
    expect(store.reserve("a", 6000, 2000)).toBe(true); // free again
    expect(store.reserve("e", 9000, 6000)).toBe(true); // drops all but "e"
    expect(store.size).toBe(1);
  });
});

// A JSON-RPC provider with no contract, so siwe's EIP-1271 fallback answers "invalid" for any non-ECDSA signature.
class FakeChain extends ethers.providers.StaticJsonRpcProvider {
  constructor() {
    super("http://fake-chain.invalid", {chainId: CHAIN_ID, name: "sepolia"});
  }

  async send(method: string): Promise<any> {
    switch (method) {
      case "eth_chainId":
        return ethers.utils.hexValue(CHAIN_ID);
      case "net_version":
        return CHAIN_ID.toString();
      case "eth_getCode":
      case "eth_call":
        return "0x";
      default:
        throw new Error(`unexpected ${method}`);
    }
  }
}

describe("nonce replay protection", () => {
  const network = Object.assign(Object.create(Network.prototype), {
    name: "sepolia",
    chainId: CHAIN_ID,
    jsonRPCProvider: new FakeChain(),
    multicall3: MULTICALL3_ADDRESS,
  }) as Network;
  Network.instances.add(network);

  const nonceUsed = {statusCode: 400, message: `SIWE Message: ${NONCE_USED}`};
  const signed = async (message: SiweMessage, signer = owner) => [message.toMessage(), await signer.signMessage(message.prepareMessage())];
  const validateOwner = (message: string, signature: string) =>
    validateOwnerSIWEMessage(message, owner.address, CHAIN_ID, statement, signature);

  it("rejects a reused nonce", () => {
    const message = siweMessage({issuedAt: new Date()});
    expect(check(message)).toEqual([true, ""]);
    expect(check(message)).toEqual([false, NONCE_USED]);
    // another message with the same account, chain, statement and nonce
    expect(check(siweMessage({issuedAt: new Date(), expirationTime: at(MINUTE), nonce: message.nonce})))
      .toEqual([false, NONCE_USED]);
  });

  it("keeps the nonce of a verified message", async () => {
    const [message, signature] = await signed(siweMessage({issuedAt: new Date()}));
    expect(await validateOwner(message, signature)).toEqual({deployment: undefined});
    await expect(validateOwner(message, signature)).rejects.toMatchObject(nonceUsed);
  });

  it("does not reserve the nonce of a message that fails a check", () => {
    const nonce = generateNonce();
    const size = siweNonces.size;
    expect(check(siweMessage({issuedAt: new Date(Date.now() - 10 * MINUTE), nonce}))).toEqual([false, TOO_OLD]);
    expect(siweNonces.size).toBe(size);
    expect(check(siweMessage({issuedAt: new Date(), nonce}))).toEqual([true, ""]);
  });

  it("frees the nonce when the signature check fails", async () => {
    const message = siweMessage({issuedAt: new Date()});
    const [text, strangerSignature] = await signed(message, stranger);
    const size = siweNonces.size;
    await expect(validateOwner(text, strangerSignature))
      .rejects.toMatchObject({statusCode: 403, message: expect.stringContaining("invalid signature")});
    expect(siweNonces.size).toBe(size);
    const [, ownerSignature] = await signed(message);
    expect(await validateOwner(text, ownerSignature)).toEqual({deployment: undefined});
    expect(siweNonces.size).toBe(size + 1);
  });

  it("frees the nonce when the signature check throws", async () => {
    const message = siweMessage({issuedAt: new Date()});
    const [text, signature] = await signed(message);
    await expect(validateSIWEMessage(text, owner.address, CHAIN_ID, statement, "0x1234" + ERC6492_MAGIC.slice(2)))
      .rejects.toMatchObject({statusCode: 400, message: "SIWE Message: malformed ERC-6492 signature"});
    expect(await validateSIWEMessage(text, owner.address, CHAIN_ID, statement, signature)).toEqual({counterfactual: false});
    await expect(validateSIWEMessage(text, owner.address, CHAIN_ID, statement, signature)).rejects.toMatchObject(nonceUsed);
  });

  it("lets one of two concurrent requests with the same message through", async () => {
    const [message, signature] = await signed(siweMessage({issuedAt: new Date()}));
    const results = await Promise.allSettled([validateOwner(message, signature), validateOwner(message, signature)]);
    expect(results.map((result) => result.status).sort()).toEqual(["fulfilled", "rejected"]);
    expect(results.find((result) => result.status === "rejected")).toMatchObject({reason: nonceUsed});
    // the rejected request did not release the reservation of the other one
    await expect(validateOwner(message, signature)).rejects.toMatchObject(nonceUsed);
  });

  it("holds a nonce until its message is past the issuedAt window, then prunes it", () => {
    jest.useFakeTimers({now: NOW});
    try {
      const nonce = generateNonce();
      expect(check(siweMessage({issuedAt: at(0), nonce}))).toEqual([true, ""]);
      jest.setSystemTime(NOW + 6 * MINUTE - 1); // issuedAt + 5 minutes + 60 seconds, minus 1 ms
      expect(check(siweMessage({issuedAt: new Date(), nonce}))).toEqual([false, NONCE_USED]);
      jest.setSystemTime(NOW + 6 * MINUTE);
      expect(check(siweMessage({issuedAt: new Date(), nonce}))).toEqual([true, ""]);
      jest.setSystemTime(NOW + 24 * 60 * MINUTE); // everything reserved so far has expired
      expect(check(siweMessage({issuedAt: new Date()}))).toEqual([true, ""]);
      expect(siweNonces.size).toBe(1);
    } finally {
      jest.useRealTimers();
    }
  });
});
