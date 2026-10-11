import { Hono } from "hono";
import type { AppEnv } from "../app";
import type { CallScreeningService } from "../calls/CallScreeningService";
import { logError } from "../util/log";
import { isValidTwilioSignature } from "../util/twilioSignature";

type VoiceEnv = AppEnv & {
  Variables: AppEnv["Variables"] & { params: Record<string, string>; screening: CallScreeningService };
};

const XML = { "content-type": "text/xml" };

/**
 * Twilio Voice webhooks for the business number (Module 4, call screening).
 * Configure the number's "A call comes in" to POST /api/voice/incoming and
 * "Call status changes" to POST /api/voice/status. The other paths are
 * callback URLs inside the TwiML this service returns.
 */
export const voiceRoutes = new Hono<VoiceEnv>()
  .use(async (c, next) => {
    const authToken = c.env.TWILIO_AUTH_TOKEN;
    const factory = c.var.services.callScreening;
    if (!authToken || !factory) return c.json({ error: "voice is not configured" }, 503);

    const form = await c.req.raw.formData();
    const params: Record<string, string> = {};
    for (const [key, value] of form.entries()) if (typeof value === "string") params[key] = value;
    const valid = await isValidTwilioSignature(authToken, c.req.url, params, c.req.header("x-twilio-signature"));
    if (!valid) return c.json({ error: "invalid signature" }, 403);

    c.set("params", params);
    c.set("screening", factory(new URL(c.req.url).origin));
    await next();
  })
  .post("/incoming", async (c) => {
    const p = c.var.params;
    const body = await c.var.screening.incoming({
      callSid: p.CallSid ?? "", from: p.From ?? "", stirVerstat: p.StirVerstat ?? null,
    });
    return c.body(body, 200, XML);
  })
  .post("/screen", async (c) => c.body(await c.var.screening.screened(c.var.params.CallSid ?? "", c.var.params.SpeechResult ?? ""), 200, XML))
  .post("/route", async (c) => c.body(await c.var.screening.route(c.var.params.CallSid ?? ""), 200, XML))
  // Amiram's leg: the parent call's sid travels in the query string.
  .post("/whisper", async (c) => c.body(await c.var.screening.whisper(c.req.query("call") ?? ""), 200, XML))
  .post("/accept", async (c) => c.body(await c.var.screening.accept(c.req.query("call") ?? "", c.var.params.Digits ?? ""), 200, XML))
  .post("/dial-ended", async (c) => {
    const p = c.var.params;
    return c.body(await c.var.screening.dialEnded(p.CallSid ?? "", p.DialCallStatus ?? ""), 200, XML);
  })
  .post("/recorded", async (c) => {
    const p = c.var.params;
    return c.body(await c.var.screening.recorded(p.CallSid ?? "", Number(p.RecordingDuration ?? 0) || 0), 200, XML);
  })
  .post("/transcription", async (c) => {
    const p = c.var.params;
    if (p.TranscriptionStatus === "completed") {
      c.executionCtx.waitUntil(
        c.var.screening
          .voicemailTranscribed(p.CallSid ?? "", p.TranscriptionText ?? "")
          .catch((error) => logError("call.transcription_failed", error, { callSid: p.CallSid })),
      );
    }
    return c.body(null, 204);
  })
  .post("/status", async (c) => {
    if (c.var.params.CallStatus && ["completed", "busy", "failed", "no-answer", "canceled"].includes(c.var.params.CallStatus)) {
      const callSid = c.var.params.CallSid ?? "";
      c.executionCtx.waitUntil(
        c.var.screening.completed(callSid).catch((error) => logError("call.completion_failed", error, { callSid })),
      );
    }
    return c.body(null, 204);
  });
