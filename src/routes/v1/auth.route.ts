import express from "express";
import {validate} from "../../middlewares";
import * as authValidation from "../../validations/auth.validation";
import * as authController from "../../controller/auth.controller";

const router = express.Router();

router
  .route("/register")
  .post(validate(authValidation.register), authController.createRegistration);

router
  .route("/submit")
  .post(validate(authValidation.submit), authController.submitRegistrationChallenge);

router
  .route("/registrations")
  .get(validate(authValidation.registrations), authController.fetchRegistrations);

router
  .route("/delete")
  .post(validate(authValidation.deleteRegistration), authController.deleteRegistration);

router
  .route("/signature/request")
  .post(validate(authValidation.requestSignature), authController.requestSignature);

router
  .route("/signature/submit")
  .post(validate(authValidation.submitSignatureRequestChallenge), authController.submitSignatureRequestChallenge);

export default router;
