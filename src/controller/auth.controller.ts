import * as authService from "../services/auth.service";
import * as verificationService from "../services/verification.service";
import {catchAsync} from "../utils";
import {selectRecoveryModule} from "../utils/module-fallback";

interface CreateRegistrationBody {
  account: string;
  chainId: number;
  channel: string;
  target: string;
  message: string;
  signature: string;
  verificationToken?: string;
}

interface SubmitChallengeBody {
  challengeId: string;
  challenge: string;
}

interface FetchRegistrationsBody {
  account: string;
  chainId: number;
  message: string;
  signature: string;
}

interface DeleteRegistrationBody {
  registrationId: string;
  message: string;
  signature: string;
}

interface RequestVerificationBody {
  channel: string;
  target: string;
}

interface SubmitVerificationBody {
  challengeId: string;
  challenge: string;
}

interface ListAccountsBody {
  verificationToken: string;
}

interface RequestSignatureBody {
  account: string;
  newOwners: string[];
  newThreshold: number;
  chainId: number;
  moduleAddress?: string;
}

interface SubmitSignatureChallengeBody {
  requestId: string;
  challengeId: string;
  challenge: string;
}

export const createRegistration = catchAsync(async (req, res) => {
  const params = req.body as CreateRegistrationBody;
  // with a verificationToken {registrationId, guardianAddress}, else {challengeId}
  const response = await authService.createRegistration(
    params.account,
    params.chainId,
    params.channel,
    params.target,
    params.message,
    params.signature,
    params.verificationToken,
  );
  res.send(response);
});

export const submitRegistrationChallenge = catchAsync(async (req, res) => {
  const params = req.body as SubmitChallengeBody;
  const [registrationId, guardianAddress] = await authService.submitRegistrationChallenge(
    params.challengeId,
    params.challenge
  );
  res.send({
    registrationId,
    guardianAddress
  });
});

export const fetchRegistrations = catchAsync(async (req, res) => {
  const params = req.query as unknown as FetchRegistrationsBody;
  const registrations = await authService.fetchRegistrations(
    params.account,
    params.chainId,
    params.message,
    params.signature
  );
  res.send({registrations});
});

export const deleteRegistration = catchAsync(async (req, res) => {
  const params = req.body as DeleteRegistrationBody;
  const success = await authService.deleteRegistration(
    params.registrationId,
    params.message,
    params.signature
  );
  res.send({success});
});

export const requestVerification = catchAsync(async (req, res) => {
  const params = req.body as RequestVerificationBody;
  const challengeId = await verificationService.requestVerification(params.channel, params.target);
  res.send({challengeId});
});

export const submitVerification = catchAsync(async (req, res) => {
  const params = req.body as SubmitVerificationBody;
  const {verificationToken, verificationTokenExpiresAt} = await verificationService.submitVerification(
    params.challengeId,
    params.challenge,
  );
  // the token is a bearer secret
  res.set("Cache-Control", "no-store");
  res.send({verificationToken, verificationTokenExpiresAt: verificationTokenExpiresAt.toISOString()});
});

export const listAccounts = catchAsync(async (req, res) => {
  const params = req.body as ListAccountsBody;
  const accounts = await authService.listAccounts(params.verificationToken);
  res.set("Cache-Control", "no-store");
  res.send({accounts});
});

export const requestSignature = catchAsync(async (req, res) => {
  const params = req.body as RequestSignatureBody;
  const selection = selectRecoveryModule(req, res, params.chainId, params.moduleAddress);
  const response = await authService.requestSignature(
    params.account,
    params.newOwners,
    params.newThreshold,
    params.chainId,
    selection,
  );
  res.send(response);
});

export const submitSignatureRequestChallenge = catchAsync(async (req, res) => {
  const params = req.body as SubmitSignatureChallengeBody;
  const response = await authService.submitSignatureRequestChallenge(
    params.requestId,
    params.challengeId,
    params.challenge,
  );
  res.send(response);
});