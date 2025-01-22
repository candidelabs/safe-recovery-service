import express, { Router } from "express";
import recoveriesRoute from "./recoveries.route";

const router = express.Router();

type Route = {
  path: string;
  route: Router;
};

const defaultRoutes: Array<Route> = [{ path: "/recoveries", route: recoveriesRoute }];

defaultRoutes.forEach((route) => {
  router.use(route.path, route.route);
});

export default router;
