import express from "express";
import {validate} from "../../middlewares";
import * as alertsValidation from "../../validations/alerts.validation";
import * as alertsController from "../../controller/alerts.controller";

const router = express.Router();

router
  .route("/subscribe")
  .post(validate(alertsValidation.subscribe), alertsController.subscribe);

router
  .route("/activate")
  .post(validate(alertsValidation.activate), alertsController.activate);

router
  .route("/subscriptions")
  .get(validate(alertsValidation.subscriptions), alertsController.fetchSubscriptions);

router
  .route("/unsubscribe")
  .post(validate(alertsValidation.unsubscribe), alertsController.unsubscribe);

export default router;
