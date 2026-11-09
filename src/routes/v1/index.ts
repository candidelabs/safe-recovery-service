import express, { Router } from "express";
import configRoute from "./config.route";
import recoveriesRoute from "./recoveries.route";
import authRoute from "./auth.route";
import alertsRoute from "./alerts.route";
import {requireBearerToken} from "../../middlewares";
import {Configuration} from "../../config/config-manager";

const router = express.Router();

// options.authentication.bearerToken: every v1 request needs "Authorization: Bearer <token>"
const {bearerToken} = Configuration.instance().authentication;
if (bearerToken !== undefined) {
  router.use(requireBearerToken(bearerToken));
}

type Route = {
  path: string;
  route: Router;
};

const defaultRoutes: Array<Route> = [
  { path: "/config", route: configRoute },
  { path: "/recoveries", route: recoveriesRoute },
  { path: "/auth", route: authRoute },
  { path: "/alerts", route: alertsRoute },
];

defaultRoutes.forEach((route) => {
  router.use(route.path, route.route);
});

export default router;
