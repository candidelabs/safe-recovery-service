import httpStatus from "http-status";
import {ApiError, catchAsync, JsonBigIntParser} from "../utils";
import * as RecoveriesService from "../services/recoveries.service";
import {selectRecoveryModule} from "../utils/module-fallback";

interface CreateRecoveryBody {
  account: string;
  newOwners: string[];
  newThreshold: number;
  chainId: number;
  moduleAddress?: string;
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
  const selection = selectRecoveryModule(req, res, params.chainId, params.moduleAddress);
  const response = await RecoveriesService.create(
    params.account,
    params.newOwners,
    params.newThreshold,
    params.chainId,
    params.signer,
    params.signature,
    selection,
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
  const { account, chainId, moduleAddress, nonce } = req.query as unknown as {
    account: string;
    chainId: number;
    moduleAddress?: string;
    nonce: string;
  };
  const {module} = selectRecoveryModule(req, res, chainId, moduleAddress);
  const recoveryRequests = await RecoveriesService.findByAccountAddress(
    account,
    chainId,
    BigInt(nonce),
    module,
  );

  res.send(JsonBigIntParser(recoveryRequests));
});

export const listByAddress = catchAsync(async (req, res) => {
  const { account, chainId, moduleAddress, orderBy, order, limit, offset, ...filters } = req.query as unknown as {
    account: string;
    chainId: number;
    moduleAddress?: string;
    orderBy?: "createdAt" | "nonce";
    order?: "asc" | "desc";
    limit: number;
    offset: number;
    [key: string]: any;
  };
  const {module} = selectRecoveryModule(req, res, chainId, moduleAddress);
  const recoveries = await RecoveriesService.findByAccount(account, chainId, module, filters, orderBy, order, limit, offset);
  res.send(JsonBigIntParser(recoveries));
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