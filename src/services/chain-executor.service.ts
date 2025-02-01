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
}

export class ChainExecutor {
  private static _instance: ChainExecutor;
  private queues: Map<number, Map<string, TransactionData[]>>; // chainId -> signerId -> transaction queue
  private processing: Map<number, Map<string, boolean>>; // Tracks processing status for each signer on each chain
  private static readonly MAX_RETRIES = 3;

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
    if (!this.queues.has(chainId) || !this.queues.get(chainId)!.has(signerId)) return;
    if (this.isProcessing(chainId, signerId)) return;
    this.setProcessing(chainId, signerId, true);
    const queue = this.queues.get(chainId)!.get(signerId)!;
    if (queue.length === 0) {
      this.setProcessing(chainId, signerId, false);
      return;
    }
    const transactionData = queue.shift()!;
    try {
      const network = Network.instances.get(chainId.toString())!;
      const signer = Signers.instance().getSigner(signerId)!;
      const signerAddress = await signer.signer();
      const transaction = await populateTxGasPricesAndLimits(
        network,
        signerAddress,
        transactionData.to,
        transactionData.value,
        transactionData.callData
      );
      const serializedUnsignedTx = ethers.utils.serializeTransaction(transaction);
      const unsignedTxHash = ethers.utils.keccak256(serializedUnsignedTx);
      const signature = await signer.sign(unsignedTxHash);
      const serializedSignedTransaction = ethers.utils.serializeTransaction(transaction, signature);
      const txResponse = await network.jsonRPCProvider.sendTransaction(serializedSignedTransaction);
      const receipt = await txResponse.wait();
      if (transactionData.callback !== undefined) {
        transactionData.callback(true, receipt.transactionHash);
      }
      this.setProcessing(chainId, signerId, false);
    } catch (error) {
      transactionData.retries = transactionData.retries ?? 0;
      if (transactionData.retries < ChainExecutor.MAX_RETRIES) {
        transactionData.retries++;
        queue.push(transactionData);
      } else {
        if (transactionData.callback) {
          transactionData.callback(false, '');
        }
      }
    }
    this.setProcessing(chainId, signerId, false);
    this.processNext(chainId, signerId);
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