import { createApp } from "./app";
import type { Env } from "./env";
import { createServices } from "./services";
import { log, logError } from "./util/log";

const app = createApp();

export default {
  fetch: app.fetch,

  async scheduled(_controller, env, ctx) {
    ctx.waitUntil(
      createServices(env)
        .qualification.processTimeouts()
        .then((count) => count > 0 && log("cron.owner_notifications", { count }))
        .catch((error) => logError("cron.failed", error)),
    );
  },
} satisfies ExportedHandler<Env>;
