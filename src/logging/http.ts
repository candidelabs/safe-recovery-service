import { sanitizePath } from "./sanitize";

// Works for Express and Fastify requests. Headers, query strings and bodies are never included;
// a route that needs part of a body logs those fields explicitly.
export function serializeRequest(req: any): unknown {
  if (!req || typeof req !== "object") return req;
  const url: unknown = req.originalUrl ?? req.url ?? req.raw?.url;
  const route: unknown =
    req.routeOptions?.url ??
    req.routerPath ??
    (req.route?.path !== undefined ? `${req.baseUrl ?? ""}${req.route.path}` : undefined);
  return {
    method: req.method ?? req.raw?.method,
    route: typeof route === "string" ? sanitizePath(route) : undefined,
    path: typeof url === "string" ? sanitizePath(url.split("?")[0]) : undefined,
    ip: typeof req.ip === "string" ? req.ip : undefined,
  };
}

export function serializeResponse(res: any): unknown {
  if (!res || typeof res !== "object") return res;
  return { statusCode: res.statusCode };
}
