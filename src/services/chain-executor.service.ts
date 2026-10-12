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
// Fee bumps compound (+12.5% each), so cap them; after that we keep waiting without bumping.
const MAX_REPLACEMENTS = 10;
// Hard bound on wall-clock spent on one transaction, measured from its first attempt.
const MAX_TX_LIFETIME_MS = 2 * 60 * 60 * 1_000;
// Applied to the fee floor when a node rejects a replacement as underpriced.
const UNDERPRICED_FLOOR_BUMP = 1.125;

interface TransactionData {
  to: string;
  callData: string;
  value: bigint;
  chainId: number;
  signerId: string;
  callback?: (success: boolean, transactionHash: string) => Promise<void>;
  // Transient failures so far (drives the backoff schedule).
  retries?: number;
  // Fee-bumped re-broadcasts of the same nonce so far.
  replacements?: number;
  // Wall-clock start of the first attempt.
  firstAttemptAt?: number;
  // Replacement bookkeeping: last broadcast nonce/fees/gas limit, and every hash broadcast.
  nonce?: number;
  lastFees?: { maxFeePerGas: ethers.BigNumber; maxPriorityFeePerGas: ethers.BigNumber };
  lastGasLimit?: string;
  hashes?: string[];
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
  // Set when at least one broadcast happened; that nonce may still be pending.
  nonce?: number;
  hashes?: string[];
  lastError: unknown;
}

export type ChainExecutorFailureListener = (failure: FailedTransaction) => void;

type FailureDecision =
  | { kind: "retry"; delayMs: number; why: string }
  | { kind: "fail"; reason: ChainExecutorFailureReason };

// Raised by waitFor() when the broadcast is still unmined after CONFIRMATION_TIMEOUT_MS.
class ConfirmationTimeoutError extends Error {
  constructor(public readonly hash: string) {
    super(`transaction not mined within ${CONFIRMATION_TIMEOUT_MS}ms : ${hash}`);
  }
}

// Raised by an attempt that found nothing mined after MAX_TX_LIFETIME_MS.
class TransactionExpiredError extends Error {
  constructor(transactionData: TransactionData) {
    const pending = transactionData.hashes?.length
      ? ` (nonce ${transactionData.nonce} may still be pending : ${transactionData.hashes.join(", ")})`
      : "";
    super(`transaction exceeded its ${MAX_TX_LIFETIME_MS}ms lifetime${pending}`);
  }
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
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
    transactionData.firstAttemptAt ??= Date.now();
    let retryDelayMs: number | null = null;
    try {
      const receipt = await this.broadcastAndWait(chainId, signerId, transactionData);
      queue.shift();
      if (receipt.status === 0) {
        // Mined but reverted: terminal (nonce is spent), report failure.
        Logger.error(`Chain executor transaction mined but reverted : ${receipt.transactionHash}`);
      }
      this.safeCallback(transactionData, receipt.status === 1, receipt.transactionHash);
    } catch (error) {
      const decision = this.classifyFailure(transactionData, error);
      if (decision.kind === "retry") {
        Logger.error(`Chain executor transaction attempt failed (${decision.why}), retrying in ${decision.delayMs}ms : ${error}`);
        retryDelayMs = decision.delayMs;
      } else {
        queue.shift();
        this.reportFailure(transactionData, decision.reason, error);
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

  // Decides whether a failed attempt is retried (and how soon) or is terminal.
  private classifyFailure(transactionData: TransactionData, error: unknown): FailureDecision {
    const broadcast = (transactionData.hashes?.length ?? 0) > 0;
    const expired = Date.now() - transactionData.firstAttemptAt! >= MAX_TX_LIFETIME_MS;

    if (error instanceof TransactionExpiredError) {
      return { kind: "fail", reason: "expired" };
    }

    // Still unmined after the confirmation window: re-broadcast with bumped fees right away.
    // Past the lifetime, the next attempt only settles and then raises TransactionExpiredError.
    if (error instanceof ConfirmationTimeoutError) {
      return { kind: "retry", delayMs: 0, why: "confirmation timeout" };
    }

    if (expired) {
      // If something was broadcast, run one last settle pass so a tx that mined
      // during the backoff is still reported as success.
      return broadcast
        ? { kind: "retry", delayMs: 0, why: "lifetime exceeded, settling" }
        : { kind: "fail", reason: "expired" };
    }

    const code = errorCode(error);

    // The node says the call would revert. Nothing is on chain (replacements never
    // re-estimate), so retrying can only burn time for everything queued behind it.
    if (!broadcast && (code === ethers.errors.UNPREDICTABLE_GAS_LIMIT || code === ethers.errors.CALL_EXCEPTION)) {
      return { kind: "fail", reason: "would-revert" };
    }

    // Our +12.5% floor wasn't enough for this node: raise the floor before the next attempt,
    // otherwise every retry would resend the same fees and hit the same rejection.
    if (code === ethers.errors.REPLACEMENT_UNDERPRICED && transactionData.lastFees) {
      transactionData.lastFees = {
        maxFeePerGas: scaleBigNumber(transactionData.lastFees.maxFeePerGas, UNDERPRICED_FLOOR_BUMP),
        maxPriorityFeePerGas: scaleBigNumber(transactionData.lastFees.maxPriorityFeePerGas, UNDERPRICED_FLOOR_BUMP),
      };
    }

    // Everything else is assumed transient.
    const retries = (transactionData.retries ?? 0) + 1;
    if (retries > MAX_RETRIES) {
      return { kind: "fail", reason: "retries-exhausted" };
    }
    transactionData.retries = retries;
    return {
      kind: "retry",
      delayMs: Math.min(BASE_RETRY_DELAY_MS * Math.pow(2, retries - 1), MAX_RETRY_DELAY_MS),
      why: `transient, retry ${retries}/${MAX_RETRIES}`,
    };
  }

  // Broadcasts (or replaces) the head tx and waits up to CONFIRMATION_TIMEOUT_MS.
  // Throws ConfirmationTimeoutError if not mined in time, TransactionExpiredError once
  // the lifetime is spent, or the underlying error otherwise; the caller checks
  // receipt.status for on-chain reverts.
  private async broadcastAndWait(
    chainId: number,
    signerId: string,
    transactionData: TransactionData
  ): Promise<ethers.providers.TransactionReceipt> {
    const network = Network.instances.get(chainId.toString())!;
    const signer = Signers.instance().getSigner(signerId)!;
    const signerAddress = await signer.signer();
    const provider = network.jsonRPCProvider;

    // On a retry, settle the previous attempt before broadcasting a replacement.
    if (transactionData.nonce !== undefined && transactionData.hashes?.length) {
      const minedCount = await provider.getTransactionCount(signerAddress, "latest");
      if (minedCount > transactionData.nonce) {
        // Nonce already mined: return our receipt if one of our hashes landed.
        for (const hash of transactionData.hashes) {
          const priorReceipt = await provider.getTransactionReceipt(hash);
          if (priorReceipt) return priorReceipt;
        }
        // Otherwise an untracked (e.g. external) tx took the nonce; start over with a fresh estimate.
        transactionData.nonce = undefined;
        transactionData.lastFees = undefined;
        transactionData.lastGasLimit = undefined;
        transactionData.hashes = undefined;
      }
    }

    if (Date.now() - transactionData.firstAttemptAt! >= MAX_TX_LIFETIME_MS) {
      throw new TransactionExpiredError(transactionData);
    }

    const replacing = transactionData.nonce !== undefined;
    if (replacing && (transactionData.replacements ?? 0) >= MAX_REPLACEMENTS) {
      // Bump budget spent: keep waiting on the latest broadcast instead of escalating further.
      return this.waitFor(provider, transactionData.hashes![transactionData.hashes!.length - 1]);
    }

    const transaction = await populateTxGasPricesAndLimits(
      network,
      signerAddress,
      transactionData.to,
      transactionData.value,
      transactionData.callData,
      transactionData.nonce,
      transactionData.lastFees,
      transactionData.lastGasLimit
    );
    const serializedUnsignedTx = ethers.utils.serializeTransaction(transaction);
    const unsignedTxHash = ethers.utils.keccak256(serializedUnsignedTx);
    const signature = await signer.sign(unsignedTxHash);
    const serializedSignedTransaction = ethers.utils.serializeTransaction(transaction, signature);
    const txResponse = await provider.sendTransaction(serializedSignedTransaction);

    // Commit bookkeeping only after a successful broadcast.
    transactionData.nonce = transaction.nonce as number;
    transactionData.lastFees = {
      maxFeePerGas: ethers.BigNumber.from(transaction.maxFeePerGas),
      maxPriorityFeePerGas: ethers.BigNumber.from(transaction.maxPriorityFeePerGas),
    };
    transactionData.lastGasLimit = ethers.utils.hexValue(transaction.gasLimit!);
    (transactionData.hashes ??= []).push(txResponse.hash);
    if (replacing) {
      transactionData.replacements = (transactionData.replacements ?? 0) + 1;
    }

    return this.waitFor(provider, txResponse.hash);
  }

  // Waits for one confirmation, surfacing the bounded wait as ConfirmationTimeoutError.
  private async waitFor(
    provider: ethers.providers.JsonRpcProvider,
    hash: string
  ): Promise<ethers.providers.TransactionReceipt> {
    try {
      return await provider.waitForTransaction(hash, 1, CONFIRMATION_TIMEOUT_MS);
    } catch (error) {
      if (errorCode(error) === ethers.errors.TIMEOUT) throw new ConfirmationTimeoutError(hash);
      throw error;
    }
  }

  // Terminal failure: log, notify listeners, and report success=false to the caller.
  private reportFailure(transactionData: TransactionData, reason: ChainExecutorFailureReason, error: unknown): void {
    const pending = transactionData.hashes?.length
      ? ` nonce ${transactionData.nonce} may still be pending (${transactionData.hashes.join(", ")})`
      : "";
    Logger.error(`Chain executor transaction failed permanently (${reason})${pending} : ${error}`);
    for (const listener of ChainExecutor.failureListeners) {
      try {
        listener({
          to: transactionData.to,
          callData: transactionData.callData,
          value: transactionData.value,
          chainId: transactionData.chainId,
          signerId: transactionData.signerId,
          retries: transactionData.retries ?? 0,
          reason,
          nonce: transactionData.nonce,
          hashes: transactionData.hashes,
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
