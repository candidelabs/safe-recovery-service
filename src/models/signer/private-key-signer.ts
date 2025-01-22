import {Signer} from "./signer";

export class PrivateKeySigner extends Signer {
  private privateKey: string;

  constructor(id: string, privateKey: string) {
    super(id);
    this.privateKey = privateKey;
  }

  signer(): string {
    return "";
  }

  sign(payload: string): string {
    return "";
  }

  healthCheck(): boolean {
    return false;
  }
}