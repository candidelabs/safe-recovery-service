import {Signer} from "./signer";

export class Signers {
  private signers: Map<string, Signer> = new Map();
  //
  private static _instance?: Signers;

  private constructor() {
    //
  }

  public static instance(): Signers {
    if (!Signers._instance) {
      Signers._instance = new Signers();
    }
    return Signers._instance;
  }

  public getSigner(id: string){
    return this.signers.get(id);
  }

  public addSigner(signer: Signer){
    this.signers.set(signer.id, signer);
  }
}