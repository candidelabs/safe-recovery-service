import express, { Router } from "express";
import recoveriesRoute from "./recoveries.route";
import authRoute from "./auth.route";
import alertsRoute from "./alerts.route";

const router = express.Router();

type Route = {
  path: string;
  route: Router;
};

const defaultRoutes: Array<Route> = [
  { path: "/recoveries", route: recoveriesRoute },
  { path: "/auth", route: authRoute },
  { path: "/alerts", route: alertsRoute },
];

defaultRoutes.forEach((route) => {
  router.use(route.path, route.route);
});

export default router;
