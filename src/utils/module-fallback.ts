import type {Request, Response} from "express";
import {Configuration} from "../config/config-manager";
import {ModuleSelection, Network} from "../models/network";
import {routePattern} from "../middlewares/request-logger";
import logger from "./logger";

const log = logger.child({ component: "recovery-modules" });

// Headers telling a client that its request relied on the module fallback: Deprecation (RFC 9745) and
// Sunset (RFC 8594). Each is sent once its date is configured.
export const moduleFallbackHeaders = (deprecation?: Date, sunset?: Date): Record<string, string> => {
  const headers: Record<string, string> = {};
  if (deprecation) headers["Deprecation"] = `@${Math.floor(deprecation.getTime() / 1000)}`;
  if (sunset) headers["Sunset"] = sunset.toUTCString();
  return headers;
};

// The module of a request that starts a flow, or filters by module. A request that names none gets the
// chain's fallback module until the Sunset date; each use is logged, so the clients still relying on it
// can be found, and answered with the Deprecation / Sunset headers.
export const selectRecoveryModule = (req: Request, res: Response, chainId: number, moduleAddress?: string): ModuleSelection => {
  const network = Network.instances.get(chainId.toString())!;
  const selection = network.resolveModule(moduleAddress);
  if (selection.fallback) {
    log.info({ chainId, route: routePattern(req), moduleFallback: true }, "module fallback used");
    const configuration = Configuration.instance();
    const headers = moduleFallbackHeaders(configuration.moduleFallbackDeprecation, configuration.moduleFallbackSunset);
    if (Object.keys(headers).length > 0) {
      res.set(headers);
      // browsers hide response headers from scripts unless they are exposed
      res.append("Access-Control-Expose-Headers", Object.keys(headers).join(", "));
    }
  }
  return selection;
};
