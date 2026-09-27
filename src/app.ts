import { Hono } from "hono";
import type { Env } from "./env";
import { adminRoutes } from "./routes/admin";
import { yelpRoutes } from "./routes/yelp";
import { createServices, type ServiceOverrides, type Services } from "./services";
import { logError } from "./util/log";

export type AppEnv = { Bindings: Env; Variables: { services: Services } };

/** HTTP app. Controllers stay thin; business logic lives in the services. */
export function createApp(overrides: ServiceOverrides = {}) {
  return new Hono<AppEnv>()
    .use(async (c, next) => {
      c.set("services", createServices(c.env, overrides));
      await next();
    })
    .get("/health", (c) => c.json({ ok: true }))
    .route("/api/yelp", yelpRoutes)
    .route("/api/admin", adminRoutes)
    .onError((error, c) => {
      logError("http.unhandled", error, { path: c.req.path });
      return c.json({ error: "internal error" }, 500);
    });
}
