import * as dotenv from 'dotenv'
import {ethers} from "ethers";
import {createRecoveryModule, RecoveryModule} from "../src/models/recovery-module";
import {RECOVERY_MODULE_VARIANTS, formatRecoveryPeriod} from "../src/utils/recovery-modules";
import {parseRecoveryModules} from "../src/config/config-manager";
import {EventType} from "../src/utils/constants";
import {GuardianAddedEvent} from "../src/models/events/guardian-added-event";
import {ChangedThresholdEvent} from "../src/models/events/changed-threshold-event";
import {RecoveryExecutedEvent} from "../src/models/events/recovery-executed-event";
import {RecoveryFinalizedEvent} from "../src/models/events/recovery-finalized-event";
import {RecoveryCanceledEvent} from "../src/models/events/recovery-canceled-event";
import {assignLegacyRows} from "../src/services/recovery-modules.service";
import {Network} from "../src/models/network";

jest.setTimeout(120000);
dotenv.config()

// In-memory stand-in for the tables assignLegacyRows touches, so this suite needs no database.
type MockRow = {id: string, chainId: number, moduleAddress: string | null, latestIndexedBlock?: number};
const mockTables: Record<string, MockRow[]> = {};
jest.mock('../src/config/prisma-client', () => {
    const matches = (row: any, where: Record<string, unknown>) => Object.entries(where).every(([k, v]) => row[k] === v);
    const rows = (name: string) => mockTables[name] ?? [];
    const table = (name: string) => ({
        count: async ({where}: any) => rows(name).filter(r => matches(r, where)).length,
        findFirst: async ({where}: any) => rows(name).find(r => matches(r, where)) ?? null,
        update: async ({where, data}: any) => Object.assign(rows(name).find(r => r.id === where.id)!, data),
        updateMany: async ({where, data}: any) => {
            const matched = rows(name).filter(r => matches(r, where));
            matched.forEach(r => Object.assign(r, data));
            return {count: matched.length};
        },
    });
    return {prisma: new Proxy({}, {get: (_target, name: string) => table(name)})};
});

// Decoders, registry and config shapes; no database or chain needed, except for the code hash check.
const provider = new ethers.providers.StaticJsonRpcProvider("http://127.0.0.1:1", {chainId: 1, name: "test"});
const V0_1_0_3_MINUTES = "0x949d01d424bE050D09C16025dd007CB59b3A8c66";
const V0_1_0_7_DAYS = "0x088f6cfD8BB1dDb1BB069CCb3fc1A98927D233f2";
const V0_2_0_3_MINUTES = "0x4dF6081A82E07A7cD99aEf91C72d12a5138e468B";
const V0_2_0_7_DAYS = "0xEaC444E2F28469E641215F129874Aff8294cAfE0";
const indexer = {enabled: true, startBlock: 1};

const v0_1_0 = createRecoveryModule({address: V0_1_0_7_DAYS, fallback: true, indexer}, provider);
const v0_2_0 = createRecoveryModule({address: V0_2_0_7_DAYS, fallback: false, indexer}, provider);

const account = ethers.Wallet.createRandom().address;
const guardian = ethers.Wallet.createRandom().address;
const newOwners = [ethers.Wallet.createRandom().address, ethers.Wallet.createRandom().address];
const recoveryHash = ethers.utils.hexlify(ethers.utils.randomBytes(32));
const transactionHash = ethers.utils.hexlify(ethers.utils.randomBytes(32));

// Built by hand rather than with Interface.encodeEventLog, which cannot encode an indexed array. Per
// the Solidity ABI spec an indexed address[] is keccak256 of its elements, each padded to 32 bytes.
const buildLog = (module: RecoveryModule, eventName: string, values: any[]): ethers.providers.Log => {
    const iface = module.contract.interface;
    const event = iface.getEvent(eventName);
    const topics = [iface.getEventTopic(event)];
    const dataTypes: ethers.utils.ParamType[] = [];
    const dataValues: any[] = [];
    event.inputs.forEach((input, i) => {
        if (!input.indexed) {
            dataTypes.push(input);
            dataValues.push(values[i]);
        } else if (input.baseType === "array") {
            topics.push(ethers.utils.keccak256(ethers.utils.concat((values[i] as string[]).map(v => ethers.utils.hexZeroPad(v, 32)))));
        } else {
            topics.push(ethers.utils.defaultAbiCoder.encode([input], [values[i]]));
        }
    });
    const data = ethers.utils.defaultAbiCoder.encode(dataTypes, dataValues);
    return {
        address: ethers.utils.getAddress(module.address),
        topics,
        data,
        blockNumber: 100,
        blockHash: ethers.constants.HashZero,
        transactionIndex: 2,
        transactionHash,
        logIndex: 3,
        removed: false,
    };
};

describe('recovery module registry', () => {
    test('lists the eight pinned variants', () => {
        expect(RECOVERY_MODULE_VARIANTS).toHaveLength(8);
        expect(new Set(RECOVERY_MODULE_VARIANTS.map(v => v.address)).size).toBe(8);
        for (const variant of RECOVERY_MODULE_VARIANTS) {
            expect(variant.address).toBe(variant.address.toLowerCase());
            expect(variant.testnetOnly).toBe(variant.recoveryPeriod === 180);
        }
    });

    test('formats recovery periods', () => {
        expect(formatRecoveryPeriod(180)).toBe("3 minutes");
        expect(formatRecoveryPeriod(86400)).toBe("1 day");
        expect(formatRecoveryPeriod(1209600)).toBe("14 days");
    });

    test('rejects an address that is not pinned', () => {
        expect(() => createRecoveryModule({address: ethers.Wallet.createRandom().address, fallback: false, indexer}, provider))
            .toThrow("not a known SocialRecoveryModule deployment");
    });

    test('labels modules with version and recovery period', () => {
        expect(v0_1_0.version).toBe("0.1.0");
        expect(v0_1_0.label).toBe("v0.1.0 (7 days)");
        expect(v0_2_0.label).toBe("v0.2.0 (7 days)");
        expect(v0_2_0.address).toBe(V0_2_0_7_DAYS.toLowerCase());
    });

    // Every pinned variant deployed on the test chain must run its pinned code. v0.1.0 is deployed on
    // every testnet the suite runs on; v0.2.0 is not yet everywhere.
    const jsonRpcNodeProvider = process.env.JSON_RPC_NODE_PROVIDER_1;
    (jsonRpcNodeProvider ? test : test.skip)('pinned code hashes match the test chain', async () => {
        const chain = new ethers.providers.StaticJsonRpcProvider(jsonRpcNodeProvider);
        for (const variant of RECOVERY_MODULE_VARIANTS) {
            const code = await chain.getCode(variant.address);
            if (code === "0x") {
                expect(variant.version).toBe("0.2.0");
                continue;
            }
            expect(ethers.utils.keccak256(code)).toBe(variant.codeHash);
        }
    });
});

describe('recovery module topics', () => {
    test('guardian event topics are shared, recovery event topics differ', () => {
        const topicOf = (module: RecoveryModule, type: EventType) =>
            Object.entries(module.topics).find(([, t]) => t === type)![0];
        for (const type of [EventType.GuardianAdded, EventType.GuardianRevoked, EventType.ChangedThreshold]) {
            expect(topicOf(v0_1_0, type)).toBe(topicOf(v0_2_0, type));
        }
        expect(topicOf(v0_1_0, EventType.RecoveryExecuted)).toBe("0x1fa74635dcccfa96011b50295a26dd08b8c3c6ca7d66ede450288192674ebf01");
        expect(topicOf(v0_2_0, EventType.RecoveryExecuted)).toBe("0xdccb7d47b2514591457eba0cfab01095a55b15ac3183c296e78c7b85b378ab6c");
        expect(topicOf(v0_2_0, EventType.RecoveryFinalized)).toBe("0x1c5a119dcc04bc3a1ad3502b39ebca10bfe91a7d258d7402ab7df29d7a77e820");
        expect(topicOf(v0_2_0, EventType.RecoveryCanceled)).toBe("0xe1fa8618f0194bbf2ebd959b65ff826734379fb0c50337586eb96ad8967d7f1b");
    });

    test('execution selectors match the deployed versions', () => {
        expect(v0_1_0.contract.interface.getSighash("multiConfirmRecovery")).toBe("0x0728e1e7");
        expect(v0_2_0.contract.interface.getSighash("multiConfirmRecovery")).toBe("0x9771fa44");
    });
});

describe('recovery module log decoding', () => {
    test('decodes guardian events on both versions', () => {
        for (const module of [v0_1_0, v0_2_0]) {
            const added = module.decodeLog(buildLog(module, "GuardianAdded", [account, guardian]), 10) as GuardianAddedEvent;
            expect(added.eventType).toBe(EventType.GuardianAdded);
            expect(added.moduleAddress).toBe(module.address);
            expect(added.account).toBe(account.toLowerCase());
            expect(added.guardian).toBe(guardian.toLowerCase());
            expect([added.chainId, added.blockNumber, added.transactionIndex, added.logIndex]).toEqual([10, 100, 2, 3]);
            const threshold = module.decodeLog(buildLog(module, "ChangedThreshold", [account, 2]), 10) as ChangedThresholdEvent;
            expect(threshold.newThreshold).toBe(2n);
        }
    });

    test('decodes v0.1.0 recovery events', () => {
        const log = buildLog(v0_1_0, "RecoveryExecuted", [account, newOwners, 1, 4, 1700000000, 2]);
        const executed = v0_1_0.decodeLog(log, 10) as RecoveryExecutedEvent;
        expect(executed.eventType).toBe(EventType.RecoveryExecuted);
        expect(executed.newOwnersHash).toBe(log.topics[2]);
        expect([executed.newThreshold, executed.nonce, executed.executeAfter, executed.guardiansApprovalCount]).toEqual([1n, 4n, 1700000000n, 2n]);
        expect(executed.recoveryHash).toBeUndefined();
        expect(executed.newOwners).toBeUndefined();

        const finalized = v0_1_0.decodeLog(buildLog(v0_1_0, "RecoveryFinalized", [account, newOwners, 1, 4]), 10) as RecoveryFinalizedEvent;
        expect(finalized.newOwnersHash).toBe(executed.newOwnersHash);
        expect(finalized.nonce).toBe(4n);

        const canceled = v0_1_0.decodeLog(buildLog(v0_1_0, "RecoveryCanceled", [account, 4]), 10) as RecoveryCanceledEvent;
        expect(canceled.eventType).toBe(EventType.RecoveryCanceled);
        expect(canceled.nonce).toBe(4n);
    });

    test('decodes v0.2.0 recovery events and computes the same owners hash as v0.1.0', () => {
        const v0_1_0Hash = v0_1_0.decodeLog(buildLog(v0_1_0, "RecoveryExecuted", [account, newOwners, 1, 4, 1700000000, 2]), 10) as RecoveryExecutedEvent;
        const executed = v0_2_0.decodeLog(buildLog(v0_2_0, "RecoveryExecuted", [account, recoveryHash, newOwners, 1, 4, 1700000000, 2]), 10) as RecoveryExecutedEvent;
        expect(executed.eventType).toBe(EventType.RecoveryExecuted);
        expect(executed.moduleAddress).toBe(v0_2_0.address);
        expect(executed.recoveryHash).toBe(recoveryHash.toLowerCase());
        expect(executed.newOwners).toEqual(newOwners.map(o => o.toLowerCase()));
        expect(executed.newOwnersHash).toBe(v0_1_0Hash.newOwnersHash);
        expect([executed.newThreshold, executed.nonce, executed.executeAfter, executed.guardiansApprovalCount]).toEqual([1n, 4n, 1700000000n, 2n]);

        const finalized = v0_2_0.decodeLog(buildLog(v0_2_0, "RecoveryFinalized", [account, recoveryHash, newOwners, 1, 4]), 10) as RecoveryFinalizedEvent;
        expect(finalized.newOwnersHash).toBe(v0_1_0Hash.newOwnersHash);
        expect(finalized.recoveryHash).toBe(recoveryHash.toLowerCase());

        const canceled = v0_2_0.decodeLog(buildLog(v0_2_0, "RecoveryCanceled", [account, recoveryHash, 5]), 10) as RecoveryCanceledEvent;
        expect(canceled.nonce).toBe(5n);
        expect(canceled.recoveryHash).toBe(recoveryHash.toLowerCase());
    });

    test('ignores events the indexer does not store', () => {
        expect(v0_2_0.decodeLog(buildLog(v0_2_0, "NonceInvalidated", [account, 1]), 10)).toBeUndefined();
        expect(v0_2_0.decodeLog(buildLog(v0_2_0, "RecoveryConfirmed", [account, guardian, recoveryHash, newOwners, 1, 4]), 10)).toBeUndefined();
    });
});

describe('recoveryModules config', () => {
    const network = (fields: Record<string, any>) => ({enabled: true, chainId: 1, jsonRpcEndpoint: "http://127.0.0.1:1", ...fields}) as any;

    test('reads the legacy recoveryModuleAddress as a one-entry list with the fallback', () => {
        const modules = parseRecoveryModules("test", network({
            recoveryModuleAddress: V0_1_0_3_MINUTES,
            indexer: {enabled: "true", startBlock: "4337"},
        }));
        expect(modules).toEqual([{address: V0_1_0_3_MINUTES.toLowerCase(), fallback: true, legacy: true, indexer: {enabled: true, startBlock: 4337}}]);
    });

    test('reads recoveryModules', () => {
        const modules = parseRecoveryModules("test", network({
            recoveryModules: [
                {address: V0_1_0_3_MINUTES, fallback: true, indexer: {enabled: true, startBlock: 1}},
                {address: V0_2_0_3_MINUTES, indexer: {enabled: false, startBlock: 2}},
            ],
        }));
        expect(modules.map(m => [m.address, m.fallback, m.indexer.enabled])).toEqual([
            [V0_1_0_3_MINUTES.toLowerCase(), true, true],
            [V0_2_0_3_MINUTES.toLowerCase(), false, false],
        ]);
        expect(modules.some(m => m.legacy)).toBe(false);
    });

    test.each([
        ["both shapes", {recoveryModuleAddress: V0_1_0_3_MINUTES, recoveryModules: []}, "cannot have both"],
        ["no module", {indexer}, "must have 'recoveryModules'"],
        ["an empty list", {recoveryModules: []}, "non-empty list"],
        ["a network indexer block", {recoveryModules: [{address: V0_1_0_3_MINUTES, indexer}], indexer}, "each module has its own"],
        ["an unknown address", {recoveryModules: [{address: ethers.Wallet.createRandom().address, indexer}]}, "not a known SocialRecoveryModule"],
        ["a duplicate", {recoveryModules: [{address: V0_1_0_3_MINUTES, indexer}, {address: V0_1_0_3_MINUTES.toLowerCase(), indexer}]}, "more than once"],
        ["two fallbacks", {recoveryModules: [{address: V0_1_0_3_MINUTES, fallback: true, indexer}, {address: V0_1_0_7_DAYS, fallback: true, indexer}]}, "only one fallback"],
        ["a v0.2.0 fallback", {recoveryModules: [{address: V0_2_0_3_MINUTES, fallback: true, indexer}]}, "only a v0.1.0 module can be the fallback"],
        ["a module without indexer", {recoveryModules: [{address: V0_2_0_3_MINUTES}]}, "must have an 'indexer'"],
    ])('rejects %s', (_name, fields, message) => {
        expect(() => parseRecoveryModules("test", network(fields))).toThrow(message);
    });
});

describe('rows indexed before modules were tracked', () => {
    // Only the fields assignLegacyRows reads.
    const network = (legacyModule?: RecoveryModule) => ({chainId: 10, name: "test", legacyModule}) as unknown as Network;
    const seed = () => {
        mockTables.indexerData = [
            {id: "cursor", chainId: 10, moduleAddress: null, latestIndexedBlock: 500},
            {id: "other-chain", chainId: 1, moduleAddress: null, latestIndexedBlock: 9},
        ];
        mockTables.guardianAddedEvent = [{id: "a", chainId: 10, moduleAddress: null}, {id: "b", chainId: 1, moduleAddress: null}];
        mockTables.recoveryExecutedEvent = [{id: "c", chainId: 10, moduleAddress: null}];
    };

    test('go to the module of a legacy recoveryModuleAddress config', async () => {
        seed();
        await assignLegacyRows(network(v0_1_0));
        expect(mockTables.indexerData.map(r => r.moduleAddress)).toEqual([v0_1_0.address, null]);
        expect(mockTables.guardianAddedEvent.map(r => r.moduleAddress)).toEqual([v0_1_0.address, null]);
        expect(mockTables.recoveryExecutedEvent[0].moduleAddress).toBe(v0_1_0.address);
    });

    test('block recoveryModules, which cannot say which module they came from', async () => {
        seed();
        await expect(assignLegacyRows(network(undefined))).rejects.toThrow("3 rows indexed before recovery modules were tracked");
        expect(mockTables.indexerData[0].moduleAddress).toBeNull();
        expect(mockTables.guardianAddedEvent[0].moduleAddress).toBeNull();
    });

    test('no longer block recoveryModules once assigned', async () => {
        seed();
        await assignLegacyRows(network(v0_1_0));
        await expect(assignLegacyRows(network(undefined))).resolves.toBeUndefined();
    });
});
