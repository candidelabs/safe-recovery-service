import {validate} from "../../middlewares";
import * as configValidation from "../../validations/config.validation";
import * as configController from "../../controller/config.controller";
import router from "./alerts.route";

router
  .route("/getNetworkConfig")
  .get(validate(configValidation.getNetworkConfig), configController.getNetworkConfig);

export default router;