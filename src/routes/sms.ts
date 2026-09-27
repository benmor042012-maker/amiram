import { Hono } from "hono";
import type { AppEnv } from "../app";
import { isValidTwilioSignature } from "../util/twilioSignature";

const EMPTY_TWIML = '<?xml version="1.0" encoding="UTF-8"?><Response></Response>';

/**
 * Twilio "A message comes in" webhook for the business number. Replies are
 * sent through the API by the pipeline, so the TwiML response is empty.
 * STOP/HELP auto-replies come from Twilio's built-in opt-out handling.
 */
export const smsRoutes = new Hono<AppEnv>().post("/inbound", async (c) => {
  const authToken = c.env.TWILIO_AUTH_TOKEN;
  if (!authToken) return c.json({ error: "SMS is not configured" }, 503);

  const form = await c.req.raw.formData();
  const params: Record<string, string> = {};
  for (const [key, value] of form.entries()) if (typeof value === "string") params[key] = value;

  const valid = await isValidTwilioSignature(authToken, c.req.url, params, c.req.header("x-twilio-signature"));
  if (!valid) return c.json({ error: "invalid signature" }, 403);

  const outcome = await c.var.services.smsInbound.handle(params.From ?? "", params.Body ?? "");
  if (outcome.kind === "REPLY_HANDLED") c.executionCtx.waitUntil(outcome.background);
  return c.body(EMPTY_TWIML, 200, { "content-type": "text/xml" });
});
