export abstract class Signer {
  public id: string;

  protected constructor(id: string) {
    this.id = id;
  }

  /**
   * Returns the address of the signer.
   */
  abstract signer(): string;

  /**
   * Signs the given payload and returns the signed result.
   * @param payload The payload to sign.
   */
  abstract sign(payload: string): string;

  /**
   * Performs a health check to determine if the signer is available.
   */
  abstract healthCheck(): boolean;
}