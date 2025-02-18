import httpStatus from "http-status";
import {ApiError, catchAsync, JsonBigIntParser} from "../utils";
import * as RecoveriesService from "../services/recoveries.service";

interface CreateRecoveryBody {
  account: string;
  newOwners: string[];
  newThreshold: number;
  chainId: number;
  signer: string;
  signature: string;
}

interface SignRecoveryBody {
  id: string;
  signer: string;
  signature: string;
}

export const create = catchAsync(async (req, res) => {
  const params = req.body as CreateRecoveryBody;
  const response = await RecoveriesService.create(
    params.account,
    params.newOwners,
    params.newThreshold,
    params.chainId,
    params.signer,
    params.signature
  );

  res.send(JsonBigIntParser(response));
});

export const sign = catchAsync(async (req, res) => {
  const { id, signer, signature } = req.body as SignRecoveryBody;
  await RecoveriesService.signRecoveryHash(
    id, signer, signature
  );

  res.send({success:true});
});

export const fetchByAddress = catchAsync(async (req, res) => {
  const { account, chainId, nonce } = req.query as unknown as {
    account: string;
    chainId: number;
    nonce: string;
  };
  const recoveryRequests = await RecoveriesService.findByAccountAddress(
    account,
    chainId,
    BigInt(nonce),
  );

  res.send(JsonBigIntParser(recoveryRequests));
});

export const fetchById = catchAsync(async (req, res) => {
  const { id } = req.query as {
    id: string;
  };
  const request = await RecoveriesService.findById(
    id,
  );
  if (request == null){
    throw new ApiError(
      httpStatus.NOT_FOUND,
      `Recovery request not found`
    );
  }

  res.send(JsonBigIntParser(request));
});

export const execute = catchAsync(async (req, res) => {
  const { id } = req.body;
  const request = await RecoveriesService.findById(id);
  if (request == null){
    throw new ApiError(
      httpStatus.NOT_FOUND,
      `Recovery request not found`
    );
  }
  await RecoveriesService.sponsorExecution(request);

  res.send({success:true});
});


export const finalize = catchAsync(async (req, res) => {
  const { id } = req.body;
  const request = await RecoveriesService.findById(id);
  if (request == null){
    throw new ApiError(
      httpStatus.NOT_FOUND,
      `Recovery request not found`
    );
  }
  await RecoveriesService.sponsorFinalization(request);

  res.send({success:true});
});