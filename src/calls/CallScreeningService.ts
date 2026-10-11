import { callScreeningConfig, callScripts } from "../config/callScreening";
import type { Call, CallDecision, CallRepository } from "../db/callRepository";
import type { EventRepository } from "../db/eventRepository";
import type { FollowUpRepository } from "../db/followUpRepository";
import type { LeadRepository } from "../db/leadRepository";
import type { MessageRepository } from "../db/messageRepository";
import { pickFacts, type Lead, type ServiceType } from "../domain/lead";
import type { NotificationProvider } from "../notifications/NotificationProvider";
import type { LeadQualificationService } from "../qualification/LeadQualificationService";
import type { LeadScoringService } from "../qualification/LeadScoringService";
import { log } from "../util/log";
import { maskPhone, toE164 } from "../util/phone";
import { el, say, twiml } from "../util/twiml";

export interface IncomingCall {
  callSid: string;
  from: string;
  /** Twilio's STIR/SHAKEN result, e.g. "TN-Validation-Passed-A". */
  stirVerstat: string | null;
}

export interface CallScreeningDeps {
  calls: CallRepository;
  leads: LeadRepository;
  messages: MessageRepository;
  events: EventRepository;
  followUpRepo: FollowUpRepository;
  qualification: LeadQualificationService;
  scoring: LeadScoringService;
  notifier: NotificationProvider;
  ownerPhone: string;
  clock?: () => Date;
  config?: typeof callScreeningConfig;
  scripts?: typeof callScripts;
}

/** What happens to a screened call (pure function of the scored lead). */
export interface ScreeningDecision {
  decision: Extract<CallDecision, "RING" | "FILTERED" | "VOICEMAIL">;
  reason: string;
}

const SERVICE_SPOKEN: Record<ServiceType, string> = {
  ROOF_LEAK: "roof leak",
  ROOF_REPAIR: "roof repair",
  ROOF_REPLACEMENT: "roof replacement",
  ROOF_INSPECTION: "roof inspection",
  COMMERCIAL_ROOFING: "commercial roofing",
  EMERGENCY_ROOFING: "emergency roofing",
  OTHER: "roofing",
};

/**
 * Module 4: screens calls to the business number before Amiram's phone rings.
 *
 *   known customer / ALLOW ─────────────────────────────► ring Amiram
 *   BLOCK ──────────────────────────────────────────────► rejected
 *   unknown ─► "what roofing work do you need?" ─► extract + score
 *        spam / vendor ───────────────────────────────────► polite goodbye
 *        job seeker, unrelated, out of area, renter ──────► voicemail + text
 *        roofing request, unclear, AI unavailable ────────► ring Amiram
 *        silence (robocalls) ─────────────────────────────► voicemail prompt
 *
 * When Amiram's phone rings he hears a one-line whisper (score, job, city)
 * and presses 1 to take the call; otherwise the caller leaves a voicemail and
 * Amiram gets a text. Every method returns the TwiML for Twilio.
 */
export class CallScreeningService {
  private readonly clock: () => Date;
  private readonly config: typeof callScreeningConfig;
  private readonly scripts: typeof callScripts;

  constructor(
    private readonly deps: CallScreeningDeps,
    /** Absolute origin of this Worker, for the callback URLs in the TwiML. */
    private readonly baseUrl: string,
  ) {
    this.clock = deps.clock ?? (() => new Date());
    this.config = deps.config ?? callScreeningConfig;
    this.scripts = deps.scripts ?? callScripts;
  }

  private now(): string {
    return this.clock().toISOString();
  }

  /** Twilio "A call comes in" webhook. */
  async incoming(input: IncomingCall): Promise<string> {
    const fromE164 = toE164(input.from);
    const { call, created } = await this.deps.calls.create({
      callSid: input.callSid, fromE164, receivedAt: this.now(), stirVerstat: input.stirVerstat,
      decision: "SCREENING", reason: null, speech: null, leadId: null, acceptedAt: null,
      outcome: null, voicemailTranscript: null, completedAt: null,
    });
    if (!created) return this.resume(call);

    const rule = fromE164 ? await this.deps.calls.ruleFor(fromE164) : null;
    if (rule === "BLOCK") {
      await this.deps.calls.update(call.callSid, { decision: "BLOCKED", reason: "blocklist", outcome: "REJECTED" }, this.now());
      log("call.blocked", { callSid: call.callSid, from: maskPhone(fromE164) });
      return twiml(el("Reject", { reason: "busy" }));
    }

    const known = rule === "ALLOW" ? { lead: null, name: null } : await this.findKnownCaller(fromE164, input.stirVerstat);
    if (rule === "ALLOW" || known) {
      await this.deps.calls.update(
        call.callSid,
        { decision: "KNOWN_CALLER", reason: rule === "ALLOW" ? "allowlist" : "known_customer", leadId: known?.lead?.id ?? null },
        this.now(),
      );
      log("call.known_caller", { callSid: call.callSid });
      return twiml(say(this.scripts.connecting, this.scripts.voice), this.dial(call.callSid, input.from));
    }

    log("call.screening", { callSid: call.callSid, verstat: input.stirVerstat });
    return this.askScreeningQuestion();
  }

  /** The caller answered (or didn't) the screening question. */
  async screened(callSid: string, speech: string): Promise<string> {
    const call = await this.deps.calls.find(callSid);
    if (!call) return this.unknownCall(callSid);
    const text = speech.trim();
    if (!text) return this.noResponse(call);

    await this.deps.calls.update(callSid, { speech: text }, this.now());
    // The AI runs on the next request, so the caller hears this meanwhile.
    return twiml(say(this.scripts.thanksConnecting, this.scripts.voice), el("Redirect", {}, this.url("route")));
  }

  /** Extract + score what the caller said, then ring, filter, or take a message. */
  async route(callSid: string): Promise<string> {
    const call = await this.deps.calls.find(callSid);
    if (!call?.speech) return call ? this.noResponse(call) : this.unknownCall(callSid);

    const { lead } = await this.deps.qualification.ingestCall(
      {
        source: "PHONE",
        externalLeadId: call.callSid,
        sourceCreatedAt: call.receivedAt,
        originalMessage: call.speech,
        knownFacts: call.fromE164 ? { phone: call.fromE164 } : {},
        rawPayload: { callSid: call.callSid, stirVerstat: call.stirVerstat },
      },
      this.config.aiBudgetMs,
    );
    const outcome = this.decide(lead);
    const now = this.now();
    await this.deps.calls.update(callSid, { decision: outcome.decision, reason: outcome.reason, leadId: lead.id }, now);
    await this.deps.events.record(lead.id, "CALL_SCREENED", now, { decision: outcome.decision, reason: outcome.reason });
    log("call.screened", { callSid, leadId: lead.id, decision: outcome.decision, reason: outcome.reason, score: lead.leadScore });

    switch (outcome.decision) {
      case "RING":
        return twiml(this.dial(callSid, call.fromE164 ?? undefined));
      case "VOICEMAIL":
        return this.recordVoicemail(this.scripts.voicemail);
      case "FILTERED":
        await this.filter(call, lead);
        return twiml(say(this.scripts.filtered, this.scripts.voice), el("Hangup"));
    }
  }

  /**
   * Deterministic routing of a scored call. A possible customer is never
   * filtered: unclear intent and AI outages ring through.
   */
  decide(lead: Lead): ScreeningDecision {
    if (lead.extractionMethod === "FALLBACK") return { decision: "RING", reason: "ai_unavailable" };
    const intent = lead.intent ?? "UNCLEAR";
    if (this.config.filteredIntents.includes(intent)) return { decision: "FILTERED", reason: `intent:${intent}` };
    if (this.config.voicemailIntents.includes(intent)) return { decision: "VOICEMAIL", reason: `intent:${intent}` };
    const { disqualifiedBy } = this.deps.scoring.score(pickFacts(lead));
    const rule = disqualifiedBy.find((id) => this.config.voicemailDisqualifiers.includes(id));
    if (rule) return { decision: "VOICEMAIL", reason: `rule:${rule}` };
    return { decision: "RING", reason: `intent:${intent}` };
  }

  /** TwiML for Amiram's leg when he picks up: who is calling, press 1. */
  async whisper(callSid: string): Promise<string> {
    const call = await this.deps.calls.find(callSid);
    const lead = call?.leadId ? await this.deps.leads.findById(call.leadId) : null;
    const intro = call ? this.whisperText(call, lead) : "Family Roofing call.";
    return twiml(
      el(
        "Gather",
        { numDigits: 1, timeout: this.config.acceptTimeoutSeconds, action: this.url("accept", callSid) },
        say(`${intro} ${this.scripts.whisperAccept}`, this.scripts.voice),
      ),
      el("Hangup"),
    );
  }

  /** Amiram pressed a key on the whisper. Only 1 connects the call. */
  async accept(callSid: string, digits: string): Promise<string> {
    if (digits !== "1") return twiml(el("Hangup"));
    const call = await this.deps.calls.find(callSid);
    if (call && !call.acceptedAt) {
      const now = this.now();
      await this.deps.calls.update(callSid, { acceptedAt: now, outcome: "ANSWERED" }, now);
      if (call.leadId) {
        await this.deps.events.record(call.leadId, "CALL_ACCEPTED", now);
        const lead = await this.deps.leads.findById(call.leadId);
        // He's talking to them: no summary text needed for this call.
        if (lead && lead.ownerNotificationStatus !== "SENT" && call.decision !== "KNOWN_CALLER") {
          await this.deps.leads.update(lead.id, { ownerNotificationStatus: "SKIPPED" }, now);
        }
      }
    }
    return twiml(); // empty response bridges the call
  }

  /** The <Dial> to Amiram ended. Not accepted means missed: take a voicemail. */
  async dialEnded(callSid: string, dialStatus: string): Promise<string> {
    const call = await this.deps.calls.find(callSid);
    if (!call) return this.unknownCall(callSid);
    if (call.acceptedAt) return twiml(el("Hangup"));

    const now = this.now();
    await this.deps.calls.update(callSid, { outcome: "MISSED" }, now);
    log("call.missed", { callSid, dialStatus });
    if (call.leadId) await this.deps.events.record(call.leadId, "CALL_MISSED", now, { dialStatus });
    await this.notifyMissed(call);
    return this.recordVoicemail(this.scripts.missed);
  }

  /** <Record> finished (the caller may already have hung up). */
  async recorded(callSid: string, durationSeconds: number): Promise<string> {
    if (durationSeconds > 0) await this.deps.calls.update(callSid, { outcome: "VOICEMAIL" }, this.now());
    return twiml(say(this.scripts.voicemailThanks, this.scripts.voice), el("Hangup"));
  }

  /** Twilio's transcription of a voicemail arrived (often after the call ended). */
  async voicemailTranscribed(callSid: string, text: string): Promise<void> {
    const call = await this.deps.calls.find(callSid);
    const transcript = text.trim();
    if (!call || !transcript || call.voicemailTranscript) return;
    const now = this.now();
    await this.deps.calls.update(callSid, { voicemailTranscript: transcript }, now);

    const lead = call.leadId ? await this.deps.leads.findById(call.leadId) : null;
    if (lead && call.decision !== "KNOWN_CALLER") {
      await this.deps.events.record(lead.id, "VOICEMAIL_RECEIVED", now);
      const result = await this.deps.qualification.handleCustomerReply(lead, transcript, "VOICE");
      await result.background;
      return;
    }
    if (call.decision === "KNOWN_CALLER") {
      if (lead) await this.deps.events.record(lead.id, "VOICEMAIL_RECEIVED", now);
      await this.textOwner(`🎙 Voicemail from ${this.callerLabel(call, lead)}:\n"${transcript.slice(0, 500)}"`, lead?.id ?? null);
      return;
    }

    // Nobody answered the screening question (typical of robocalls) but they
    // left a message: screen the message itself.
    const { lead: created } = await this.deps.qualification.ingestCall(
      {
        source: "PHONE", externalLeadId: call.callSid, sourceCreatedAt: call.receivedAt, originalMessage: transcript,
        knownFacts: call.fromE164 ? { phone: call.fromE164 } : {}, rawPayload: { callSid: call.callSid, voicemail: true },
      },
      this.config.aiBudgetMs,
    );
    const outcome = this.decide(created);
    await this.deps.calls.update(callSid, { leadId: created.id, reason: `voicemail:${outcome.reason}` }, this.now());
    await this.deps.events.record(created.id, "VOICEMAIL_RECEIVED", this.now(), { decision: outcome.decision });
    if (outcome.decision === "FILTERED") {
      await this.filter({ ...call, leadId: created.id }, created);
      return;
    }
    await this.deps.qualification.notifyOwner(created, "🎙 Voicemail from a new caller");
  }

  /** Twilio call status callback: the whole call is over. */
  async completed(callSid: string): Promise<void> {
    const call = await this.deps.calls.find(callSid);
    if (!call || call.completedAt) return;
    const now = this.now();
    await this.deps.calls.update(callSid, { completedAt: now, outcome: call.outcome ?? "HUNG_UP" }, now);

    // A caller sent to voicemail (or who hung up mid-screening after
    // describing a job) still gets to Amiram, even without a message.
    if (call.leadId && call.decision !== "KNOWN_CALLER" && !call.acceptedAt) {
      const lead = await this.deps.leads.findById(call.leadId);
      if (lead && (lead.ownerNotificationStatus === "NOT_SENT" || lead.ownerNotificationStatus === "FAILED")) {
        const headline = call.decision === "VOICEMAIL"
          ? `🎙 Call sent to voicemail (${this.describeReason(call.reason)})`
          : "📞 Caller hung up before being connected";
        await this.deps.qualification.notifyOwner(lead, headline);
      }
    }
  }

  // --- internals ------------------------------------------------------------

  private askScreeningQuestion(): string {
    return twiml(
      el(
        "Gather",
        {
          input: "speech",
          action: this.url("screen"),
          timeout: this.config.gatherTimeoutSeconds,
          speechTimeout: "auto",
          language: "en-US",
          hints: this.config.speechHints,
          actionOnEmptyResult: true,
        },
        say(this.scripts.greeting, this.scripts.voice),
      ),
      el("Redirect", {}, this.url("screen")),
    );
  }

  private async noResponse(call: Call): Promise<string> {
    await this.deps.calls.update(call.callSid, { decision: "NO_RESPONSE", reason: "no_speech" }, this.now());
    log("call.no_response", { callSid: call.callSid });
    return this.recordVoicemail(this.scripts.noResponse);
  }

  /** A retried "incoming" webhook: continue where the call is. */
  private resume(call: Call): string {
    if (call.decision === "BLOCKED") return twiml(el("Reject", { reason: "busy" }));
    if (call.decision === "KNOWN_CALLER" || call.decision === "RING") {
      return twiml(this.dial(call.callSid, call.fromE164 ?? undefined));
    }
    return this.askScreeningQuestion();
  }

  private unknownCall(callSid: string): string {
    log("call.unknown_sid", { callSid });
    return this.recordVoicemail(this.scripts.noResponse);
  }

  private dial(callSid: string, callerId: string | undefined): string {
    return el(
      "Dial",
      {
        // Show the customer's number on Amiram's phone, so he can call back.
        callerId: toE164(callerId) ?? undefined,
        timeout: this.config.ringTimeoutSeconds,
        answerOnBridge: true,
        action: this.url("dial-ended"),
      },
      el("Number", { url: this.url("whisper", callSid) }, this.deps.ownerPhone),
    );
  }

  private recordVoicemail(prompt: string): string {
    return twiml(
      say(prompt, this.scripts.voice),
      el("Record", {
        maxLength: this.config.voicemailMaxSeconds,
        playBeep: true,
        timeout: 5,
        action: this.url("recorded"),
        transcribe: true,
        transcribeCallback: this.url("transcription"),
      }),
      el("Hangup"),
    );
  }

  private async filter(call: Call, lead: Lead): Promise<void> {
    const now = this.now();
    await this.deps.leads.update(lead.id, { ownerNotificationStatus: "SKIPPED", status: "CLOSED" }, now);
    await this.deps.calls.update(call.callSid, { decision: "FILTERED", outcome: "ENDED" }, now);
    await this.deps.events.record(lead.id, "CALL_FILTERED", now, { intent: lead.intent });

    const threshold = this.config.autoBlockAfterSpamCalls;
    if (threshold > 0 && call.fromE164 && lead.intent === "SPAM" && lead.extractionMethod === "AI") {
      const spamCalls = await this.deps.calls.countFiltered(call.fromE164, "intent:SPAM");
      if (spamCalls >= threshold && (await this.deps.calls.ruleFor(call.fromE164)) === null) {
        await this.deps.calls.setRule(call.fromE164, "BLOCK", "AUTO", now, `${spamCalls} spam calls`);
        log("call.auto_blocked", { from: maskPhone(call.fromE164), spamCalls });
      }
    }
  }

  /** Customers we already work with, unless the number looks spoofed. */
  private async findKnownCaller(
    fromE164: string | null,
    stirVerstat: string | null,
  ): Promise<{ lead: Lead | null; name: string | null } | null> {
    if (!fromE164 || !this.config.trustKnownCustomers) return null;
    if (this.config.screenFailedVerification && /Failed/i.test(stirVerstat ?? "")) return null;

    const lead = await this.deps.leads.findLatestByPhone(fromE164);
    if (lead && lead.intent && !this.config.filteredIntents.includes(lead.intent) && lead.intent !== "UNCLEAR") {
      return { lead, name: lead.name };
    }
    const [followUp] = await this.deps.followUpRepo.findOpenByPhone(fromE164);
    if (followUp) return { lead: null, name: followUp.customerName };
    return null;
  }

  private whisperText(call: Call, lead: Lead | null): string {
    if (call.decision === "KNOWN_CALLER") {
      return lead?.name ? `Family Roofing call from ${lead.name}, an existing customer.` : "Family Roofing call from an existing customer.";
    }
    if (!lead) return "Family Roofing call.";
    const parts: string[] = [];
    parts.push(lead.extractionMethod === "FALLBACK" ? "New caller, not screened." : `${lead.leadScore ?? "New"} lead.`);
    if (lead.serviceType) parts.push(`${SERVICE_SPOKEN[lead.serviceType]}.`);
    if (lead.activeLeak) parts.push("Active leak.");
    const place = lead.city ?? (lead.zip ? `zip ${lead.zip.split("").join(" ")}` : null);
    if (place) parts.push(`In ${place}.`);
    return `Family Roofing call. ${parts.join(" ")}`;
  }

  private async notifyMissed(call: Call): Promise<void> {
    const lead = call.leadId ? await this.deps.leads.findById(call.leadId) : null;
    if (lead && call.decision !== "KNOWN_CALLER") {
      await this.deps.qualification.notifyOwner(lead, "📞 Missed call: they're leaving a voicemail");
      return;
    }
    await this.textOwner(`📞 Missed call from ${this.callerLabel(call, lead)}. They're leaving a voicemail.`, lead?.id ?? null);
  }

  private callerLabel(call: Call, lead: Lead | null): string {
    const number = call.fromE164 ?? "a withheld number";
    return lead?.name ? `${lead.name} (${number})` : number;
  }

  private describeReason(reason: string | null): string {
    const labels: Record<string, string> = {
      "rule:out_of_area": "outside service area",
      "rule:renter": "renter",
      "intent:JOB_SEEKER": "job inquiry",
      "intent:UNRELATED": "not a roofing request",
    };
    return (reason && labels[reason]) ?? reason ?? "screened";
  }

  private async textOwner(text: string, leadId: string | null): Promise<void> {
    const result = await this.deps.notifier.notifyOwner(text);
    if (!leadId) return;
    await this.deps.messages.add({
      leadId, createdAt: this.now(), direction: "OUTBOUND", channel: this.deps.notifier.channel, recipient: "OWNER",
      body: text, deliveryStatus: result.ok ? "SENT" : "FAILED", providerMessageId: result.providerMessageId, error: result.error,
    });
  }

  private url(path: string, callSid?: string): string {
    const url = `${this.baseUrl}/api/voice/${path}`;
    return callSid ? `${url}?call=${encodeURIComponent(callSid)}` : url;
  }
}
