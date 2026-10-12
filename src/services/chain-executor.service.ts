import Logger from "utils/logger";
import {Network} from "../models/network";
import {Signers} from "../models/signer/signers";
import {populateTxGasPricesAndLimits, scaleBigNumber} from "../utils";
import {ethers} from "ethers";

// Transient failures (RPC/network/signer errors, nonce races, ...) back off exponentially.
const MAX_RETRIES = 30;
const BASE_RETRY_DELAY_MS = 5 * 1_000;
const MAX_RETRY_DELAY_MS = 15 * 60 * 1_000;
// Bounds the wait for a broadcast to mine; past this it is re-broadcast at once as a
// same-nonce replacement with bumped fees, so a stuck tx can't freeze the per-signer queue.
const CONFIRMATION_TIMEOUT_MS = 3 * 60 * 1_000;
// Fee bumps compound (+12.5% each), so cap them per phase; after that we keep waiting without bumping.
const MAX_REPLACEMENTS = 10;
// Hard bound on wall-clock spent trying to land one payload, from its first attempt.
const MAX_TX_LIFETIME_MS = 2 * 60 * 60 * 1_000;
// Once we give up on a broadcast payload, how long we spend trying to cancel its nonce
// (a 0-value self-transfer at bumped fees) so the next transaction isn't queued behind it.
const CANCEL_LIFETIME_MS = 30 * 60 * 1_000;
// Applied to the fee floor when a node rejects a replacement as underpriced.
const UNDERPRICED_FLOOR_BUMP = 1.125;

type Fees = { maxFeePerGas: ethers.BigNumber; maxPriorityFeePerGas: ethers.BigNumber };

interface TransactionData {
  to: string;
  callData: string;
  value: bigint;
  chainId: number;
  signerId: string;
  callback?: (success: boolean, transactionHash: string) => Promise<void>;
  // "execute" lands the payload; "cancel" tries to free its nonce after giving up on it.
  phase?: "execute" | "cancel";
  // Transient failures in the current phase (drives the backoff schedule).
  retries?: number;
  // Fee-bumped re-broadcasts of the same nonce in the current phase.
  replacements?: number;
  // Wall-clock start of the current phase.
  phaseStartedAt?: number;
  // Replacement bookkeeping: last broadcast nonce/fees/gas limit, and every hash broadcast
  // (payload and cancel alike; cancelHashes tells them apart).
  nonce?: number;
  lastFees?: Fees;
  lastGasLimit?: string;
  hashes?: string[];
  cancelHashes?: string[];
  // Fees of the most recent send attempt, whether or not the node accepted it.
  lastAttemptFees?: Fees;
  // Why and after how many retries the execute phase gave up; reported once the cancel phase settles.
  terminalReason?: ChainExecutorFailureReason;
  terminalError?: unknown;
  terminalRetries?: number;
}

export type ChainExecutorFailureReason =
  // Pre-broadcast: the node reports the call would revert. Nothing is on chain.
  | "would-revert"
  // MAX_RETRIES transient failures.
  | "retries-exhausted"
  // MAX_TX_LIFETIME_MS elapsed since the first attempt.
  | "expired";

export interface FailedTransaction {
  to: string;
  callData: string;
  value: bigint;
  chainId: number;
  signerId: string;
  retries: number;
  reason: ChainExecutorFailureReason;
  // Set when at least one broadcast happened (payload and cancel hashes alike).
  nonce?: number;
  hashes?: string[];
  // True when that nonce is known to be consumed (by our cancel or by an external tx), or
  // nothing was ever broadcast. False means it may still be pending and the payload may still land.
  nonceResolved: boolean;
  lastError: unknown;
}

export type ChainExecutorFailureListener = (failure: FailedTransaction) => void;

type FailureDecision =
  | { kind: "retry"; delayMs: number; why: string }
  | { kind: "fail"; reason: ChainExecutorFailureReason; error: unknown; nonceResolved: boolean };

type AttemptOutcome =
  // The payload landed; the caller checks receipt.status.
  | { kind: "mined"; receipt: ethers.providers.TransactionReceipt }
  // Cancel phase: the nonce was consumed by our cancel or by an external tx, so the payload is dead.
  | { kind: "nonce-resolved" };

// Raised by waitFor() when the broadcast is still unmined after CONFIRMATION_TIMEOUT_MS.
class ConfirmationTimeoutError extends Error {
  constructor(public readonly hash: string) {
    super(`transaction not mined within ${CONFIRMATION_TIMEOUT_MS}ms : ${hash}`);
  }
}

// Raised by an attempt that found nothing mined after the current phase's lifetime.
class PhaseExpiredError extends Error {
  constructor(transactionData: TransactionData) {
    const phase = transactionData.phase ?? "execute";
    const lifetime = phase === "cancel" ? CANCEL_LIFETIME_MS : MAX_TX_LIFETIME_MS;
    const pending = transactionData.hashes?.length
      ? ` (nonce ${transactionData.nonce} may still be pending : ${transactionData.hashes.join(", ")})`
      : "";
    super(`${phase} phase exceeded its ${lifetime}ms lifetime${pending}`);
  }
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

// ethers nests the node's own message under error.error.message for SERVER_ERROR.
function errorMessage(error: unknown): string {
  if (typeof error !== "object" || error === null) return String(error);
  const e = error as { message?: unknown; error?: { message?: unknown } };
  return [e.message, e.error?.message].filter((m) => typeof m === "string").join(" | ");
}

// Nodes answer a re-send of a signed tx they already hold with one of these.
function isAlreadyKnown(error: unknown): boolean {
  return /already known|known transaction|already exists|already imported|AlreadyKnown/i.test(errorMessage(error));
}

function bump(fees: Fees, factor: number): Fees {
  return {
    maxFeePerGas: scaleBigNumber(fees.maxFeePerGas, factor),
    maxPriorityFeePerGas: scaleBigNumber(fees.maxPriorityFeePerGas, factor),
  };
}

export class ChainExecutor {
  private static _instance: ChainExecutor;
  private queues: Map<number, Map<string, TransactionData[]>>; // chainId -> signerId -> transaction queue
  private processing: Map<number, Map<string, boolean>>; // Tracks processing status for each signer on each chain
  private static failureListeners: ChainExecutorFailureListener[] = [];

  private constructor() {
    this.queues = new Map();
    this.processing = new Map();
  }

  public static instance(): ChainExecutor {
    if (!ChainExecutor._instance) {
      ChainExecutor._instance = new ChainExecutor();
    }
    return ChainExecutor._instance;
  }

  // Fires once per transaction when the executor gives up on it (see FailedTransaction.reason).
  public static addFailureListener(listener: ChainExecutorFailureListener): void {
    ChainExecutor.failureListeners.push(listener);
  }

  public addTransaction(transaction: TransactionData): void {
    const { chainId, signerId } = transaction;

    if (!this.queues.has(chainId)) {
      this.queues.set(chainId, new Map());
    }
    if (!this.queues.get(chainId)!.has(signerId)) {
      this.queues.get(chainId)!.set(signerId, []);
    }

    this.queues.get(chainId)!.get(signerId)!.push(transaction);
    this.processNext(chainId, signerId);
  }

  private async processNext(chainId: number, signerId: string): Promise<void> {
    if (this.isProcessing(chainId, signerId)) return;
    const queue = this.queues.get(chainId)?.get(signerId);
    if (!queue || queue.length === 0) return;
    this.setProcessing(chainId, signerId, true);

    // Keep the head in place; nonce ordering requires it to settle before the rest.
    const transactionData = queue[0];
    transactionData.phase ??= "execute";
    transactionData.phaseStartedAt ??= Date.now();
    let retryDelayMs: number | null = null;
    try {
      const outcome = await this.attempt(chainId, signerId, transactionData);
      queue.shift();
      if (outcome.kind === "nonce-resolved") {
        this.reportFailure(transactionData, transactionData.terminalReason!, transactionData.terminalError, true);
      } else {
        const receipt = outcome.receipt;
        if (receipt.status === 0) {
          // Mined but reverted: terminal (nonce is spent), report failure.
          Logger.error(`Chain executor transaction mined but reverted : ${receipt.transactionHash}`);
        }
        this.safeCallback(transactionData, receipt.status === 1, receipt.transactionHash);
      }
    } catch (error) {
      const decision = this.classifyFailure(transactionData, error);
      if (decision.kind === "retry") {
        Logger.error(`Chain executor ${transactionData.phase} attempt failed (${decision.why}), retrying in ${decision.delayMs}ms : ${error}`);
        retryDelayMs = decision.delayMs;
      } else {
        queue.shift();
        this.reportFailure(transactionData, decision.reason, decision.error, decision.nonceResolved);
      }
    }

    if (retryDelayMs !== null) {
      // Hold the lock across the backoff so the head isn't re-sent early and
      // later transactions can't jump ahead of it.
      setTimeout(() => {
        this.setProcessing(chainId, signerId, false);
        this.processNext(chainId, signerId);
      }, retryDelayMs);
    } else {
      this.setProcessing(chainId, signerId, false);
      this.processNext(chainId, signerId);
    }
  }

  // Decides whether a failed attempt is retried (and how soon) or ends the current phase.
  private classifyFailure(transactionData: TransactionData, error: unknown): FailureDecision {
    const phase = transactionData.phase ?? "execute";
    const broadcast = (transactionData.hashes?.length ?? 0) > 0;

    // Still unmined after the confirmation window: re-broadcast with bumped fees right away.
    // Past the phase lifetime, the next attempt only settles and then raises PhaseExpiredError.
    if (error instanceof ConfirmationTimeoutError) {
      return { kind: "retry", delayMs: 0, why: "confirmation timeout" };
    }

    if (error instanceof PhaseExpiredError) {
      return this.giveUp(transactionData, "expired", error);
    }

    if (this.phaseExpired(transactionData)) {
      // If something was broadcast, run one last settle pass so a tx that mined during
      // the backoff is still reported as success; it raises PhaseExpiredError otherwise.
      return broadcast
        ? { kind: "retry", delayMs: 0, why: "lifetime exceeded, settling" }
        : this.giveUp(transactionData, "expired", error);
    }

    const code = errorCode(error);

    // The node says the call would revert. Nothing is on chain (replacements never
    // re-estimate), so retrying can only burn time for everything queued behind it.
    if (phase === "execute" && !broadcast
      && (code === ethers.errors.UNPREDICTABLE_GAS_LIMIT || code === ethers.errors.CALL_EXCEPTION)) {
      return this.giveUp(transactionData, "would-revert", error);
    }

    // Our fees didn't clear the node's replacement threshold (our own last broadcast, or a
    // stale tx we're replacing whose fees we don't know): raise the floor above what we just
    // tried, otherwise every retry would resend the same fees and hit the same rejection.
    if (code === ethers.errors.REPLACEMENT_UNDERPRICED) {
      const base = transactionData.lastAttemptFees ?? transactionData.lastFees;
      if (base) transactionData.lastFees = bump(base, UNDERPRICED_FLOOR_BUMP);
    }

    // Everything else is assumed transient.
    const retries = (transactionData.retries ?? 0) + 1;
    if (retries > MAX_RETRIES) {
      return this.giveUp(transactionData, "retries-exhausted", error);
    }
    transactionData.retries = retries;
    return {
      kind: "retry",
      delayMs: Math.min(BASE_RETRY_DELAY_MS * Math.pow(2, retries - 1), MAX_RETRY_DELAY_MS),
      why: `transient, retry ${retries}/${MAX_RETRIES}`,
    };
  }

  // Ends the current phase. Giving up on a payload that was broadcast moves to the cancel
  // phase so its nonce doesn't stay pending under the next transaction; anything else is terminal.
  private giveUp(transactionData: TransactionData, reason: ChainExecutorFailureReason, error: unknown): FailureDecision {
    const phase = transactionData.phase ?? "execute";
    const broadcast = (transactionData.hashes?.length ?? 0) > 0;
    if (phase === "cancel") {
      // The cancel didn't land either: report the original failure, nonce possibly still pending.
      return { kind: "fail", reason: transactionData.terminalReason!, error: transactionData.terminalError, nonceResolved: false };
    }
    if (!broadcast) {
      return { kind: "fail", reason, error, nonceResolved: true };
    }
    Logger.error(`Chain executor giving up on transaction (${reason}), cancelling nonce ${transactionData.nonce} : ${error}`);
    transactionData.phase = "cancel";
    transactionData.phaseStartedAt = Date.now();
    transactionData.terminalReason = reason;
    transactionData.terminalError = error;
    transactionData.terminalRetries = transactionData.retries ?? 0;
    transactionData.retries = 0;
    transactionData.replacements = 0;
    return { kind: "retry", delayMs: 0, why: "starting cancel phase" };
  }

  private phaseExpired(transactionData: TransactionData): boolean {
    const lifetime = (transactionData.phase ?? "execute") === "cancel" ? CANCEL_LIFETIME_MS : MAX_TX_LIFETIME_MS;
    return Date.now() - transactionData.phaseStartedAt! >= lifetime;
  }

  // One attempt of the current phase: settle any earlier broadcast, then broadcast (or
  // replace) and wait up to CONFIRMATION_TIMEOUT_MS. Throws ConfirmationTimeoutError if not
  // mined in time, PhaseExpiredError once the phase lifetime is spent, or the underlying error.
  private async attempt(
    chainId: number,
    signerId: string,
    transactionData: TransactionData
  ): Promise<AttemptOutcome> {
    const network = Network.instances.get(chainId.toString())!;
    const signer = Signers.instance().getSigner(signerId)!;
    const signerAddress = await signer.signer();
    const provider = network.jsonRPCProvider;
    const phase = transactionData.phase ?? "execute";

    // On a retry, settle the previous attempt before broadcasting a replacement.
    if (transactionData.nonce !== undefined && transactionData.hashes?.length) {
      const minedCount = await provider.getTransactionCount(signerAddress, "latest");
      if (minedCount > transactionData.nonce) {
        // Nonce already mined: return the outcome if one of our hashes landed.
        for (const hash of transactionData.hashes) {
          const priorReceipt = await provider.getTransactionReceipt(hash);
          if (!priorReceipt) continue;
          return transactionData.cancelHashes?.includes(hash)
            ? { kind: "nonce-resolved" }
            : { kind: "mined", receipt: priorReceipt };
        }
        // An untracked (e.g. external) tx took the nonce.
        if (phase === "cancel") return { kind: "nonce-resolved" };
        // Start over with a fresh nonce and estimate.
        transactionData.nonce = undefined;
        transactionData.lastFees = undefined;
        transactionData.lastGasLimit = undefined;
        transactionData.hashes = undefined;
        transactionData.lastAttemptFees = undefined;
      }
    }

    if (this.phaseExpired(transactionData)) {
      throw new PhaseExpiredError(transactionData);
    }

    const replacing = transactionData.nonce !== undefined;
    if (replacing && (transactionData.replacements ?? 0) >= MAX_REPLACEMENTS) {
      // Bump budget spent: keep waiting on the latest broadcast instead of escalating further.
      return this.waitFor(provider, transactionData.hashes![transactionData.hashes!.length - 1], transactionData);
    }

    const nonce = replacing ? transactionData.nonce! : await this.nextNonce(provider, signerAddress);
    const transaction = phase === "cancel"
      // 0-value self-transfer; gas is estimated since the intrinsic cost differs across chains.
      ? await populateTxGasPricesAndLimits(network, signerAddress, signerAddress, 0n, "0x", nonce, transactionData.lastFees)
      : await populateTxGasPricesAndLimits(
        network,
        signerAddress,
        transactionData.to,
        transactionData.value,
        transactionData.callData,
        nonce,
        transactionData.lastFees,
        transactionData.lastGasLimit
      );
    transactionData.lastAttemptFees = {
      maxFeePerGas: ethers.BigNumber.from(transaction.maxFeePerGas),
      maxPriorityFeePerGas: ethers.BigNumber.from(transaction.maxPriorityFeePerGas),
    };
    const serializedUnsignedTx = ethers.utils.serializeTransaction(transaction);
    const unsignedTxHash = ethers.utils.keccak256(serializedUnsignedTx);
    const signature = await signer.sign(unsignedTxHash);
    const serializedSignedTransaction = ethers.utils.serializeTransaction(transaction, signature);
    const hash = await this.broadcast(provider, serializedSignedTransaction);

    // Commit bookkeeping only once the node holds the transaction.
    transactionData.nonce = nonce;
    transactionData.lastFees = transactionData.lastAttemptFees;
    if (phase === "execute") {
      transactionData.lastGasLimit = ethers.utils.hexValue(transaction.gasLimit!);
    } else {
      (transactionData.cancelHashes ??= []).push(hash);
    }
    (transactionData.hashes ??= []).push(hash);
    if (replacing) {
      transactionData.replacements = (transactionData.replacements ?? 0) + 1;
    }

    return this.waitFor(provider, hash, transactionData);
  }

  // The signer key is used by this service only and each (chainId, signerId) queue is
  // serialized, so by the time a new payload is sent nothing of ours should be pending.
  // Anything still pending (a previous process life, or a nonce we gave up on without a
  // cancel landing) is stale: build on "latest" so this transaction replaces it instead
  // of queueing behind it. "pending" is fetched only to log the gap.
  private async nextNonce(provider: ethers.providers.JsonRpcProvider, signerAddress: string): Promise<number> {
    const [latest, pending] = await Promise.all([
      provider.getTransactionCount(signerAddress, "latest"),
      provider.getTransactionCount(signerAddress, "pending"),
    ]);
    if (pending > latest) {
      Logger.warn(`Chain executor found ${pending - latest} stale pending transaction(s) for ${signerAddress} from nonce ${latest}, replacing`);
    }
    return latest;
  }

  // Sends a signed transaction and returns its hash. A node that already holds this exact
  // transaction (e.g. the previous send's response was lost) answers "already known"; that
  // is a successful broadcast as far as we're concerned.
  private async broadcast(provider: ethers.providers.JsonRpcProvider, serializedSignedTransaction: string): Promise<string> {
    const hash = ethers.utils.keccak256(serializedSignedTransaction);
    try {
      await provider.sendTransaction(serializedSignedTransaction);
    } catch (error) {
      if (!isAlreadyKnown(error)) throw error;
      Logger.warn(`Chain executor transaction already known to the node, treating as broadcast : ${hash}`);
    }
    return hash;
  }

  // Waits for one confirmation, surfacing the bounded wait as ConfirmationTimeoutError.
  private async waitFor(
    provider: ethers.providers.JsonRpcProvider,
    hash: string,
    transactionData: TransactionData
  ): Promise<AttemptOutcome> {
    let receipt: ethers.providers.TransactionReceipt;
    try {
      receipt = await provider.waitForTransaction(hash, 1, CONFIRMATION_TIMEOUT_MS);
    } catch (error) {
      if (errorCode(error) === ethers.errors.TIMEOUT) throw new ConfirmationTimeoutError(hash);
      throw error;
    }
    return transactionData.cancelHashes?.includes(hash)
      ? { kind: "nonce-resolved" }
      : { kind: "mined", receipt };
  }

  // Terminal failure: log, notify listeners, and report success=false to the caller.
  private reportFailure(
    transactionData: TransactionData,
    reason: ChainExecutorFailureReason,
    error: unknown,
    nonceResolved: boolean
  ): void {
    const nonceNote = transactionData.nonce === undefined
      ? ""
      : nonceResolved
        ? ` nonce ${transactionData.nonce} resolved`
        : ` nonce ${transactionData.nonce} may still be pending (${transactionData.hashes!.join(", ")})`;
    Logger.error(`Chain executor transaction failed permanently (${reason})${nonceNote} : ${error}`);
    for (const listener of ChainExecutor.failureListeners) {
      try {
        listener({
          to: transactionData.to,
          callData: transactionData.callData,
          value: transactionData.value,
          chainId: transactionData.chainId,
          signerId: transactionData.signerId,
          retries: transactionData.terminalRetries ?? transactionData.retries ?? 0,
          reason,
          nonce: transactionData.nonce,
          hashes: transactionData.hashes,
          nonceResolved,
          lastError: error,
        });
      } catch (listenerError) {
        Logger.error(`Chain executor failure listener threw : ${listenerError}`);
      }
    }
    this.safeCallback(transactionData, false, '');
  }

  // Invokes the callback, swallowing any throw/rejection so the lock isn't left dangling.
  private safeCallback(transactionData: TransactionData, success: boolean, transactionHash: string): void {
    if (transactionData.callback === undefined) return;
    try {
      void Promise.resolve(transactionData.callback(success, transactionHash)).catch(
        (callbackError) => Logger.error(`Chain executor callback threw : ${callbackError}`)
      );
    } catch (callbackError) {
      Logger.error(`Chain executor callback threw : ${callbackError}`);
    }
  }

  private isProcessing(chainId: number, signerId: string): boolean {
    if (!this.processing.has(chainId)) return false;
    if (!this.processing.get(chainId)!.has(signerId)) return false;
    return this.processing.get(chainId)!.get(signerId)!;
  }

  private setProcessing(chainId: number, signerId: string, isProcessing: boolean): void {
    if (!this.processing.has(chainId)) {
      this.processing.set(chainId, new Map());
    }
    this.processing.get(chainId)!.set(signerId, isProcessing);
  }
}
