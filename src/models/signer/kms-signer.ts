import {Signer} from "./signer";
import {GetPublicKeyCommand, KMSClient, SignCommand,} from "@aws-sdk/client-kms";
import {keccak256} from "ethers/lib/utils";
// @ts-ignore
import * as asn1 from 'asn1.js';
import {ethers} from "ethers";

const EcdsaPubKey = asn1.define('EcdsaPubKey', function(this: any) {
  // parsing this according to https://tools.ietf.org/html/rfc5480#section-2
  this.seq().obj(
    this.key('algo').seq().obj(
      this.key('a').objid(),
      this.key('b').objid(),
    ),
    this.key('pubKey').bitstr()
  );
});

const EcdsaSigAsnParse = asn1.define('EcdsaSig', function(this: any) {
  // parsing this according to https://tools.ietf.org/html/rfc3279#section-2.2.3
  this.seq().obj(
    this.key('r').int(),
    this.key('s').int(),
  );
});

export class KMSSigner extends Signer {
  private kmsClient: KMSClient;
  private keyId: string;
  private _cachedAddress?: string;

  constructor(id: string, accessKeyId: string, secretAccessKey: string, region: string, keyId: string) {
    super(id);
    this.keyId = keyId;
    this.kmsClient = new KMSClient({
      region,
      credentials: {
        accessKeyId: accessKeyId,
        secretAccessKey: secretAccessKey
      }
    });
  }

  /**
   * Derives the Ethereum address from the KMS ECDSA public key.
   */
  async signer(): Promise<string> {
    if (this._cachedAddress){
      return this._cachedAddress;
    }
    try {
      const command = new GetPublicKeyCommand({ KeyId: this.keyId });
      const response = await this.kmsClient.send(command);
      if (!response.PublicKey) {
        throw new Error("Failed to fetch public key from KMS.");
      }
      const publicKey = Buffer.from(response.PublicKey!);
      let res = EcdsaPubKey.decode(publicKey, 'der');
      let pubKeyBuffer : Buffer = res.pubKey.data;
      pubKeyBuffer = pubKeyBuffer.subarray(1, pubKeyBuffer.length);
      const address = keccak256(pubKeyBuffer);
      const buffer2 = Buffer.from(address._0xRemove(), 'hex');
      const ethereumAddress = "0x" + buffer2.subarray(-20).toString('hex');
      this._cachedAddress = ethereumAddress;
      return ethereumAddress;
    } catch (error) {
      throw new Error(`Error retrieving signer address: ${error}`);
    }
  }

  async sign(payload: string): Promise<string> {
    try {
      const message = Buffer.from(payload._0xRemove(), 'hex');
      const command = new SignCommand({
        KeyId: this.keyId,
        Message: message,
        MessageType: "DIGEST",
        SigningAlgorithm: "ECDSA_SHA_256",
      });
      const response = await this.kmsClient.send(command);
      if (!response.Signature) {
        throw new Error("Failed to sign the payload.");
      }
      const signature = Buffer.from(response.Signature!);
      let decoded = EcdsaSigAsnParse.decode(signature, 'der');
      let r = BigInt(decoded.r.toString());
      let s = BigInt(decoded.s.toString());
      let secp256k1N = BigInt("0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141"); // max value on the curve
      let secp256k1halfN = secp256k1N/2n;
      if (s > secp256k1halfN) {
        s = secp256k1N - s;
      }
      return ethers.utils.joinSignature({
        r: r.toString(16)._0x(),
        s: s.toString(16)._0x(),
        v: this._findCorrectV(Buffer.from(message), r, s, await this.signer())
      });
    } catch (error) {
      throw new Error(`Error signing payload: ${error}`);
    }
  }

  async healthCheck(): Promise<boolean> {
    try {
      const command = new GetPublicKeyCommand({ KeyId: this.keyId });
      await this.kmsClient.send(command);
      return true;
    } catch (error) {
      return false; // If any error occurs, the signer is not available
    }
  }

  public _findCorrectV(message: Buffer, r: bigint, s: bigint, expectedEthereumAddress: string) {
    let v = 27;
    const recoveredAddress = ethers.utils.recoverAddress(
      message,
      {
        r: r.toString(16)._0x(),
        s: s.toString(16)._0x(),
        v
      }
    );
    if (recoveredAddress.toLowerCase() != expectedEthereumAddress.toLowerCase()) {
      v = 28;
    }
    return v;
  }
}
