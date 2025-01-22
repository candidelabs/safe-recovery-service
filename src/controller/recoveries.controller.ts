import httpStatus from "http-status";
import { ApiError, catchAsync } from "../utils";
import * as RecoveriesService from "../services/recoveries.service";

interface PostRequestBody {
  account: string;
  newOwners: string[];
  threshold: number;
  chainId: number;
  signer: string;
  signature: string;
}

interface SignRequestBody {
  id: string;
  signer: string;
  signature: string;
}

export const post = catchAsync(async (req, res) => {
  const params = req.body as PostRequestBody;
  const response = await RecoveriesService.create(
    params.account,
    params.newOwners,
    params.chainId,
    params.threshold,
    params.signer,
    params.signature
  );

  res.send(response);
});

export const sign = catchAsync(async (req, res) => {
  const { id, signer, signature } = req.body as SignRequestBody;

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

  res.send(recoveryRequests);
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

  res.send(request);
});
