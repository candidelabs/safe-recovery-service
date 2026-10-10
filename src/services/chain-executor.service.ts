import Logger from "utils/logger";
import {Network} from "../models/network";
import {Signers} from "../models/signer/signers";
import {populateTxGasPricesAndLimits} from "../utils";
import {ethers} from "ethers";

interface TransactionData {
  to: string;
  callData: string;
  value: bigint;
  chainId: number;
  signerId: string;
  callback?: (success: boolean, transactionHash: string) => Promise<void>;
  retries?: number;
  // Replacement bookkeeping: last broadcast nonce/fees, and every hash broadcast.
  nonce?: number;
  lastFees?: { maxFeePerGas: ethers.BigNumber; maxPriorityFeePerGas: ethers.BigNumber };
  hashes?: string[];
}

export interface FailedTransaction {
  to: string;
  callData: string;
  value: bigint;
  chainId: number;
  signerId: string;
  retries: number;
  lastError: unknown;
}

export type ChainExecutorFailureListener = (failure: FailedTransaction) => void;

export class ChainExecutor {
  private static _instance: ChainExecutor;
  private queues: Map<number, Map<string, TransactionData[]>>; // chainId -> signerId -> transaction queue
  private processing: Map<number, Map<string, boolean>>; // Tracks processing status for each signer on each chain
  private static readonly MAX_RETRIES = 30;
  private static readonly BASE_RETRY_DELAY_MS = 5 * 1_000;
  private static readonly MAX_RETRY_DELAY_MS = 15 * 60 * 1_000;
  // Bounds the wait for a broadcast to mine; past this it is retried as a
  // replacement, so a stuck tx can't freeze the per-signer queue indefinitely.
  private static readonly CONFIRMATION_TIMEOUT_MS = 3 * 60 * 1_000;
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

  // Fires once per transaction, after MAX_RETRIES attempts have all failed.
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
      Logger.error(`Chain executor transaction failed : ${error}`);
      if ((transactionData.retries ?? 0) < ChainExecutor.MAX_RETRIES) {
        transactionData.retries = (transactionData.retries ?? 0) + 1;
        retryDelayMs = Math.min(
          ChainExecutor.BASE_RETRY_DELAY_MS * Math.pow(2, transactionData.retries - 1),
          ChainExecutor.MAX_RETRY_DELAY_MS
        );
      } else {
        queue.shift();
        for (const listener of ChainExecutor.failureListeners) {
          try {
            listener({
              to: transactionData.to,
              callData: transactionData.callData,
              value: transactionData.value,
              chainId: transactionData.chainId,
              signerId: transactionData.signerId,
              retries: transactionData.retries!,
              lastError: error,
            });
          } catch (listenerError) {
            Logger.error(`Chain executor failure listener threw : ${listenerError}`);
          }
        }
        this.safeCallback(transactionData, false, '');
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

  // Broadcasts (or replaces) the head tx and waits up to CONFIRMATION_TIMEOUT_MS.
  // Throws if not mined in time so the caller retries; the caller checks
  // receipt.status for on-chain reverts.
  private async broadcastAndWait(
    chainId: number,
    signerId: string,
    transactionData: TransactionData
  ): Promise<ethers.providers.TransactionReceipt> {
    const network = Network.instances.get(chainId.toString())!;
    const signer = Signers.instance().getSigner(signerId)!;
    const signerAddress = await signer.signer();

    // On a retry, settle the previous attempt before broadcasting a replacement.
    if (transactionData.nonce !== undefined && transactionData.hashes?.length) {
      const minedCount = await network.jsonRPCProvider.getTransactionCount(signerAddress, "latest");
      if (minedCount > transactionData.nonce) {
        // Nonce already mined: return our receipt if one of our hashes landed.
        for (const hash of transactionData.hashes) {
          const priorReceipt = await network.jsonRPCProvider.getTransactionReceipt(hash);
          if (priorReceipt) return priorReceipt;
        }
        // Otherwise an untracked (e.g. external) tx took the nonce; re-execute fresh.
        transactionData.nonce = undefined;
        transactionData.lastFees = undefined;
        transactionData.hashes = undefined;
      }
    }

    const transaction = await populateTxGasPricesAndLimits(
      network,
      signerAddress,
      transactionData.to,
      transactionData.value,
      transactionData.callData,
      transactionData.nonce,
      transactionData.lastFees
    );
    const serializedUnsignedTx = ethers.utils.serializeTransaction(transaction);
    const unsignedTxHash = ethers.utils.keccak256(serializedUnsignedTx);
    const signature = await signer.sign(unsignedTxHash);
    const serializedSignedTransaction = ethers.utils.serializeTransaction(transaction, signature);
    const txResponse = await network.jsonRPCProvider.sendTransaction(serializedSignedTransaction);

    // Commit bookkeeping only after a successful broadcast.
    transactionData.nonce = transaction.nonce as number;
    transactionData.lastFees = {
      maxFeePerGas: ethers.BigNumber.from(transaction.maxFeePerGas),
      maxPriorityFeePerGas: ethers.BigNumber.from(transaction.maxPriorityFeePerGas),
    };
    (transactionData.hashes ??= []).push(txResponse.hash);

    return network.jsonRPCProvider.waitForTransaction(
      txResponse.hash,
      1,
      ChainExecutor.CONFIRMATION_TIMEOUT_MS
    );
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
