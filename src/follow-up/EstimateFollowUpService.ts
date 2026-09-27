import { followUpConfig, type FollowUpConfig } from "../config/followUp";
import type { EventRepository } from "../db/eventRepository";
import type { FollowUp, FollowUpRepository } from "../db/followUpRepository";
import type { LeadRepository } from "../db/leadRepository";
import type { CustomerMessagingProvider } from "../messaging/CustomerMessagingProvider";
import type { NotificationProvider } from "../notifications/NotificationProvider";
import { log } from "../util/log";
import { toE164 } from "../util/phone";

export class InvalidFollowUpError extends Error {}

export interface StartFollowUpInput {
  customerName: string;
  phone: string;
  estimateExternalId?: string | null;
}

/** Twilio errors meaning the number can never receive our texts. */
const INVALID_NUMBER_ERRORS = new Set([21211, 21214, 21217, 21401, 21407, 21408, 21421, 21612, 21614]);
/** Twilio: the recipient already replied STOP to this sender. */
const UNSUBSCRIBED_ERROR = 21610;
const HOUR = 3600_000;
const DAY = 24 * HOUR;

/**
 * Estimate follow-up (Module 3). Joist has no API, so a sequence is started
 * by an external event (Amiram's SMS command or the admin API today; a
 * forwarded Joist email later) and stops on any of the stop conditions:
 * customer reply, opt-out, estimate accepted, owner cancel, invalid number,
 * or the last step being sent.
 */
export class EstimateFollowUpService {
  private readonly clock: () => Date;
  private readonly config: FollowUpConfig;

  constructor(
    private readonly deps: {
      followUps: FollowUpRepository;
      leads: LeadRepository;
      events: EventRepository;
      messaging: CustomerMessagingProvider;
      notifier: NotificationProvider;
      clock?: () => Date;
      config?: FollowUpConfig;
    },
  ) {
    this.clock = deps.clock ?? (() => new Date());
    this.config = deps.config ?? followUpConfig;
  }

  async start(input: StartFollowUpInput): Promise<{ followUp: FollowUp; created: boolean }> {
    const name = input.customerName.trim();
    const phoneE164 = toE164(input.phone);
    if (!name) throw new InvalidFollowUpError("Customer name is required");
    if (!phoneE164) throw new InvalidFollowUpError("A valid US phone number is required");

    const [existing] = await this.deps.followUps.findOpenByPhone(phoneE164);
    if (existing) return { followUp: existing, created: false };

    const now = this.clock();
    const lead = await this.deps.leads.findLatestByPhone(phoneE164);
    const followUp = await this.deps.followUps.create({
      leadId: lead?.id ?? null,
      estimateExternalId: input.estimateExternalId?.trim() || null,
      customerName: name,
      phoneE164,
      createdAt: now.toISOString(),
      sequenceStartedAt: now.toISOString(),
      nextActionAt: this.stepTime(now, 0, now),
      lastMessageAt: null,
      followUpStep: 0,
      status: "ACTIVE",
      stopReason: null,
    });
    log("follow_up.started", { followUpId: followUp.id, leadId: followUp.leadId });
    return { followUp, created: true };
  }

  /** Cron: send every follow-up message that is due. Returns messages sent. */
  async processDue(): Promise<number> {
    const now = this.clock();
    const nowIso = now.toISOString();
    let sent = 0;
    for (const followUp of await this.deps.followUps.findDue(nowIso)) {
      if (!this.inSendWindow(now)) {
        await this.deps.followUps.reschedule(followUp.id, this.nextSendTime(now), nowIso);
        continue;
      }
      if (await this.sendStep(followUp, now)) sent++;
    }
    return sent;
  }

  private async sendStep(followUp: FollowUp, now: Date): Promise<boolean> {
    const { followUps } = this.deps;
    const nowIso = now.toISOString();
    const step = followUp.followUpStep;
    const definition = this.config.steps[step];
    if (!definition) {
      await followUps.stop(followUp.id, "COMPLETED", "SEQUENCE_FINISHED", nowIso);
      return false;
    }

    const isLast = step === this.config.steps.length - 1;
    const next = isLast ? null : this.stepTime(new Date(followUp.sequenceStartedAt), step + 1, now);
    if (!(await followUps.claimStep(followUp.id, step, next, nowIso))) return false;

    const firstName = followUp.customerName.split(/\s+/)[0] ?? followUp.customerName;
    const text = definition.template.replaceAll("{firstName}", firstName);
    const body = step === 0 ? `${text}\n\n${this.config.firstMessageNotice}` : text;
    const result = await this.deps.messaging.sendSms(followUp.phoneE164, body);
    await followUps.addMessage({
      followUpId: followUp.id, createdAt: nowIso, direction: "OUTBOUND", step, body,
      deliveryStatus: result.status, providerMessageId: result.providerMessageId, error: result.error,
    });

    if (result.status === "BLOCKED_OPT_OUT" || result.errorCode === UNSUBSCRIBED_ERROR) {
      await followUps.stop(followUp.id, "OPTED_OUT", "OPTED_OUT", nowIso);
      return false;
    }
    if (result.status === "FAILED") {
      if (result.errorCode && INVALID_NUMBER_ERRORS.has(result.errorCode)) {
        await followUps.stop(followUp.id, "CANCELLED", "INVALID_PHONE", nowIso);
        await this.tellOwner(`⚠️ Estimate follow-up for ${followUp.customerName} stopped: the phone number can't receive texts.`);
      } else {
        // Probably transient: give the step back and retry in an hour.
        await followUps.releaseStep(followUp.id, step, this.nextSendTime(new Date(now.getTime() + HOUR)), nowIso);
      }
      return false;
    }
    if (isLast) await followUps.stop(followUp.id, "COMPLETED", "SEQUENCE_FINISHED", nowIso);
    log("follow_up.sent", { followUpId: followUp.id, step });
    return true;
  }

  /** The customer texted back: stop and hand the conversation to Amiram. */
  async handleCustomerReply(followUp: FollowUp, text: string): Promise<void> {
    const now = this.clock().toISOString();
    await this.deps.followUps.addMessage({
      followUpId: followUp.id, createdAt: now, direction: "INBOUND", step: null, body: text,
      deliveryStatus: "RECEIVED", providerMessageId: null, error: null,
    });
    await this.deps.followUps.stop(followUp.id, "RESPONDED", "CUSTOMER_REPLIED", now);
    const excerpt = text.length > 500 ? `${text.slice(0, 499)}…` : text;
    await this.tellOwner(
      `💬 ${followUp.customerName} replied about their estimate${followUp.estimateExternalId ? ` #${followUp.estimateExternalId}` : ""}:\n\n"${excerpt}"\n\nAutomatic follow-up stopped.`,
    );
  }

  async handleOptOut(phoneE164: string): Promise<void> {
    const now = this.clock().toISOString();
    for (const followUp of await this.deps.followUps.findOpenByPhone(phoneE164)) {
      await this.deps.followUps.stop(followUp.id, "OPTED_OUT", "OPTED_OUT", now);
    }
  }

  /** Estimate accepted / job won. Also marks the matching lead WON. */
  async markAccepted(followUp: FollowUp): Promise<void> {
    const now = this.clock().toISOString();
    await this.deps.followUps.markAccepted(followUp.id, now);
    if (followUp.leadId) {
      const lead = await this.deps.leads.findById(followUp.leadId);
      if (lead && lead.status !== "WON") {
        await this.deps.leads.update(lead.id, { status: "WON" }, now);
        await this.deps.events.record(lead.id, "STATUS_CHANGED", now, { from: lead.status, to: "WON", via: "follow_up" });
      }
    }
  }

  async cancel(followUp: FollowUp): Promise<boolean> {
    return this.deps.followUps.stop(followUp.id, "CANCELLED", "OWNER_CANCELLED", this.clock().toISOString());
  }

  get stepCount(): number {
    return this.config.steps.length;
  }

  get dayOffsets(): number[] {
    return this.config.steps.map((s) => s.dayOffset);
  }

  async listActive(): Promise<FollowUp[]> {
    return (await this.recent()).filter((f) => f.status === "ACTIVE" || f.status === "PAUSED");
  }

  private async recent(): Promise<FollowUp[]> {
    const since = new Date(this.clock().getTime() - this.config.commandLookbackDays * DAY).toISOString();
    return this.deps.followUps.listSince(since);
  }

  /** Finds follow-ups by phone number or (part of) the customer's name. */
  async find(query: string): Promise<FollowUp[]> {
    const recent = await this.recent();
    const phone = toE164(query);
    if (phone) return recent.filter((f) => f.phoneE164 === phone);
    const needle = query.trim().toLowerCase();
    if (!needle) return [];
    const exact = recent.filter((f) => f.customerName.toLowerCase() === needle);
    return exact.length > 0 ? exact : recent.filter((f) => f.customerName.toLowerCase().includes(needle));
  }

  /** When step `step` is due: its day offset from the start, moved into the send window, never before `notBefore`. */
  private stepTime(start: Date, step: number, notBefore: Date): string | null {
    const definition = this.config.steps[step];
    if (!definition) return null;
    const target = Math.max(start.getTime() + definition.dayOffset * DAY, notBefore.getTime());
    return this.nextSendTime(new Date(target));
  }

  /** `from` if it's inside the send window, else the start of the next window. */
  private nextSendTime(from: Date): string {
    let t = from.getTime();
    for (let i = 0; i < 96 && !this.inSendWindow(new Date(t)); i++) t += 15 * 60_000;
    return new Date(t).toISOString();
  }

  private inSendWindow(at: Date): boolean {
    const { timeZone, startHour, endHour } = this.config.sendWindow;
    const hour = Number(new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", hourCycle: "h23" }).format(at));
    return hour >= startHour && hour < endHour;
  }

  private async tellOwner(text: string): Promise<void> {
    await this.deps.notifier.notifyOwner(text);
  }
}
