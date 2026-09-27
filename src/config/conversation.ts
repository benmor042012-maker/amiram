import type { Lead, LeadIntent, LeadSource } from "../domain/lead";

/**
 * Qualification questions, in priority order. A question is only asked when
 * `missing` returns true, so nothing the customer already told us is asked
 * again. `essential` fields must be known for qualification to be COMPLETE.
 */
export interface QualificationQuestion {
  id: string;
  ask: string;
  essential: boolean;
  /** Restrict to sources where this can be missing (e.g. Yelp hides phones). */
  sources?: LeadSource[];
  missing: (lead: Lead) => boolean;
}

const LEAK_LIKE = new Set(["ROOF_LEAK", "ROOF_REPAIR", "EMERGENCY_ROOFING"]);

export const qualificationQuestions: QualificationQuestion[] = [
  {
    id: "service",
    ask: "what kind of roofing help you need (repair, leak, replacement, inspection)",
    essential: true,
    missing: (l) => l.serviceType === null,
  },
  {
    id: "location",
    ask: "the property address (or at least the ZIP code)",
    essential: true,
    missing: (l) => !l.address && !l.zip,
  },
  {
    id: "phone",
    ask: "the best phone number for Amiram to call you",
    essential: true,
    missing: (l) => !l.phone || isMaskedPhone(l.phone),
  },
  {
    id: "active_leak",
    ask: "whether water is actively coming in right now",
    essential: false,
    missing: (l) => l.activeLeak === null && l.serviceType !== null && LEAK_LIKE.has(l.serviceType),
  },
  {
    id: "home_owner",
    ask: "whether you own the property",
    essential: true,
    missing: (l) => l.homeOwner === null && l.serviceType !== "COMMERCIAL_ROOFING",
  },
  {
    id: "contact_time",
    ask: "a good time for a callback or an inspection",
    essential: false,
    missing: (l) => !l.preferredContactTime,
  },
];

/** Yelp relays calls through masked numbers; those can't be used for a callback. */
function isMaskedPhone(phone: string): boolean {
  return /x{2,}|\*{2,}/i.test(phone);
}

export const conversationConfig = {
  /** Keep the exchange short: at most this many questions per message... */
  maxQuestionsPerMessage: 3,
  /** ...and stop asking after this many customer replies. */
  maxCustomerTurns: 2,
  /**
   * If qualification isn't finished this long after the lead arrived,
   * notify Amiram with what we have (checked by the cron trigger).
   */
  ownerNotifyTimeoutMinutes: 10,
  /** Notify Amiram about LOW leads too (they're marked as low priority). */
  notifyLowLeads: true,
  /** Never notify for these (no reply is sent either). */
  silentIntents: ["SPAM"] as LeadIntent[],
};

/**
 * Customer-facing text. {firstName} is replaced with the customer's first
 * name, or the whole greeting falls back to `greetingNoName`.
 * Keep these free of prices, diagnoses, or promises.
 */
export const customerMessages = {
  greeting: "Hi {firstName}, thanks for reaching out to Family Roofing!",
  greetingNoName: "Hi, thanks for reaching out to Family Roofing!",
  urgentLeakAck: "Sorry to hear about the leak. Amiram, the owner, will reach out as soon as possible.",
  urgentAck: "Sorry to hear about the roof trouble. Amiram, the owner, will reach out as soon as possible.",
  standardAck: "Amiram, the owner, will personally follow up with you.",
  askIntro: "To help him prepare, could you share:",
  followUpThanks: "Thank you, that helps.",
  allSet: "We have what we need, and Amiram will contact you shortly.",
  /** Reply for non-lead intents. null = send nothing. */
  nonLeadReplies: {
    JOB_SEEKER: "Thanks for your interest in Family Roofing! We'll pass your message along to Amiram.",
    VENDOR_SOLICITATION: null,
    SPAM: null,
    UNRELATED: "Thanks for your message! We'll pass it along to Amiram.",
  } as Partial<Record<LeadIntent, string | null>>,
};
