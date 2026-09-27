import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import type { ExtractionResult } from "../src/ai/LeadExtractionService";
import { WebsiteLeadAdapter } from "../src/lead-sources/WebsiteLeadAdapter";
import { ConsoleCustomerMessaging } from "../src/messaging/CustomerMessagingProvider";
import { ConsoleNotificationProvider } from "../src/notifications/NotificationProvider";
import { twilioSignature } from "../src/util/twilioSignature";
import { FakeClock, ScriptedExtractor } from "./helpers";

const REPLACEMENT: ExtractionResult = {
  method: "AI",
  summary: "Homeowner wants a quote to replace an old shingle roof in Sherman Oaks within the month.",
  facts: {
    serviceType: "ROOF_REPLACEMENT", homeOwner: true, roofType: "shingle", roofAge: "25 years",
    desiredTimeframe: "WITHIN_MONTH", city: "Sherman Oaks", intent: "ROOFING_REQUEST",
    problemDescription: "Old shingle roof needs replacement",
  },
};
const REPLY_EXTRACTION: ExtractionResult = {
  ...REPLACEMENT,
  facts: { ...REPLACEMENT.facts, address: "4500 Van Nuys Blvd", zip: "91403", preferredContactTime: "Weekday mornings" },
};

let clock: FakeClock;
let notifier: ConsoleNotificationProvider;
let sms: ConsoleCustomerMessaging;
let extractor: ScriptedExtractor;

function app() {
  return createApp({ extractor, notifier, customerMessaging: sms, clock: clock.now });
}

async function run(path: string, init: RequestInit) {
  const ctx = createExecutionContext();
  const response = await app().request(path, init, env, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

function submitJson(fields: Record<string, unknown>, secret = "test-website-secret") {
  return run("/api/website/leads", {
    method: "POST",
    headers: { "content-type": "application/json", "x-webhook-secret": secret },
    body: JSON.stringify(fields),
  });
}

async function inboundSms(from: string, body: string, signature?: string) {
  const params = { From: from, To: "+13235550000", Body: body, MessageSid: `SM${Math.random()}` };
  const sig = signature ?? (await twilioSignature("test-twilio-token", "http://localhost/api/sms/inbound", params));
  return run("/api/sms/inbound", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", "x-twilio-signature": sig },
    body: new URLSearchParams(params).toString(),
  });
}

async function admin(path: string) {
  const response = await app().request(path, { headers: { authorization: "Bearer test-admin-token" } }, env, createExecutionContext());
  return response.json() as Promise<any>;
}

const FORM = {
  name: "Maria Lopez",
  phone: "(818) 555-0123",
  email: "maria@example.com",
  service: "Roof Replacement",
  message: "Our shingle roof is about 25 years old. We own the home and want to replace it this month.",
  sms_consent: "1",
};

beforeEach(async () => {
  await env.DB.batch(["follow_up_messages", "follow_ups", "lead_events", "messages", "leads", "sms_opt_outs"].map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
  clock = new FakeClock();
  notifier = new ConsoleNotificationProvider();
  sms = new ConsoleCustomerMessaging();
  extractor = new ScriptedExtractor({ "25 years old": REPLACEMENT, "Van Nuys": REPLY_EXTRACTION }, clock, 2);
});

describe("website lead (Module 2)", () => {
  it("texts a consenting customer right away through the same pipeline and notifies Amiram", async () => {
    const response = await submitJson(FORM);
    expect(response.status).toBe(200);
    const body = (await response.json()) as any;
    expect(body).toMatchObject({ duplicate: false, customer_texted: true, lead_score: "HOT" });

    expect(sms.sent).toHaveLength(1);
    const text = sms.sent[0]!;
    expect(text.to).toBe("+18185550123");
    expect(text.body).toMatch(/^Hi Maria, thanks for reaching out to Family Roofing!/);
    expect(text.body).toContain("the property address (or at least the ZIP code)");
    expect(text.body).not.toMatch(/phone number|own the property|kind of roofing help/);
    expect(text.body).toMatch(/Reply STOP to opt out\.$/);

    const { lead, messages } = await admin(`/api/admin/leads/${body.lead_id}`);
    expect(lead).toMatchObject({
      source: "WEBSITE",
      name: "Maria Lopez",
      email: "maria@example.com",
      phoneE164: "+18185550123",
      smsConsent: true,
      serviceType: "ROOF_REPLACEMENT",
      leadScore: "HOT",
      conversationStatus: "AWAITING_CUSTOMER",
      ownerNotificationStatus: "SENT",
      responseTimeSeconds: 2,
    });
    expect(lead.originalMessage).toBe(`Service requested: Roof Replacement\n${FORM.message}`);
    expect(messages.map((m: any) => `${m.channel}:${m.direction}:${m.recipient}:${m.deliveryStatus}`)).toEqual([
      "WEBSITE:INBOUND:CUSTOMER:RECEIVED",
      "SMS:OUTBOUND:CUSTOMER:SENT",
      "SMS:OUTBOUND:OWNER:SENT",
    ]);
    expect(notifier.sent[0]).toMatch(/^🔥 HOT LEAD\n\nSource: Website/);
    expect(notifier.sent[0]).not.toContain("not texted");
  });

  it("continues the qualification when the customer texts back", async () => {
    await submitJson(FORM);
    const response = await inboundSms("+18185550123", "4500 Van Nuys Blvd 91403, weekday mornings are best");
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("<Response></Response>");

    expect(sms.sent).toHaveLength(2);
    expect(sms.sent[1]!.body).toBe("Thank you, that helps. We have what we need, and Amiram will contact you shortly.");
    const { leads } = await admin("/api/admin/leads");
    expect(leads[0]).toMatchObject({ qualification: "COMPLETE", conversation: "CLOSED" });
    // Already notified as HOT: the answer is forwarded to Amiram.
    expect(notifier.sent[1]).toMatch(/^💬 New message from Maria Lopez/);
  });

  it("does not text without explicit consent, and tells Amiram to call", async () => {
    const { sms_consent, ...noConsent } = FORM;
    const body = (await (await submitJson(noConsent)).json()) as any;
    expect(body.customer_texted).toBe(false);
    expect(sms.sent).toHaveLength(0);

    const { lead, events } = await admin(`/api/admin/leads/${body.lead_id}`);
    expect(lead).toMatchObject({ smsConsent: null, conversationStatus: "CLOSED", firstAutomatedResponseAt: null });
    expect(events.find((e: any) => e.type === "CUSTOMER_MESSAGE_SKIPPED").data).toEqual({ reason: "no_sms_consent" });
    expect(notifier.sent).toHaveLength(1);
    expect(notifier.sent[0]).toContain("Customer was not texted automatically");
  });

  it("stops texting after STOP and resumes after START", async () => {
    await submitJson(FORM);
    await inboundSms("+18185550123", "STOP");
    expect((await admin("/api/admin/metrics")).optOuts).toBe(1);

    // A new submission from the same number is not texted while opted out.
    await submitJson({ ...FORM, message: "Also 25 years old, second request about the same roof" });
    expect(sms.sent).toHaveLength(1);

    // Replies after opting out get no automated answer.
    await inboundSms("+18185550123", "4500 Van Nuys Blvd");
    expect(sms.sent).toHaveLength(1);

    await inboundSms("+18185550123", "start");
    await submitJson({ ...FORM, message: "Third try, roof is 25 years old" });
    expect(sms.sent).toHaveLength(2);
  });

  it("accepts Contact Form 7 style form posts with the secret in the body", async () => {
    const form = new URLSearchParams({
      "your-name": "Sam Lee",
      "your-tel": "323-555-0199",
      "your-message": "Shingles blew off, roof is 25 years old",
      "sms-consent": "on",
      webhook_secret: "test-website-secret",
    });
    const response = await run("/api/website/leads", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form.toString(),
    });
    const body = (await response.json()) as any;
    expect(response.status).toBe(200);
    expect(body.customer_texted).toBe(true);
    const { lead } = await admin(`/api/admin/leads/${body.lead_id}`);
    expect(lead).toMatchObject({ name: "Sam Lee", phoneE164: "+13235550199", smsConsent: true });
    const raw = await env.DB.prepare("SELECT raw_payload FROM leads WHERE id = ?").bind(body.lead_id).first<{ raw_payload: string }>();
    expect(raw!.raw_payload).not.toContain("test-website-secret");
  });

  it("treats a repeated identical submission as a duplicate", async () => {
    const first = (await (await submitJson(FORM)).json()) as any;
    const second = (await (await submitJson(FORM)).json()) as any;
    expect(second).toMatchObject({ duplicate: true, lead_id: first.lead_id });
    expect(sms.sent).toHaveLength(1);
  });

  it("rejects bad secrets, bad signatures and unusable submissions", async () => {
    expect((await submitJson(FORM, "wrong")).status).toBe(401);
    expect((await submitJson({ name: "No contact", message: "roof" })).status).toBe(400);
    expect((await inboundSms("+18185550123", "hello", "bad-signature")).status).toBe(403);
  });
});

describe("WebsiteLeadAdapter", () => {
  const adapter = new WebsiteLeadAdapter();

  it("maps common plugin field names and combines first/last name", () => {
    const input = adapter.parseNewLead({
      "First Name": "Ana", "Last Name": "Gomez", Email: "ana@example.com", "Zip Code": "90046",
      Services: ["Roof Repair", "Gutters"], Comments: "Small leak by the chimney", "Entry ID": "42",
    });
    expect(input).toMatchObject({
      externalLeadId: "entry:42",
      smsConsent: null,
      originalMessage: "Service requested: Roof Repair, Gutters\nSmall leak by the chimney",
      knownFacts: { name: "Ana Gomez", email: "ana@example.com", zip: "90046", phone: null },
    });
  });

  it("reads consent conservatively", () => {
    const base = { phone: "3105550100", message: "roof" };
    expect(adapter.parseNewLead({ ...base, sms_consent: "Yes, text me" }).smsConsent).toBe(true);
    expect(adapter.parseNewLead({ ...base, sms_consent: "" }).smsConsent).toBe(false);
    expect(adapter.parseNewLead({ ...base, sms_consent: "0" }).smsConsent).toBe(false);
  });
});
