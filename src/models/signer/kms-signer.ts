import {Signer} from "./signer";

export class KMSSigner extends Signer {

  constructor(id: string) {
    super(id);
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