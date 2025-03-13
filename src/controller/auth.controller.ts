import * as authService from "../services/auth.service";
import {catchAsync} from "../utils";

interface CreateRegistrationBody {
  account: string;
  chainId: number;
  channel: string;
  target: string;
  message: string;
  signature: string;
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

interface RequestSignatureBody {
  account: string;
  newOwners: string[];
  newThreshold: number;
  chainId: number;
}

interface SubmitSignatureChallengeBody {
  requestId: string;
  challengeId: string;
  challenge: string;
}

export const createRegistration = catchAsync(async (req, res) => {
  const params = req.body as CreateRegistrationBody;
  const registrationRequestId = await authService.createRegistration(
    params.account,
    params.chainId,
    params.channel,
    params.target,
    params.message,
    params.signature
  );
  res.send({challengeId: registrationRequestId});
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

export const requestSignature = catchAsync(async (req, res) => {
  const params = req.body as RequestSignatureBody;
  const response = await authService.requestSignature(
    params.account,
    params.newOwners,
    params.newThreshold,
    params.chainId
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