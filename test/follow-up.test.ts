import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import {
  ConsoleCustomerMessaging,
  type CustomerMessagingProvider,
  type SendResult,
} from "../src/messaging/CustomerMessagingProvider";
import { ConsoleNotificationProvider } from "../src/notifications/NotificationProvider";
import { createServices } from "../src/services";
import { twilioSignature } from "../src/util/twilioSignature";
import { FakeClock, ScriptedExtractor } from "./helpers";

const OWNER = "+13105550000"; // OWNER_PHONE binding in vitest.config.ts
const CUSTOMER = "+13105551234";
const DAY = 86400;

let clock: FakeClock; // starts 2026-09-27T17:00Z = 10:00 in Los Angeles
let notifier: ConsoleNotificationProvider;
let sms: CustomerMessagingProvider & { sent: { to: string; body: string }[] };

function services() {
  return createServices(env, { notifier, customerMessaging: sms, clock: clock.now, extractor: new ScriptedExtractor({}) });
}

async function text(from: string, body: string) {
  const params = { From: from, To: "+13235550000", Body: body };
  const signature = await twilioSignature("test-twilio-token", "http://localhost/api/sms/inbound", params);
  const ctx = createExecutionContext();
  const response = await createApp({ notifier, customerMessaging: sms, clock: clock.now }).request(
    "/api/sms/inbound",
    {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", "x-twilio-signature": signature },
      body: new URLSearchParams(params).toString(),
    },
    env,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  expect(response.status).toBe(200);
}

async function onlyFollowUp() {
  const all = await services().followUpRepo.listSince("2000-01-01");
  expect(all).toHaveLength(1);
  return all[0]!;
}

beforeEach(async () => {
  await env.DB.batch(
    ["follow_up_messages", "follow_ups", "lead_events", "messages", "leads", "sms_opt_outs"].map((t) =>
      env.DB.prepare(`DELETE FROM ${t}`),
    ),
  );
  clock = new FakeClock();
  notifier = new ConsoleNotificationProvider();
  sms = new ConsoleCustomerMessaging();
});

describe("estimate follow-up (Module 3)", () => {
  it("Amiram starts it by SMS and the customer gets the day 1, 3 and 7 messages", async () => {
    await text(OWNER, "EST Yossi Cohen 310-555-1234 #1042");
    expect(notifier.sent.at(-1)).toMatch(/^👍 Follow-up started for Yossi Cohen \(#1042\)\. Texts go out on days 1, 3, 7/);

    const followUp = await onlyFollowUp();
    expect(followUp).toMatchObject({
      customerName: "Yossi Cohen", phoneE164: CUSTOMER, estimateExternalId: "1042",
      status: "ACTIVE", followUpStep: 0, nextActionAt: "2026-09-28T17:00:00.000Z",
    });

    const { followUps } = services();
    expect(await followUps.processDue()).toBe(0);

    clock.advance(DAY);
    expect(await followUps.processDue()).toBe(1);
    expect(sms.sent[0]).toEqual({
      to: CUSTOMER,
      body: "Hi Yossi, this is Family Roofing. Just checking that you received your roofing estimate. Let us know if you have any questions.\n\nReply STOP to opt out.",
    });

    clock.advance(DAY);
    expect(await followUps.processDue()).toBe(0); // day 2: nothing
    clock.advance(DAY);
    expect(await followUps.processDue()).toBe(1);
    expect(sms.sent[1]!.body).toBe(
      "Hi Yossi, just following up on your roofing estimate. If you'd like, Amiram can go over the scope, timing, or next steps with you.",
    );

    clock.advance(4 * DAY);
    expect(await followUps.processDue()).toBe(1);
    expect(sms.sent[2]!.body).toMatch(/^Hi Yossi, checking in one last time/);
    expect(await onlyFollowUp()).toMatchObject({ status: "COMPLETED", stopReason: "SEQUENCE_FINISHED", followUpStep: 3, nextActionAt: null });

    clock.advance(30 * DAY);
    expect(await followUps.processDue()).toBe(0);
    expect(sms.sent).toHaveLength(3);
  });

  it("stops when the customer replies and forwards the reply to Amiram", async () => {
    await text(OWNER, "EST Yossi Cohen 310-555-1234");
    clock.advance(DAY);
    await services().followUps.processDue();

    await text(CUSTOMER, "Thanks! Can Amiram call me tomorrow about the price?");
    expect(await onlyFollowUp()).toMatchObject({ status: "RESPONDED", stopReason: "CUSTOMER_REPLIED", nextActionAt: null });
    expect(notifier.sent.at(-1)).toBe(
      '💬 Yossi Cohen replied about their estimate:\n\n"Thanks! Can Amiram call me tomorrow about the price?"\n\nAutomatic follow-up stopped.',
    );

    clock.advance(10 * DAY);
    expect(await services().followUps.processDue()).toBe(0);
    expect(sms.sent).toHaveLength(1);
  });

  it("stops on STOP and never texts that number again", async () => {
    await text(OWNER, "EST Yossi Cohen 310-555-1234");
    await text(CUSTOMER, "stop");
    expect(await onlyFollowUp()).toMatchObject({ status: "OPTED_OUT", stopReason: "OPTED_OUT" });
    clock.advance(10 * DAY);
    expect(await services().followUps.processDue()).toBe(0);
    expect(sms.sent).toHaveLength(0);
  });

  it("WON marks the estimate accepted and the matching lead as won", async () => {
    const svc = services();
    const lead = await svc.leads.create(
      { source: "WEBSITE", externalLeadId: "entry:1", sourceCreatedAt: null, originalMessage: "roof", knownFacts: {}, rawPayload: {} },
      { ...(await import("../src/domain/lead")).emptyFacts(), name: "Yossi Cohen", phone: "(310) 555-1234" },
      clock.now().toISOString(),
    );
    await text(OWNER, "EST Yossi Cohen 3105551234");
    expect((await onlyFollowUp()).leadId).toBe(lead.id);

    await text(OWNER, "won yossi");
    expect(notifier.sent.at(-1)).toBe("✅ Yossi Cohen: marked as accepted. No more follow-ups.");
    expect(await onlyFollowUp()).toMatchObject({ status: "ACCEPTED", stopReason: "ESTIMATE_ACCEPTED" });
    expect((await svc.leads.findById(lead.id))!.status).toBe("WON");

    const metrics = await svc.metrics.compute();
    expect(metrics.won).toBe(1);
    expect(metrics.followUps).toMatchObject({ started: 1, accepted: 1 });
  });

  it("DONE stops it, by name or phone, and reports ambiguous names", async () => {
    await text(OWNER, "EST Dana Levi 310-555-1111");
    await text(OWNER, "EST Dana Katz 310-555-2222");
    await text(OWNER, "DONE Dana");
    expect(notifier.sent.at(-1)).toMatch(/^More than one match, please use the phone number:/);

    await text(OWNER, "DONE 310-555-2222");
    expect(notifier.sent.at(-1)).toBe("⏹ Follow-up for Dana Katz stopped.");
    await text(OWNER, "LIST");
    expect(notifier.sent.at(-1)).toBe("Active follow-ups (1):\nDana Levi: 0/3 sent");
  });

  it("only texts inside the daytime send window (Los Angeles time)", async () => {
    clock = new FakeClock(Date.parse("2026-09-28T03:00:00.000Z")); // 8pm Sunday in LA
    const { followUp } = await services().followUps.start({ customerName: "Night Owl", phone: "3105559999" });
    // Day 1 would be 8pm Monday: moved to 9am Tuesday LA time.
    expect(followUp.nextActionAt).toBe("2026-09-29T16:00:00.000Z");
  });

  it("stops on a number that can't receive texts, and retries transient failures", async () => {
    const failures: SendResult[] = [
      { status: "FAILED", providerMessageId: null, error: "Twilio 400 30001 queue overflow", errorCode: 30001 },
      { status: "FAILED", providerMessageId: null, error: "Twilio 400 21614 not a mobile number", errorCode: 21614 },
    ];
    sms = Object.assign(new ConsoleCustomerMessaging(), {
      sendSms: async () => failures.shift()!,
    });
    await services().followUps.start({ customerName: "Land Line", phone: "3105558888" });

    clock.advance(DAY);
    expect(await services().followUps.processDue()).toBe(0);
    expect(await onlyFollowUp()).toMatchObject({ status: "ACTIVE", followUpStep: 0, nextActionAt: "2026-09-28T18:00:00.000Z" });

    clock.advance(3600);
    await services().followUps.processDue();
    expect(await onlyFollowUp()).toMatchObject({ status: "CANCELLED", stopReason: "INVALID_PHONE" });
    expect(notifier.sent.at(-1)).toMatch(/Land Line stopped: the phone number can't receive texts/);
  });

  it("never sends the same step twice when cron runs overlap", async () => {
    await services().followUps.start({ customerName: "Yossi Cohen", phone: CUSTOMER });
    clock.advance(DAY);
    const [a, b] = await Promise.all([services().followUps.processDue(), services().followUps.processDue()]);
    expect(a + b).toBe(1);
    expect(sms.sent).toHaveLength(1);
  });

  it("does not start a second sequence for the same number, and explains bad commands", async () => {
    await text(OWNER, "EST Yossi Cohen 310-555-1234");
    await text(OWNER, "EST Yossi C 3105551234");
    expect(notifier.sent.at(-1)).toMatch(/is already active/);
    await text(OWNER, "EST Yossi");
    expect(notifier.sent.at(-1)).toMatch(/^Usage: EST <name> <phone>/);
    await text(OWNER, "hello?");
    expect(notifier.sent.at(-1)).toMatch(/^Didn't understand that\.\nCommands:/);
    expect((await services().followUpRepo.listSince("2000-01-01"))).toHaveLength(1);
  });

  it("can be started from the admin API", async () => {
    const app = createApp({ notifier, customerMessaging: sms, clock: clock.now });
    const response = await app.request(
      "/api/admin/follow-ups",
      {
        method: "POST",
        headers: { authorization: "Bearer test-admin-token", "content-type": "application/json" },
        body: JSON.stringify({ customer_name: "Maria Lopez", phone: "818-555-0123", estimate_id: "77" }),
      },
      env,
      createExecutionContext(),
    );
    expect(response.status).toBe(201);
    expect(((await response.json()) as any).followUp).toMatchObject({ status: "ACTIVE", estimateExternalId: "77" });
  });
});
