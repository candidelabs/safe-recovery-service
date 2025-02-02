import express from "express";
import {validate} from "../../middlewares";
import * as recoveriesValidation from "../../validations/recoveries.validation";
import * as recoveriesController from "../../controller/recoveries.controller";

const router = express.Router();

router.route("/create").post(validate(recoveriesValidation.create), recoveriesController.post);

router
  .route("/sign")
  .post(validate(recoveriesValidation.sign), recoveriesController.sign);

router
  .route("/fetchByAddress")
  .get(validate(recoveriesValidation.fetchByAddress), recoveriesController.fetchByAddress);

router
  .route("/fetchById")
  .get(validate(recoveriesValidation.fetchById), recoveriesController.fetchById);

router
  .route("/execute")
  .post(validate(recoveriesValidation.finalizeOrExecute), recoveriesController.execute);

router
  .route("/finalize")
  .post(validate(recoveriesValidation.finalizeOrExecute), recoveriesController.finalize);

export default router;
