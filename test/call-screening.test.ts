import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import type { ExtractionResult, LeadExtractor } from "../src/ai/LeadExtractionService";
import { createApp } from "../src/app";
import { callScreeningConfig } from "../src/config/callScreening";
import { ConsoleNotificationProvider } from "../src/notifications/NotificationProvider";
import { ConsoleCustomerMessaging } from "../src/messaging/CustomerMessagingProvider";
import type { ServiceOverrides } from "../src/services";
import { createServices } from "../src/services";
import { twilioSignature } from "../src/util/twilioSignature";
import { FakeClock, ScriptedExtractor } from "./helpers";

const OWNER = "+13105550000"; // OWNER_PHONE binding in vitest.config.ts
const CALLER = "+13105551234";
const BASE = "http://localhost";

const ai = (facts: ExtractionResult["facts"], summary: string): ExtractionResult => ({ method: "AI", summary, facts });

const SCRIPT: Record<string, ExtractionResult> = {
  "leaking into the bedroom": ai(
    { serviceType: "ROOF_LEAK", activeLeak: true, emergency: true, city: "Beverly Hills", homeOwner: true, intent: "ROOFING_REQUEST" },
    "Homeowner in Beverly Hills with water leaking into the bedroom.",
  ),
  "new roof": ai(
    { serviceType: "ROOF_REPLACEMENT", city: "Pasadena", intent: "ROOFING_REQUEST" },
    "Caller wants a quote for a new roof in Pasadena.",
  ),
  "Phoenix": ai(
    { serviceType: "ROOF_REPAIR", city: "Phoenix", state: "AZ", intent: "ROOFING_REQUEST" },
    "Caller needs a roof repair in Phoenix, Arizona.",
  ),
  "Google listing": ai({ intent: "SPAM" }, "Automated pitch about a Google business listing."),
  "SEO services": ai({ intent: "VENDOR_SOLICITATION" }, "Marketing agency offering SEO services."),
  "looking for work": ai({ intent: "JOB_SEEKER" }, "Roofer asking about job openings."),
  "call me back about": ai(
    { serviceType: "ROOF_LEAK", zip: "91403", intent: "ROOFING_REQUEST" },
    "Caller left a voicemail about a roof leak in 91403.",
  ),
  "please call me back": ai({}, "Caller asked for a callback."),
};

let clock: FakeClock;
let notifier: ConsoleNotificationProvider;
let overrides: ServiceOverrides;

beforeEach(async () => {
  await env.DB.batch(
    ["calls", "caller_rules", "follow_up_messages", "follow_ups", "lead_events", "messages", "leads", "sms_opt_outs"].map(
      (t) => env.DB.prepare(`DELETE FROM ${t}`),
    ),
  );
  clock = new FakeClock();
  notifier = new ConsoleNotificationProvider();
  overrides = {
    extractor: new ScriptedExtractor(SCRIPT),
    notifier,
    customerMessaging: new ConsoleCustomerMessaging(),
    clock: clock.now,
  };
});

async function post(path: string, params: Record<string, string>, signature?: string) {
  const sig = signature ?? (await twilioSignature("test-twilio-token", `${BASE}${path}`, params));
  const ctx = createExecutionContext();
  const response = await createApp(overrides).request(
    path,
    {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", "x-twilio-signature": sig },
      body: new URLSearchParams(params).toString(),
    },
    env,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return response;
}

async function voice(path: string, params: Record<string, string>) {
  const response = await post(`/api/voice/${path}`, params);
  expect(response.status).toBeLessThan(300);
  return response.text();
}

/** A new call: returns the incoming TwiML. */
function call(sid: string, from = CALLER, extra: Record<string, string> = {}) {
  return voice("incoming", { CallSid: sid, From: from, To: "+13235550000", ...extra });
}

/** Caller answers the screening question; returns the TwiML of the routing step. */
async function answer(sid: string, speech: string) {
  const screen = await voice("screen", { CallSid: sid, SpeechResult: speech });
  expect(screen).toContain("One moment while we connect you");
  expect(screen).toContain(`<Redirect>${BASE}/api/voice/route</Redirect>`);
  return voice("route", { CallSid: sid });
}

const ownerTexts = () => notifier.sent;
const services = () => createServices(env, overrides);
const leadFor = async (sid: string) => services().leads.findByExternalId("PHONE", sid);
const callRow = async (sid: string) => services().calls.find(sid);

describe("call screening (Module 4)", () => {
  it("asks an unknown caller what they need before ringing anyone", async () => {
    const twiml = await call("CA1");
    expect(twiml).toContain('<Gather input="speech"');
    expect(twiml).toContain(`action="${BASE}/api/voice/screen"`);
    expect(twiml).toContain("what roofing work you need");
    expect(twiml).not.toContain("<Dial");
    expect((await callRow("CA1"))?.decision).toBe("SCREENING");
  });

  it("rings Amiram for a hot lead, whispers the details, and connects on 1", async () => {
    await call("CA1");
    const route = await answer("CA1", "Water is leaking into the bedroom, we're in Beverly Hills");
    expect(route).toContain(`<Dial callerId="${CALLER}"`);
    expect(route).toContain(`<Number url="${BASE}/api/voice/whisper?call=CA1">${OWNER}</Number>`);

    const whisper = await voice("whisper?call=CA1", { CallSid: "CA-child", ParentCallSid: "CA1" });
    expect(whisper).toContain("Family Roofing call. HOT lead. roof leak. Active leak. In Beverly Hills. Press 1 to take the call.");
    expect(whisper).toContain(`action="${BASE}/api/voice/accept?call=CA1"`);

    expect(await voice("accept?call=CA1", { CallSid: "CA-child", Digits: "1" })).not.toContain("Hangup");
    expect(await voice("dial-ended", { CallSid: "CA1", DialCallStatus: "completed" })).toContain("<Hangup/>");
    await voice("status", { CallSid: "CA1", CallStatus: "completed" });

    const lead = await leadFor("CA1");
    expect(lead).toMatchObject({
      source: "PHONE", leadScore: "HOT", phoneE164: CALLER, city: "Beverly Hills",
      originalMessage: "Water is leaking into the bedroom, we're in Beverly Hills", ownerNotificationStatus: "SKIPPED",
    });
    expect(await callRow("CA1")).toMatchObject({ decision: "RING", outcome: "ANSWERED", leadId: lead!.id });
    // He took the call, so no summary text.
    expect(ownerTexts()).toHaveLength(0);
  });

  it("missed call: texts Amiram the screened summary, then forwards the voicemail", async () => {
    await call("CA2");
    await answer("CA2", "I need a quote for a new roof in Pasadena");
    // Amiram's voicemail picked up (no key pressed).
    expect(await voice("whisper?call=CA2", { CallSid: "CA-child" })).toContain("WARM lead. roof replacement. In Pasadena.");
    const afterDial = await voice("dial-ended", { CallSid: "CA2", DialCallStatus: "completed" });
    expect(afterDial).toContain("Amiram couldn't get to the phone");
    expect(afterDial).toContain('<Record maxLength="120"');

    expect(ownerTexts()).toHaveLength(1);
    expect(ownerTexts()[0]).toMatch(/^📞 Missed call: they're leaving a voicemail\n\nWARM LEAD\n\nSource: Phone call\n/);
    expect(ownerTexts()[0]).toContain(`Phone: ${CALLER}`);
    expect(ownerTexts()[0]).toContain('Caller said:\n"I need a quote for a new roof in Pasadena"');

    await voice("recorded", { CallSid: "CA2", RecordingDuration: "14" });
    await voice("status", { CallSid: "CA2", CallStatus: "completed" });
    await voice("transcription", {
      CallSid: "CA2", TranscriptionStatus: "completed", TranscriptionText: "Hi it's Dana, I need a new roof, call me at 4",
    });
    expect(ownerTexts()).toHaveLength(2);
    expect(ownerTexts()[1]).toContain('"Hi it\'s Dana, I need a new roof, call me at 4"');
    expect(await callRow("CA2")).toMatchObject({ outcome: "VOICEMAIL", voicemailTranscript: expect.stringContaining("Dana") });
  });

  it("ends spam and sales calls politely without bothering Amiram", async () => {
    await call("CA3", "+12135550101");
    const route = await answer("CA3", "This is an important message about your Google listing");
    expect(route).toContain("not able to help with this request");
    expect(route).toContain("<Hangup/>");
    expect(route).not.toContain("<Dial");

    await call("CA4", "+12135550102");
    expect(await answer("CA4", "Hi, we offer SEO services for contractors")).not.toContain("<Dial");

    await voice("status", { CallSid: "CA3", CallStatus: "completed" });
    await voice("status", { CallSid: "CA4", CallStatus: "completed" });
    expect(ownerTexts()).toHaveLength(0);
    expect(await leadFor("CA4")).toMatchObject({ intent: "VENDOR_SOLICITATION", status: "CLOSED", ownerNotificationStatus: "SKIPPED" });

    // The cron safety net must not pick them up either.
    clock.advance(3600);
    expect(await services().qualification.processTimeouts()).toBe(0);
  });

  it("auto-blocks a number after repeated spam calls", async () => {
    const SPAMMER = "+12135550199";
    for (const sid of ["CA5", "CA6"]) {
      await call(sid, SPAMMER);
      await answer(sid, "Final notice about your Google listing");
    }
    expect(await call("CA7", SPAMMER)).toContain('<Reject reason="busy"/>');
    expect((await callRow("CA7"))?.decision).toBe("BLOCKED");
  });

  it("sends out-of-area callers and job seekers to voicemail and texts Amiram after", async () => {
    await call("CA8");
    const route = await answer("CA8", "I need a roof repair in Phoenix");
    expect(route).toContain("Amiram isn't available right now");
    expect(route).toContain("<Record");
    expect(route).not.toContain("<Dial");
    expect(ownerTexts()).toHaveLength(0);

    await voice("status", { CallSid: "CA8", CallStatus: "completed" });
    expect(ownerTexts()).toHaveLength(1);
    expect(ownerTexts()[0]).toMatch(/^🎙 Call sent to voicemail \(outside service area\)\n\nLOW-PRIORITY LEAD/);

    await call("CA9", "+13105559999");
    expect(await answer("CA9", "I'm a roofer looking for work")).toContain("<Record");
    expect((await callRow("CA9"))?.reason).toBe("intent:JOB_SEEKER");
  });

  it("robocall silence goes to voicemail; a real message from it still reaches Amiram", async () => {
    await call("CA10");
    const noAnswer = await voice("screen", { CallSid: "CA10", SpeechResult: "" });
    expect(noAnswer).toContain("We didn't catch that");
    expect(noAnswer).toContain("<Record");
    await voice("status", { CallSid: "CA10", CallStatus: "completed" });
    expect(ownerTexts()).toHaveLength(0);
    expect(await callRow("CA10")).toMatchObject({ decision: "NO_RESPONSE", outcome: "HUNG_UP" });

    await call("CA11", "+13105558888");
    await voice("screen", { CallSid: "CA11", SpeechResult: "" });
    await voice("transcription", {
      CallSid: "CA11", TranscriptionStatus: "completed", TranscriptionText: "Please call me back about a leak, zip 91403",
    });
    expect(ownerTexts()).toHaveLength(1);
    expect(ownerTexts()[0]).toMatch(/^🎙 Voicemail from a new caller\n\n/);
    expect(await leadFor("CA11")).toMatchObject({ zip: "91403", serviceType: "ROOF_LEAK" });
  });

  it("rings known customers straight through", async () => {
    const { qualification } = services();
    await qualification.ingestCall(
      { source: "PHONE", externalLeadId: "CA-old", sourceCreatedAt: null, originalMessage: "I need a new roof",
        knownFacts: { phone: CALLER, name: "Dana Levi" }, rawPayload: null },
      1000,
    );

    const twiml = await call("CA12");
    expect(twiml).toContain("Connecting you now");
    expect(twiml).toContain("<Dial");
    expect(twiml).not.toContain("<Gather");
    expect(await voice("whisper?call=CA12", { CallSid: "CA-child" })).toContain("call from Dana Levi, an existing customer");

    // A failed STIR/SHAKEN check means the number may be spoofed: screen it.
    expect(await call("CA13", CALLER, { StirVerstat: "TN-Validation-Failed" })).toContain("<Gather");
  });

  it("rings through when the AI is too slow, flagged as not screened", async () => {
    const hanging: LeadExtractor = { extract: () => new Promise(() => {}) };
    overrides = { ...overrides, extractor: hanging, callScreeningConfig: { ...callScreeningConfig, aiBudgetMs: 50 } };
    await call("CA14");
    expect(await answer("CA14", "Something about my roof")).toContain("<Dial");
    expect(await voice("whisper?call=CA14", { CallSid: "CA-child" })).toContain("New caller, not screened.");
    expect((await leadFor("CA14"))?.extractionMethod).toBe("FALLBACK");
  });

  it("Amiram manages screening by text: CALLS, BLOCK, ALLOW, UNBLOCK", async () => {
    await call("CA15", "+12135550102");
    await answer("CA15", "We offer SEO services");

    const sms = async (body: string) => {
      await post("/api/sms/inbound", { From: OWNER, To: "+13235550000", Body: body });
      return ownerTexts().at(-1)!;
    };
    const calls = await sms("CALLS");
    expect(calls).toContain("Calls (24h): 1 total, 0 rang you, 1 screened out.");
    expect(calls).toContain('+12135550102: sales call "We offer SEO services"');

    expect(await sms("ALLOW 213-555-0102")).toContain("+12135550102 always rings through");
    expect(await call("CA16", "+12135550102")).toContain("<Dial");

    expect(await sms("BLOCK 213-555-0102")).toContain("+12135550102 is blocked");
    expect(await call("CA17", "+12135550102")).toContain("<Reject");

    expect(await sms("UNBLOCK 213-555-0102")).toContain("back to normal screening");
    expect(await call("CA18", "+12135550102")).toContain("<Gather");
  });

  it("rejects requests without a valid Twilio signature", async () => {
    const response = await post("/api/voice/incoming", { CallSid: "CA19", From: CALLER }, "bad-signature");
    expect(response.status).toBe(403);
    expect(await callRow("CA19")).toBeNull();
  });

  it("counts screened calls in the pilot metrics", async () => {
    await call("CA20");
    await answer("CA20", "Water is leaking into the bedroom in Beverly Hills");
    await call("CA21", "+12135550101");
    await answer("CA21", "Message about your Google listing");
    await call("CA22", "+12135550103");
    await voice("screen", { CallSid: "CA22", SpeechResult: "" });

    const metrics = await services().metrics.compute();
    expect(metrics.calls).toMatchObject({
      received: 3, rangOwner: 1, filtered: 1, noResponse: 1,
      byReason: { "intent:ROOFING_REQUEST": 1, "intent:SPAM": 1, no_speech: 1 },
    });
    expect(metrics.leadsBySource.PHONE).toBe(2);
  });
});
