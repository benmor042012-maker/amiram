import type { ConversationService } from "../ai/ConversationService";
import type { LeadExtractor } from "../ai/LeadExtractionService";
import type { LeadSummaryService } from "../ai/LeadSummaryService";
import { conversationConfig } from "../config/conversation";
import type { EventRepository } from "../db/eventRepository";
import type { LeadRepository } from "../db/leadRepository";
import type { MessageChannel, MessageRepository } from "../db/messageRepository";
import {
  emptyFacts,
  mergeFacts,
  pickFacts,
  type Lead,
  type LeadScore,
  type LeadSource,
  type LeadStatus,
  type NormalizedLeadInput,
} from "../domain/lead";
import type { NotificationProvider } from "../notifications/NotificationProvider";
import { log } from "../util/log";
import type { LeadScoringService } from "./LeadScoringService";

export interface QualificationDeps {
  leads: LeadRepository;
  messages: MessageRepository;
  events: EventRepository;
  extractor: LeadExtractor;
  scoring: LeadScoringService;
  conversation: ConversationService;
  summary: LeadSummaryService;
  notifier: NotificationProvider;
  clock?: () => Date;
  config?: typeof conversationConfig;
}

export interface HandleResult {
  lead: Lead;
  /** Text to send to the customer now, or null to send nothing. */
  reply: string | null;
  duplicate: boolean;
  /**
   * Work that should finish after the HTTP response is returned (owner
   * notification), so it never delays the customer's reply. Pass it to
   * ExecutionContext.waitUntil().
   */
  background: Promise<void>;
}

export class LeadNotFoundError extends Error {}

const SCORE_RANK: Record<LeadScore, number> = { LOW: 0, WARM: 1, HOT: 2 };
/** Statuses the automation may advance; anything later is Amiram's call. */
const AUTOMATED_STATUSES = new Set<LeadStatus>(["NEW", "CONTACTING", "QUALIFYING", "QUALIFIED"]);

/**
 * The lead pipeline shared by every source:
 * ingest -> extract -> score -> reply -> notify Amiram.
 */
export class LeadQualificationService {
  private readonly clock: () => Date;
  private readonly config: typeof conversationConfig;

  constructor(private readonly deps: QualificationDeps) {
    this.clock = deps.clock ?? (() => new Date());
    this.config = deps.config ?? conversationConfig;
  }

  private now(): string {
    return this.clock().toISOString();
  }

  async handleNewLead(input: NormalizedLeadInput, channel: MessageChannel): Promise<HandleResult> {
    const { leads, messages, events } = this.deps;

    if (input.externalLeadId) {
      const existing = await leads.findByExternalId(input.source, input.externalLeadId);
      if (existing) {
        await events.record(existing.id, "DUPLICATE_RECEIVED", this.now());
        const firstReply = (await messages.listForLead(existing.id)).find(
          (m) => m.direction === "OUTBOUND" && m.recipient === "CUSTOMER",
        );
        return { lead: existing, reply: firstReply?.body ?? null, duplicate: true, background: Promise.resolve() };
      }
    }

    const receivedAt = this.now();
    const lead = await leads.create(input, mergeFacts(emptyFacts(), input.knownFacts), receivedAt);
    await events.record(lead.id, "LEAD_RECEIVED", receivedAt, { source: lead.source });
    await messages.add({
      leadId: lead.id, createdAt: receivedAt, direction: "INBOUND", channel, recipient: "CUSTOMER",
      body: input.originalMessage, deliveryStatus: "RECEIVED", providerMessageId: null, error: null,
    });

    const analyzed = await this.analyze(lead, [input.originalMessage], input.knownFacts);
    const reply = this.deps.conversation.buildFirstReply(analyzed);

    const respondedAt = this.now();
    const updated: Lead = {
      ...analyzed,
      conversationStatus: reply && this.deps.conversation.expectsAnswer(analyzed) ? "AWAITING_CUSTOMER" : "CLOSED",
      status: this.automatedStatus(analyzed),
    };
    if (reply) {
      updated.firstAutomatedResponseAt = respondedAt;
      updated.responseTimeSeconds = secondsBetween(receivedAt, respondedAt);
      await this.recordCustomerReply(updated, reply, channel, respondedAt);
      await events.record(lead.id, "AUTO_RESPONSE_SENT", respondedAt, {
        responseTimeSeconds: updated.responseTimeSeconds,
        // Includes the source's own delay (e.g. Yelp -> Zapier) when known.
        sourceToResponseSeconds: input.sourceCreatedAt ? secondsBetween(input.sourceCreatedAt, respondedAt) : null,
      });
    }
    await this.save(updated);
    log("lead.received", {
      leadId: lead.id, source: lead.source, score: updated.leadScore,
      qualification: updated.qualificationStatus, responseTimeSeconds: updated.responseTimeSeconds,
    });

    return { lead: updated, reply, duplicate: false, background: this.maybeNotifyOwner(updated) };
  }

  /** A customer answered in the conversation (e.g. a new Yelp message). */
  async handleCustomerReply(
    source: LeadSource,
    externalLeadId: string,
    text: string,
    channel: MessageChannel,
  ): Promise<HandleResult> {
    const { leads, messages, events } = this.deps;
    const lead = await leads.findByExternalId(source, externalLeadId);
    if (!lead) throw new LeadNotFoundError(`No ${source} lead ${externalLeadId}`);

    const now = this.now();
    const wasClosed = lead.conversationStatus === "CLOSED";
    await messages.add({
      leadId: lead.id, createdAt: now, direction: "INBOUND", channel, recipient: "CUSTOMER",
      body: text, deliveryStatus: "RECEIVED", providerMessageId: null, error: null,
    });
    await events.record(lead.id, "CUSTOMER_REPLIED", now, { turn: lead.customerTurns + 1 });

    const customerMessages = (await messages.listForLead(lead.id))
      .filter((m) => m.direction === "INBOUND")
      .map((m) => m.body);
    const analyzed = await this.analyze(
      { ...lead, customerTurns: lead.customerTurns + 1, conversationStatus: "CUSTOMER_REPLIED" },
      customerMessages,
      pickFacts(lead),
      { preferNew: true },
    );

    if (wasClosed) {
      // The short automated exchange is over: hand the message to Amiram.
      const updated = { ...analyzed, conversationStatus: "CLOSED" as const };
      await this.save(updated);
      const escalated = this.escalatedSinceNotification(updated);
      const background = escalated || updated.ownerNotificationStatus !== "SENT"
        ? this.notifyOwner(updated)
        : this.forwardToOwner(updated, text);
      return { lead: updated, reply: null, duplicate: false, background };
    }

    const reply = this.deps.conversation.buildFollowUpReply(analyzed);
    const updated: Lead = {
      ...analyzed,
      conversationStatus: reply && this.deps.conversation.expectsAnswer(analyzed) ? "AWAITING_CUSTOMER" : "CLOSED",
      status: this.automatedStatus(analyzed),
    };
    if (reply) await this.recordCustomerReply(updated, reply, channel, this.now());
    await this.save(updated);

    let background: Promise<void>;
    if (updated.ownerNotificationStatus !== "SENT") background = this.maybeNotifyOwner(updated);
    else if (this.escalatedSinceNotification(updated)) background = this.notifyOwner(updated);
    else background = this.forwardToOwner(updated, text);
    return { lead: updated, reply, duplicate: false, background };
  }

  /**
   * Cron: notify Amiram about leads whose qualification stalled (customer
   * stopped replying) and retry failed notifications for up to a day.
   */
  async processTimeouts(): Promise<number> {
    const now = this.clock().getTime();
    const cutoff = new Date(now - this.config.ownerNotifyTimeoutMinutes * 60_000).toISOString();
    const oldest = new Date(now - 24 * 3600_000).toISOString();
    const due = (await this.deps.leads.findAwaitingOwnerNotification(cutoff)).filter(
      (l) => l.receivedAt >= oldest,
    );
    for (const lead of due) await this.notifyOwner(lead);
    return due.length;
  }

  async setStatus(leadId: string, status: LeadStatus): Promise<Lead> {
    const lead = await this.deps.leads.findById(leadId);
    if (!lead) throw new LeadNotFoundError(`No lead ${leadId}`);
    const now = this.now();
    await this.deps.leads.update(leadId, { status }, now);
    await this.deps.events.record(leadId, "STATUS_CHANGED", now, { from: lead.status, to: status });
    return { ...lead, status };
  }

  /** Extract facts from the customer's messages, then score deterministically. */
  private async analyze(
    lead: Lead,
    customerMessages: string[],
    knownFacts: Partial<Lead>,
    options: { preferNew?: boolean } = {},
  ): Promise<Lead> {
    const extraction = await this.deps.extractor.extract({ customerMessages, knownFacts });
    await this.deps.events.record(lead.id, "EXTRACTED", this.now(), {
      method: extraction.method,
      fieldsFound: Object.entries(extraction.facts).filter(([, v]) => v !== null && v !== undefined).map(([k]) => k),
    });

    // On the first message, structured form fields beat the AI's reading.
    // On later messages, what the customer just said is the newest truth,
    // but an unknown value never erases a known one.
    const facts = options.preferNew
      ? mergeFacts(pickFacts(lead), extraction.facts)
      : mergeFacts(mergeFacts(pickFacts(lead), extraction.facts), knownFacts);

    const score = this.deps.scoring.score(facts);
    if (extraction.method === "FALLBACK") score.leadReasons.push("AI extraction unavailable");
    await this.deps.events.record(lead.id, "SCORED", this.now(), {
      score: score.leadScore, points: score.points, reasons: score.leadReasons,
    });

    const analyzed: Lead = {
      ...lead,
      ...facts,
      leadScore: score.leadScore,
      leadReasons: score.leadReasons,
      serviceArea: score.serviceArea,
      aiSummary: extraction.summary ?? lead.aiSummary,
      extractionMethod: extraction.method,
    };
    analyzed.qualificationStatus = this.deps.conversation.qualificationStatus(analyzed);
    if (analyzed.qualificationStatus === "COMPLETE" && lead.qualificationStatus !== "COMPLETE") {
      await this.deps.events.record(lead.id, "QUALIFIED", this.now(), { score: score.leadScore });
    }
    return analyzed;
  }

  private automatedStatus(lead: Lead): LeadStatus {
    if (!AUTOMATED_STATUSES.has(lead.status)) return lead.status;
    if (lead.qualificationStatus === "NOT_A_LEAD") return "CLOSED";
    return lead.qualificationStatus === "COMPLETE" ? "QUALIFIED" : "QUALIFYING";
  }

  private async recordCustomerReply(lead: Lead, body: string, channel: MessageChannel, at: string): Promise<void> {
    // For Yelp the reply is returned to Zapier, which posts it into the Yelp
    // thread, so it is recorded as handed off rather than sent.
    await this.deps.messages.add({
      leadId: lead.id, createdAt: at, direction: "OUTBOUND", channel, recipient: "CUSTOMER",
      body, deliveryStatus: channel === "YELP" ? "HANDED_OFF" : "SENT", providerMessageId: null, error: null,
    });
  }

  /** Notify now if the lead is urgent or we already know enough; else the cron will. */
  private maybeNotifyOwner(lead: Lead): Promise<void> {
    if (this.shouldSkipNotification(lead)) return this.markSkipped(lead);
    const ready =
      lead.leadScore === "HOT" ||
      // Without the AI we can't judge urgency, so a person should look now.
      lead.extractionMethod === "FALLBACK" ||
      lead.qualificationStatus !== "PARTIAL" ||
      lead.conversationStatus === "CLOSED";
    return ready ? this.notifyOwner(lead) : Promise.resolve();
  }

  private shouldSkipNotification(lead: Lead): boolean {
    if (lead.intent && this.config.silentIntents.includes(lead.intent)) return true;
    return lead.leadScore === "LOW" && !this.config.notifyLowLeads;
  }

  private async markSkipped(lead: Lead): Promise<void> {
    await this.deps.leads.update(lead.id, { ownerNotificationStatus: "SKIPPED" }, this.now());
  }

  private escalatedSinceNotification(lead: Lead): boolean {
    if (!lead.notifiedScore || !lead.leadScore) return false;
    return SCORE_RANK[lead.leadScore] > SCORE_RANK[lead.notifiedScore];
  }

  private async notifyOwner(lead: Lead): Promise<void> {
    if (this.shouldSkipNotification(lead)) return this.markSkipped(lead);
    const text = this.deps.summary.ownerNotification(lead);
    const ok = await this.sendToOwner(lead, text);
    const now = this.now();
    await this.deps.leads.update(
      lead.id,
      ok
        ? {
            ownerNotificationStatus: "SENT",
            ownerNotifiedAt: now,
            notifiedScore: lead.leadScore,
            ...(AUTOMATED_STATUSES.has(lead.status) && lead.status !== "CLOSED" ? { status: "OWNER_NOTIFIED" as const } : {}),
          }
        : { ownerNotificationStatus: lead.ownerNotificationStatus === "SENT" ? "SENT" : "FAILED" },
      now,
    );
  }

  private async forwardToOwner(lead: Lead, message: string): Promise<void> {
    await this.sendToOwner(lead, this.deps.summary.customerMessageForward(lead, message));
  }

  private async sendToOwner(lead: Lead, text: string): Promise<boolean> {
    const result = await this.deps.notifier.notifyOwner(text);
    const now = this.now();
    await this.deps.messages.add({
      leadId: lead.id, createdAt: now, direction: "OUTBOUND", channel: this.deps.notifier.channel,
      recipient: "OWNER", body: text, deliveryStatus: result.ok ? "SENT" : "FAILED",
      providerMessageId: result.providerMessageId, error: result.error,
    });
    await this.deps.events.record(lead.id, result.ok ? "OWNER_NOTIFIED" : "OWNER_NOTIFICATION_FAILED", now, {
      score: lead.leadScore, error: result.error,
    });
    log(result.ok ? "owner.notified" : "owner.notification_failed", { leadId: lead.id, score: lead.leadScore });
    return result.ok;
  }

  private async save(lead: Lead): Promise<void> {
    const { id, createdAt, receivedAt, source, externalLeadId, originalMessage, ...changes } = lead;
    await this.deps.leads.update(id, changes, this.now());
  }
}

function secondsBetween(fromIso: string, toIso: string): number {
  return Math.max(0, (Date.parse(toIso) - Date.parse(fromIso)) / 1000);
}
