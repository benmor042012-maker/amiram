import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import type { ExtractionResult } from "../src/ai/LeadExtractionService";
import { ConsoleNotificationProvider } from "../src/notifications/NotificationProvider";
import { createServices } from "../src/services";
import { FakeClock, ScriptedExtractor } from "./helpers";

const EXAMPLE_MESSAGE =
  "Hi, we have water leaking through our bedroom ceiling in Beverly Hills. We own the house and need someone as soon as possible.";

/** What Claude is expected to extract from EXAMPLE_MESSAGE. */
const EXAMPLE_EXTRACTION: ExtractionResult = {
  method: "AI",
  summary: "Homeowner in Beverly Hills reports water leaking through the bedroom ceiling and wants someone as soon as possible.",
  facts: {
    name: null, phone: null, email: null, address: null, city: "Beverly Hills", state: "CA", zip: null,
    serviceType: "ROOF_LEAK", problemDescription: "Water leaking through bedroom ceiling",
    activeLeak: true, emergency: true, homeOwner: true, inspectionRequested: null,
    roofType: null, roofAge: null, desiredTimeframe: "ASAP", preferredContactTime: null,
    intent: "ROOFING_REQUEST",
  },
};

const FOLLOW_UP_EXTRACTION: ExtractionResult = {
  ...EXAMPLE_EXTRACTION,
  facts: {
    ...EXAMPLE_EXTRACTION.facts,
    address: "123 N Rodeo Dr",
    zip: "90210",
    phone: "310-555-0142",
    preferredContactTime: "Any time today",
  },
};

let clock: FakeClock;
let notifier: ConsoleNotificationProvider;
let extractor: ScriptedExtractor;

function app() {
  return createApp({ extractor, notifier, clock: clock.now });
}

async function post(path: string, body: unknown, secret = "test-yelp-secret") {
  const ctx = createExecutionContext();
  const response = await app().request(
    path,
    { method: "POST", headers: { "content-type": "application/json", "x-webhook-secret": secret }, body: JSON.stringify(body) },
    env,
    ctx,
  );
  await waitOnExecutionContext(ctx); // let the background owner notification finish
  return response;
}

async function admin(path: string) {
  const response = await app().request(path, { headers: { authorization: "Bearer test-admin-token" } }, env, createExecutionContext());
  return response.json() as Promise<any>;
}

beforeEach(async () => {
  await env.DB.batch(["lead_events", "messages", "leads", "sms_opt_outs"].map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
  clock = new FakeClock();
  notifier = new ConsoleNotificationProvider();
  extractor = new ScriptedExtractor(
    {
      "bedroom ceiling": EXAMPLE_EXTRACTION,
      "Rodeo": FOLLOW_UP_EXTRACTION,
    },
    clock,
    2.5, // simulated AI latency
  );
});

describe("simulated Yelp lead (step 9)", () => {
  it("extracts, scores HOT, replies without redundant questions, notifies Amiram, and tracks response time", async () => {
    const response = await post("/api/yelp/leads", {
      yelp_lead_id: "yelp-abc-1",
      customer_name: "John Smith",
      message: EXAMPLE_MESSAGE,
      created_at: "2026-09-27T16:59:58.000Z",
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as any;

    // Deterministic score + immediate reply for Zapier to post in Yelp.
    expect(body).toMatchObject({ duplicate: false, send_reply: true, lead_score: "HOT" });
    expect(body.reply).toMatch(/^Hi John, thanks for reaching out to Family Roofing!/);
    expect(body.reply).toContain("Sorry to hear about the leak");
    // Asks only for what is missing...
    expect(body.reply).toContain("the property address (or at least the ZIP code)");
    expect(body.reply).toContain("the best phone number for Amiram to call you");
    expect(body.reply).toContain("a good time for a callback or an inspection");
    // ...never for what the message already said.
    expect(body.reply).not.toMatch(/own the property|actively coming in|kind of roofing help/i);
    // No prices, promises, or diagnoses.
    expect(body.reply).not.toMatch(/\$|price|quote|guarantee|damage/i);

    // The AI only received the customer's words and the form fields.
    expect(extractor.requests[0]).toEqual({
      customerMessages: [EXAMPLE_MESSAGE],
      knownFacts: { name: "John Smith", phone: null, email: null, zip: null, city: null },
    });

    const { lead, messages, events } = await admin(`/api/admin/leads/${body.lead_id}`);
    expect(lead).toMatchObject({
      source: "YELP",
      externalLeadId: "yelp-abc-1",
      name: "John Smith",
      city: "Beverly Hills",
      serviceType: "ROOF_LEAK",
      activeLeak: true,
      homeOwner: true,
      emergency: true,
      desiredTimeframe: "ASAP",
      leadScore: "HOT",
      serviceArea: "IN_AREA",
      qualificationStatus: "PARTIAL",
      conversationStatus: "AWAITING_CUSTOMER",
      ownerNotificationStatus: "SENT",
      notifiedScore: "HOT",
      status: "OWNER_NOTIFIED",
      extractionMethod: "AI",
      sourceCreatedAt: "2026-09-27T16:59:58.000Z",
      firstAutomatedResponseAt: "2026-09-27T17:00:02.500Z",
      responseTimeSeconds: 2.5,
    });
    expect(lead.leadReasons).toEqual([
      "Active water leak",
      "Emergency / urgent request",
      "Roof leak",
      "Homeowner",
      "Short timeframe",
      "In service area",
    ]);

    // Amiram is notified right away because the lead is HOT.
    expect(notifier.sent).toHaveLength(1);
    const notification = notifier.sent[0]!;
    expect(notification).toMatch(/^🔥 HOT LEAD/);
    for (const line of [
      "Source: Yelp",
      "Name: John Smith",
      "Location: Beverly Hills",
      "Service: Roof Leak",
      "Active leak: YES",
      "Homeowner: YES",
      "Timing: ASAP",
      EXAMPLE_EXTRACTION.summary!,
      "Recommended action:\nCall immediately.",
    ]) {
      expect(notification).toContain(line);
    }

    expect(messages.map((m: any) => `${m.direction}:${m.recipient}:${m.deliveryStatus}`)).toEqual([
      "INBOUND:CUSTOMER:RECEIVED",
      "OUTBOUND:CUSTOMER:HANDED_OFF",
      "OUTBOUND:OWNER:SENT",
    ]);
    const autoResponse = events.find((e: any) => e.type === "AUTO_RESPONSE_SENT");
    expect(autoResponse.data).toEqual({ responseTimeSeconds: 2.5, sourceToResponseSeconds: 4.5 });
    // Event data holds no customer PII.
    expect(JSON.stringify(events)).not.toContain("John");
  });

  it("finishes qualification from the customer's reply and forwards it to Amiram", async () => {
    const first = (await (await post("/api/yelp/leads", { yelp_lead_id: "yelp-abc-2", customer_name: "John Smith", message: EXAMPLE_MESSAGE })).json()) as any;

    const response = await post("/api/yelp/messages", {
      yelp_lead_id: "yelp-abc-2",
      message: "123 N Rodeo Dr, 90210. Call me at 310-555-0142 any time today.",
    });
    const body = (await response.json()) as any;
    expect(body).toMatchObject({ send_reply: true, lead_score: "HOT" });
    expect(body.reply).toBe("Thank you, that helps. We have what we need, and Amiram will contact you shortly.");

    const { lead } = await admin(`/api/admin/leads/${first.lead_id}`);
    expect(lead).toMatchObject({
      address: "123 N Rodeo Dr",
      zip: "90210",
      phone: "310-555-0142",
      qualificationStatus: "COMPLETE",
      conversationStatus: "CLOSED",
      customerTurns: 1,
    });
    // The second extraction saw the whole conversation.
    expect(extractor.requests[1]!.customerMessages).toHaveLength(2);
    // Already notified as HOT, so the answer is forwarded rather than re-sent as a new lead.
    expect(notifier.sent).toHaveLength(2);
    expect(notifier.sent[1]).toMatch(/^💬 New message from John Smith/);
  });

  it("is idempotent when Zapier retries the same Yelp lead", async () => {
    const first = (await (await post("/api/yelp/leads", { yelp_lead_id: "yelp-dup", message: EXAMPLE_MESSAGE })).json()) as any;
    const second = (await (await post("/api/yelp/leads", { yelp_lead_id: "yelp-dup", message: EXAMPLE_MESSAGE })).json()) as any;
    expect(second).toMatchObject({ duplicate: true, lead_id: first.lead_id, reply: first.reply });
    expect(extractor.requests).toHaveLength(1);
    expect(notifier.sent).toHaveLength(1);
  });

  it("still replies and notifies when the AI is unavailable", async () => {
    extractor = new ScriptedExtractor({}, clock); // every extraction throws
    const services = createServices(env, { notifier, clock: clock.now }); // real resilient extractor, no API key in tests
    const result = await services.qualification.handleNewLead(
      {
        source: "YELP", externalLeadId: "yelp-noai", sourceCreatedAt: null,
        originalMessage: "My roof is leaking, zip 90046", knownFacts: { name: "Dana" }, rawPayload: {},
      },
    );
    await result.background;
    expect(result.reply).toContain("Hi Dana");
    expect(result.lead).toMatchObject({ extractionMethod: "FALLBACK", serviceType: "ROOF_LEAK", zip: "90046" });
    expect(result.lead.leadReasons).toContain("AI extraction unavailable");
    // Notified immediately, not after the qualification timeout.
    expect(notifier.sent).toHaveLength(1);
    expect(notifier.sent[0]).toContain("AI was unavailable");
  });

  it("notifies Amiram via the cron once a non-urgent lead stops replying", async () => {
    extractor = new ScriptedExtractor({
      gutter: {
        method: "AI",
        summary: "Customer asks about a small repair near the gutter.",
        facts: { serviceType: "ROOF_REPAIR", intent: "ROOFING_REQUEST", problemDescription: "Small repair near gutter" },
      },
    });
    const created = (await (await post("/api/yelp/leads", { yelp_lead_id: "yelp-warm", message: "Need a small repair near the gutter" })).json()) as any;
    expect(created.lead_score).toBe("WARM");
    expect(notifier.sent).toHaveLength(0); // waiting for the customer's answers

    const services = createServices(env, { extractor, notifier, clock: clock.now });
    expect(await services.qualification.processTimeouts()).toBe(0);
    clock.advance(11 * 60);
    expect(await services.qualification.processTimeouts()).toBe(1);
    expect(notifier.sent[0]).toMatch(/^WARM LEAD/);
    expect(await services.qualification.processTimeouts()).toBe(0);
  });

  it("does not reply to or notify about spam", async () => {
    extractor = new ScriptedExtractor({
      SEO: { method: "AI", summary: "SEO sales pitch.", facts: { intent: "SPAM" } },
    });
    const body = (await (await post("/api/yelp/leads", { yelp_lead_id: "yelp-spam", message: "Cheap SEO services!!!" })).json()) as any;
    expect(body).toMatchObject({ send_reply: false, reply: "", lead_score: "LOW" });
    expect(notifier.sent).toHaveLength(0);
  });

  it("rejects requests without the webhook secret", async () => {
    const response = await post("/api/yelp/leads", { yelp_lead_id: "x", message: "hi" }, "wrong");
    expect(response.status).toBe(401);
  });

  it("rejects payloads without a Yelp lead id or message", async () => {
    expect((await post("/api/yelp/leads", { message: "hi" })).status).toBe(400);
    expect((await post("/api/yelp/leads", { yelp_lead_id: "x" })).status).toBe(400);
  });

  it("reports pilot metrics", async () => {
    await post("/api/yelp/leads", { yelp_lead_id: "yelp-m1", customer_name: "John", message: EXAMPLE_MESSAGE });
    const metrics = await admin("/api/admin/metrics");
    expect(metrics).toMatchObject({
      leadsReceived: 1,
      leadsBySource: { YELP: 1 },
      leadsContacted: 1,
      hotLeads: 1,
      ownerNotifications: 1,
      responseTimeSeconds: { average: 2.5, median: 2.5, max: 2.5 },
    });
  });
});
