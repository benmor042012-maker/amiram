import { messagingConfig } from "../config/messaging";
import type { EventRepository } from "../db/eventRepository";
import type { LeadRepository } from "../db/leadRepository";
import type { OptOutRepository } from "../db/optOutRepository";
import type { LeadQualificationService } from "../qualification/LeadQualificationService";
import { log } from "../util/log";
import { maskPhone, toE164 } from "../util/phone";

export type InboundSmsOutcome =
  | { kind: "OPTED_OUT" }
  | { kind: "OPTED_IN" }
  | { kind: "REPLY_HANDLED"; leadId: string; background: Promise<void> }
  | { kind: "UNMATCHED" };

/** Handles texts customers send to the business number. */
export class SmsInboundService {
  constructor(
    private readonly deps: {
      leads: LeadRepository;
      events: EventRepository;
      optOuts: OptOutRepository;
      qualification: LeadQualificationService;
      clock?: () => Date;
      config?: typeof messagingConfig;
    },
  ) {}

  async handle(from: string, body: string): Promise<InboundSmsOutcome> {
    const config = this.deps.config ?? messagingConfig;
    const now = (this.deps.clock ?? (() => new Date()))().toISOString();
    const phone = toE164(from);
    if (!phone) return { kind: "UNMATCHED" };

    const keyword = body.trim().toUpperCase().replace(/[.!]+$/, "");
    const lead = await this.deps.leads.findLatestByPhone(phone, "WEBSITE");

    if (config.optOutKeywords.includes(keyword)) {
      await this.deps.optOuts.optOut(phone, keyword, now);
      if (lead) {
        await this.deps.events.record(lead.id, "OPTED_OUT", now, { keyword });
        await this.deps.leads.update(lead.id, { conversationStatus: "CLOSED" }, now);
      }
      log("sms.opted_out", { phone: maskPhone(phone), leadId: lead?.id });
      return { kind: "OPTED_OUT" };
    }
    if (config.optInKeywords.includes(keyword)) {
      await this.deps.optOuts.optIn(phone);
      if (lead) await this.deps.events.record(lead.id, "OPTED_IN", now, { keyword });
      return { kind: "OPTED_IN" };
    }

    if (!lead) {
      log("sms.unmatched", { phone: maskPhone(phone) });
      return { kind: "UNMATCHED" };
    }
    const result = await this.deps.qualification.handleCustomerReply(lead, body);
    return { kind: "REPLY_HANDLED", leadId: lead.id, background: result.background };
  }
}
