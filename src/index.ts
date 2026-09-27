import { createApp } from "./app";
import type { Env } from "./env";
import { createServices } from "./services";
import { log, logError } from "./util/log";

const app = createApp();

export default {
  fetch: app.fetch,

  async scheduled(_controller, env, ctx) {
    const services = createServices(env);
    ctx.waitUntil(
      services.qualification
        .processTimeouts()
        .then((count) => count > 0 && log("cron.owner_notifications", { count }))
        .catch((error) => logError("cron.owner_notifications_failed", error)),
    );
    ctx.waitUntil(
      services.followUps
        .processDue()
        .then((count) => count > 0 && log("cron.follow_ups_sent", { count }))
        .catch((error) => logError("cron.follow_ups_failed", error)),
    );
  },
} satisfies ExportedHandler<Env>;
