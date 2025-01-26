import {Signer} from "./signer";
import {ethers} from "ethers";

export class PrivateKeySigner extends Signer {
  private _signer: ethers.Wallet;

  constructor(id: string, privateKey: string) {
    super(id);
    this._signer = new ethers.Wallet(privateKey);
  }

  async signer(): Promise<string> {
    return this._signer.address;
  }

  async sign(payload: string): Promise<string> {
    return this._signer.signMessage(payload);
  }

  async healthCheck(): Promise<boolean> {
    return true;
  }
}