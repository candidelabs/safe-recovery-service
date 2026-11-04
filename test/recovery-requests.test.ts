import {ethers} from "ethers";
import {createRecoveryModule, RecoveryModule} from "../src/models/recovery-module";
import {Network} from "../src/models/network";
import {ApiError} from "../src/utils/error";
import {parseModuleFallbackDates} from "../src/config/config-manager";
import {moduleFallbackHeaders} from "../src/utils/module-fallback";
import {newOwners as newOwnersSchema} from "../src/validations/custom.validation";
import {checkRecoveryModule} from "../src/services/recovery-modules.service";
import {findByAccount, findByAccountAddress} from "../src/services/recoveries.service";

// Unit tests for requests bound to a module; no database or chain. The tables and the Safe are mocked.

// In-memory tables supporting the where clauses the read paths use (plain values, equals and in).
const mockTables: Record<string, any[]> = {};
jest.mock('../src/config/prisma-client', () => {
    const matches = (row: any, where: Record<string, any> = {}) => Object.entries(where).every(([key, condition]) => {
        if (condition !== null && typeof condition === "object" && !Array.isArray(condition)) {
            if ("equals" in condition) return row[key] === condition.equals;
            if ("in" in condition) return condition.in.includes(row[key]);
            return true;
        }
        return row[key] === condition;
    });
    const table = (name: string) => ({
        findMany: async ({where, take, skip}: any) => {
            const rows = (mockTables[name] ?? []).filter(row => matches(row, where));
            return rows.slice(skip ?? 0, take === undefined ? undefined : (skip ?? 0) + take);
        },
    });
    return {prisma: new Proxy({}, {get: (_target, name: string) => table(name)})};
});

// isModuleEnabled answers from this set (lower-case module addresses)
const mockEnabledModules = new Set<string>();
jest.mock('../src/utils/contract-source', () => ({
    getSafeInstance: (address: string) => ({
        isModuleEnabled: async (module: string) => {
            if (address === "0x0000000000000000000000000000000000000000") throw new Error("call revert exception");
            return mockEnabledModules.has(module.toLowerCase());
        },
    }),
}));

const provider = new ethers.providers.StaticJsonRpcProvider("http://127.0.0.1:1", {chainId: 1, name: "test"});
const indexer = {enabled: false, startBlock: 1};
const v0_1_0 = createRecoveryModule({address: "0x949d01d424bE050D09C16025dd007CB59b3A8c66", fallback: true, indexer}, provider);
const v0_2_0 = createRecoveryModule({address: "0x4dF6081A82E07A7cD99aEf91C72d12a5138e468B", fallback: false, indexer}, provider);

// A Network without its constructor, which starts an indexer.
const network = (fallbackModule?: RecoveryModule) => Object.assign(Object.create(Network.prototype) as Network, {
    chainId: 11155111,
    name: "test",
    modules: [v0_1_0, v0_2_0],
    fallbackModule,
});

const address = () => ethers.utils.hexlify(ethers.utils.randomBytes(20));
const statusOf = async (promise: Promise<unknown>) => promise.then(() => undefined, (e: ApiError) => [e.statusCode, e.message]);

describe('module selection', () => {
    test('uses the named module', () => {
        const selection = network(v0_1_0).resolveModule(ethers.utils.getAddress(v0_2_0.address));
        expect(selection).toEqual({module: v0_2_0, fallback: false});
    });

    test('uses the fallback when no module is named', () => {
        expect(network(v0_1_0).resolveModule(undefined)).toEqual({module: v0_1_0, fallback: true});
    });

    test('rejects a module that is not configured on the chain', () => {
        const unconfigured = "0x088f6cfD8BB1dDb1BB069CCb3fc1A98927D233f2";
        expect(() => network(v0_1_0).resolveModule(unconfigured)).toThrow("is not configured on this network (11155111)");
    });

    test('requires moduleAddress on a chain without a fallback', () => {
        expect(() => network(undefined).resolveModule(undefined)).toThrow("pass moduleAddress");
    });

    test('later steps use the module saved on the request', () => {
        expect(network(v0_1_0).requireRequestModule(v0_2_0.address)).toBe(v0_2_0);
        expect(() => network(v0_1_0).requireRequestModule("0x088f6cfd8bb1ddb1bb069ccb3fc1a98927d233f2")).toThrow("no longer configured");
        expect(() => network(v0_1_0).requireRequestModule(null)).toThrow("not bound to a recovery module yet");
    });
});

describe('module fallback deprecation', () => {
    test('formats Deprecation (RFC 9745) and Sunset (RFC 8594)', () => {
        const deprecation = new Date("2026-11-15T00:00:00Z");
        const sunset = new Date("2027-02-15T00:00:00Z");
        expect(moduleFallbackHeaders(deprecation, sunset)).toEqual({
            Deprecation: `@${deprecation.getTime() / 1000}`,
            Sunset: "Mon, 15 Feb 2027 00:00:00 GMT",
        });
    });

    test('sends each header only once its date is set', () => {
        expect(moduleFallbackHeaders(undefined, undefined)).toEqual({});
        expect(Object.keys(moduleFallbackHeaders(new Date("2026-11-15"), undefined))).toEqual(["Deprecation"]);
        expect(Object.keys(moduleFallbackHeaders(undefined, new Date("2027-02-15")))).toEqual(["Sunset"]);
    });

    test('reads the dates from the options', () => {
        expect(parseModuleFallbackDates({})).toEqual({deprecation: undefined, sunset: undefined});
        const {deprecation, sunset} = parseModuleFallbackDates({moduleFallbackDeprecation: "2026-11-15", moduleFallbackSunset: "2027-02-15T12:00:00Z"});
        expect(deprecation?.toISOString()).toBe("2026-11-15T00:00:00.000Z");
        expect(sunset?.toISOString()).toBe("2027-02-15T12:00:00.000Z");
    });

    test.each([
        ["a date that is not ISO 8601", {moduleFallbackSunset: "15/02/2027"}, "must be an ISO 8601 date"],
        ["a Sunset before the deprecation", {moduleFallbackDeprecation: "2027-02-15", moduleFallbackSunset: "2026-11-15"}, "must be later than"],
    ])('rejects %s', (_name, options, message) => {
        expect(() => parseModuleFallbackDates(options)).toThrow(message);
    });
});

describe('proposed owners', () => {
    const validate = (owners: string[]) => newOwnersSchema.validate(owners, {errors: {label: "key"}, abortEarly: false}).error?.message;

    test('accepts distinct owner addresses', () => {
        expect(validate([address(), address()])).toBeUndefined();
    });

    test.each([
        ["the zero address", ["0x0000000000000000000000000000000000000000"], "cannot be the zero address or the sentinel address"],
        ["the sentinel address", ["0x0000000000000000000000000000000000000001"], "cannot be the zero address or the sentinel address"],
        ["a duplicate in another letter case", ["0x41153290c995c8c4410d50f95D87ee86A1B07eeC", "0x41153290c995c8c4410d50f95d87ee86a1b07eec"], "contains a duplicate value"],
        ["an empty list", [], "does not contain 1 required value(s)"],
    ])('rejects %s', (_name, owners, message) => {
        expect(validate(owners)).toContain(message);
    });
});

describe('write checks', () => {
    const account = address();
    const guardian = address();
    // The module with getGuardians answering from the given list (ethers contract functions are read-only).
    const withGuardians = (module: RecoveryModule, guardians: string[]) =>
        Object.assign(Object.create(module) as RecoveryModule, {contract: {getGuardians: async () => guardians}});
    beforeEach(() => mockEnabledModules.clear());

    test('pass when the module is enabled and holds the guardians', async () => {
        mockEnabledModules.add(v0_2_0.address);
        const module = withGuardians(v0_2_0, [ethers.utils.getAddress(guardian)]);
        await expect(checkRecoveryModule(network(v0_1_0), module, account, [address()])).resolves.toEqual([guardian]);
    });

    test('reject an account that is not a Safe', async () => {
        const module = withGuardians(v0_1_0, []);
        expect(await statusOf(checkRecoveryModule(network(v0_1_0), module, "0x0000000000000000000000000000000000000000", [address()])))
            .toEqual([400, "Account address is not a safe smart contract account"]);
    });

    test('reject a module that is not enabled, even with guardians stored', async () => {
        const module = withGuardians(v0_1_0, [guardian]);
        expect(await statusOf(checkRecoveryModule(network(v0_1_0), module, account, [address()]))).toEqual([
            400,
            "The v0.1.0 (3 minutes) recovery module 0x949d01d424bE050D09C16025dd007CB59b3A8c66 is not enabled on this account; " +
            "pass moduleAddress to use the module that holds its guardians",
        ]);
    });

    test('reject a module without guardians', async () => {
        mockEnabledModules.add(v0_1_0.address);
        const module = withGuardians(v0_1_0, []);
        expect((await statusOf(checkRecoveryModule(network(v0_1_0), module, account, [address()])))![1])
            .toContain("This account has no guardians on the v0.1.0 (3 minutes) recovery module");
    });

    test('reject the account itself as a new owner', async () => {
        const module = withGuardians(v0_1_0, [guardian]);
        expect((await statusOf(checkRecoveryModule(network(v0_1_0), module, ethers.utils.getAddress(account), [account])))![1])
            .toBe("The account cannot be one of its own new owners");
    });

    test('reject a current guardian of the module as a new owner', async () => {
        mockEnabledModules.add(v0_2_0.address);
        const module = withGuardians(v0_2_0, [guardian]);
        expect((await statusOf(checkRecoveryModule(network(v0_1_0), module, account, [address(), ethers.utils.getAddress(guardian)])))![1])
            .toBe(`New owner ${guardian} is a guardian of this account; a guardian cannot be an owner`);
    });
});

describe('reads bound to a module', () => {
    const account = address();
    const owners = [address(), address()];
    const ownersHash = ethers.utils.solidityKeccak256(["address[]"], [owners]).toLowerCase();
    const hash = (n: number) => ethers.utils.hexZeroPad(ethers.utils.hexlify(n), 32);
    const request = (id: string, moduleAddress: string | null, nonce: bigint, recoveryHash: string | null) => ({
        id, account, chainId: 11155111, moduleAddress, nonce, recoveryHash, newOwners: owners, newThreshold: 1, discoverable: true,
    });
    const event = (moduleAddress: string, nonce: bigint, recoveryHash: string | null) => ({
        account, chainId: 11155111, moduleAddress, nonce, recoveryHash, newOwnersHash: ownersHash, newThreshold: 1n,
    });
    beforeEach(() => {
        // Both modules start the account's nonce at 0, so their requests share it.
        mockTables.recoveryRequest = [
            request("legacy", null, 0n, null),
            request("v0.1.0", v0_1_0.address, 0n, null),
            request("v0.2.0-executed", v0_2_0.address, 0n, hash(1)),
            request("v0.2.0-pending", v0_2_0.address, 1n, hash(2)),
        ];
        mockTables.recoveryExecutedEvent = [
            event(v0_2_0.address, 0n, hash(1)),
            // v0.1.0 events carry no recovery hash; this one matches the v0.1.0 request on owners, threshold and nonce
            event(v0_1_0.address, 0n, null),
        ];
        mockTables.recoveryFinalizedEvent = [
            // same owners, threshold and nonce as the v0.1.0 request, but emitted by v0.2.0 for another recovery
            event(v0_2_0.address, 0n, hash(9)),
        ];
    });
    const ids = (rows: {id: string}[]) => rows.map(row => row.id).sort();

    test('return the rows of the module only, never unassigned ones', async () => {
        expect(ids(await findByAccountAddress(account, 11155111, 0n, v0_1_0))).toEqual(["v0.1.0"]);
        expect(ids(await findByAccountAddress(account, 11155111, 0n, v0_2_0))).toEqual(["v0.2.0-executed"]);
        expect(ids(await findByAccount(account, 11155111, v0_2_0, {}))).toEqual(["v0.2.0-executed", "v0.2.0-pending"]);
    });

    test('match v0.2.0 events on the recovery hash', async () => {
        expect(ids(await findByAccount(account, 11155111, v0_2_0, {executed: true}))).toEqual(["v0.2.0-executed"]);
        expect(ids(await findByAccount(account, 11155111, v0_2_0, {executed: false}))).toEqual(["v0.2.0-pending"]);
        expect(ids(await findByAccount(account, 11155111, v0_2_0, {finalized: true}))).toEqual([]);
    });

    test('match v0.1.0 events on owners, threshold and nonce, from the same module only', async () => {
        expect(ids(await findByAccount(account, 11155111, v0_1_0, {executed: true}))).toEqual(["v0.1.0"]);
        expect(ids(await findByAccount(account, 11155111, v0_1_0, {finalized: true}))).toEqual([]);
        expect(ids(await findByAccount(account, 11155111, v0_1_0, {finalized: false}))).toEqual(["v0.1.0"]);
    });
});
