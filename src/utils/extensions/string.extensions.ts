declare global {
  interface String {
    _0x(isEthereumAddress?: boolean): string;
    _0xRemove(): string;
  }
}

String.prototype._0x = function (isEthereumAddress = false): string {
  let hex = this.replace("0x", "");
  if (isEthereumAddress) {
    if (hex.length > 40) {
      throw new Error("Hex string exceeds 20 bytes (40 characters) for an Ethereum address.");
    }
    hex = hex.padStart(40, "0"); // Ensure the string is 40 characters (20 bytes) long
  }
  return "0x" + hex;
};


String.prototype._0xRemove = function (): string {
  return this.replace("0x", "");
};

export {}