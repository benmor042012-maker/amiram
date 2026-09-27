import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig(async () => {
  const migrations = await readD1Migrations("./migrations");
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: "./wrangler.toml" },
        miniflare: {
          bindings: {
            TEST_MIGRATIONS: migrations,
            YELP_WEBHOOK_SECRET: "test-yelp-secret",
            WEBSITE_WEBHOOK_SECRET: "test-website-secret",
            TWILIO_AUTH_TOKEN: "test-twilio-token",
            ADMIN_TOKEN: "test-admin-token",
            OWNER_PHONE: "+13105550000",
            NOTIFICATION_PROVIDER: "console",
          },
        },
      }),
    ],
    test: { setupFiles: ["./test/apply-migrations.ts"] },
  };
});
