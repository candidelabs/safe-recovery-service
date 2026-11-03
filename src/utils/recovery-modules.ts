// Every SocialRecoveryModule variant the service supports. Each variant has the same create2 address
// on every network; the code hash is keccak256 of the runtime code (eth_getCode) and is checked after
// boot. The recovery period is an immutable without a getter, so it can only come from this table.
// The v0.1.0 modules return "0.0.1" from VERSION(); they are called v0.1.0 everywhere in this service.

export type RecoveryModuleVersion = "0.1.0" | "0.2.0";

export interface RecoveryModuleVariant {
  address: string; // lowercase
  version: RecoveryModuleVersion;
  recoveryPeriod: number; // seconds
  testnetOnly: boolean;
  codeHash: string;
}

export const RECOVERY_MODULE_VARIANTS: readonly RecoveryModuleVariant[] = [
  {address: "0x949d01d424be050d09c16025dd007cb59b3a8c66", version: "0.1.0", recoveryPeriod: 180, testnetOnly: true, codeHash: "0x1a5e700fbb0533685dc9f9b28fc89bb496d480990e6c292f2abdd3e97485d245"},
  {address: "0x38275826e1933303e508433dd5f289315da2541c", version: "0.1.0", recoveryPeriod: 259200, testnetOnly: false, codeHash: "0xdbebd5942589cb48bc55fd0d804e2a825ae485fa4eb771ec030e0ec4c330ae03"},
  {address: "0x088f6cfd8bb1ddb1bb069ccb3fc1a98927d233f2", version: "0.1.0", recoveryPeriod: 604800, testnetOnly: false, codeHash: "0xd1d497d06956a300c318dd3df28e7cbaf64dc509bf9e8674753c4f69fd50746a"},
  {address: "0x9bacd92f4687db306d7ded5d4513a51ea05df25b", version: "0.1.0", recoveryPeriod: 1209600, testnetOnly: false, codeHash: "0xf80b3e2f6c8149da85c8c40738b9d736f538bbf8f7d386c4318d13bd8f61b02e"},
  {address: "0x4df6081a82e07a7cd99aef91c72d12a5138e468b", version: "0.2.0", recoveryPeriod: 180, testnetOnly: true, codeHash: "0xc0547ec59123a73940a10008ab105d4579435baf07e2a1a0696600c0727b4d20"},
  {address: "0x00480f5ecc008995469fa7e12c70ef3dc9fee7fd", version: "0.2.0", recoveryPeriod: 259200, testnetOnly: false, codeHash: "0x154717e4e357f89fa0b32230dff1e8023ef537ee292531c2aea4542f497381b7"},
  {address: "0xeac444e2f28469e641215f129874aff8294cafe0", version: "0.2.0", recoveryPeriod: 604800, testnetOnly: false, codeHash: "0xd46c0c47dc9e3be052f61865745dfc3fac1e99abf4ad73565c6948331478c6d6"},
  {address: "0x4d92d03a47468d9fc62495d85e3f205b4616fc5c", version: "0.2.0", recoveryPeriod: 1209600, testnetOnly: false, codeHash: "0x3fd518db238b4b131340be8dad1731d79e184588529317d09f01155139e8ab3f"},
];

export const findRecoveryModuleVariant = (address: string): RecoveryModuleVariant | undefined => {
  const _address = address.toLowerCase();
  return RECOVERY_MODULE_VARIANTS.find((variant) => variant.address === _address);
};

// "3 minutes", "7 days"
export const formatRecoveryPeriod = (seconds: number): string => {
  const [value, unit] = seconds % 86400 === 0
    ? [seconds / 86400, "day"]
    : seconds % 60 === 0 ? [seconds / 60, "minute"] : [seconds, "second"];
  return `${value} ${unit}${value === 1 ? "" : "s"}`;
};
