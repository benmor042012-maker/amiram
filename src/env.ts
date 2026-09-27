export interface Env {
  DB: D1Database;

  CLAUDE_MODEL?: string;
  ANTHROPIC_API_KEY?: string;

  NOTIFICATION_PROVIDER?: "console" | "twilio";
  OWNER_PHONE?: string;
  OWNER_EMAIL?: string;
  TWILIO_ACCOUNT_SID?: string;
  TWILIO_AUTH_TOKEN?: string;
  TWILIO_FROM_NUMBER?: string;

  YELP_WEBHOOK_SECRET?: string;
  WEBSITE_WEBHOOK_SECRET?: string;
  ADMIN_TOKEN?: string;
}
