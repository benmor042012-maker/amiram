export const SERVICE_TYPES = [
  "ROOF_LEAK",
  "ROOF_REPAIR",
  "ROOF_REPLACEMENT",
  "ROOF_INSPECTION",
  "COMMERCIAL_ROOFING",
  "EMERGENCY_ROOFING",
  "OTHER",
] as const;
export type ServiceType = (typeof SERVICE_TYPES)[number];

export const TIMEFRAMES = [
  "ASAP",
  "WITHIN_WEEK",
  "WITHIN_MONTH",
  "WITHIN_3_MONTHS",
  "LATER",
  "FLEXIBLE",
] as const;
export type Timeframe = (typeof TIMEFRAMES)[number];

/** What the sender is actually asking for. Only ROOFING_REQUEST is a real lead. */
export const LEAD_INTENTS = [
  "ROOFING_REQUEST",
  "JOB_SEEKER",
  "VENDOR_SOLICITATION",
  "SPAM",
  "UNRELATED",
  "UNCLEAR",
] as const;
export type LeadIntent = (typeof LEAD_INTENTS)[number];

export type LeadSource = "YELP" | "WEBSITE";
export type LeadScore = "HOT" | "WARM" | "LOW";
export type ServiceAreaStatus = "IN_AREA" | "OUT_OF_AREA" | "UNKNOWN";

export type LeadStatus =
  | "NEW"
  | "CONTACTING"
  | "QUALIFYING"
  | "QUALIFIED"
  | "OWNER_NOTIFIED"
  | "CALLBACK_REQUESTED"
  | "INSPECTION_SCHEDULED"
  | "WON"
  | "LOST"
  | "CLOSED";

/** Statuses Amiram sets by hand (the rest are driven by the automation). */
export const MANUAL_LEAD_STATUSES = [
  "CALLBACK_REQUESTED",
  "INSPECTION_SCHEDULED",
  "WON",
  "LOST",
  "CLOSED",
] as const satisfies readonly LeadStatus[];

export type QualificationStatus = "PENDING" | "PARTIAL" | "COMPLETE" | "NOT_A_LEAD";
export type ConversationStatus =
  | "NOT_STARTED"
  | "AWAITING_CUSTOMER"
  | "CUSTOMER_REPLIED"
  | "CLOSED";
export type OwnerNotificationStatus = "NOT_SENT" | "SENT" | "FAILED" | "SKIPPED";
export type ExtractionMethod = "AI" | "FALLBACK";

/**
 * Structured facts about a lead. Every field is nullable: null means UNKNOWN,
 * and the system must never guess a value to fill it.
 */
export interface LeadFacts {
  name: string | null;
  phone: string | null;
  email: string | null;
  address: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  serviceType: ServiceType | null;
  problemDescription: string | null;
  activeLeak: boolean | null;
  emergency: boolean | null;
  homeOwner: boolean | null;
  inspectionRequested: boolean | null;
  roofType: string | null;
  roofAge: string | null;
  desiredTimeframe: Timeframe | null;
  preferredContactTime: string | null;
  intent: LeadIntent | null;
}

export interface Lead extends LeadFacts {
  id: string;
  source: LeadSource;
  externalLeadId: string | null;
  createdAt: string;
  updatedAt: string;
  receivedAt: string;
  sourceCreatedAt: string | null;
  originalMessage: string;

  leadScore: LeadScore | null;
  leadReasons: string[];
  serviceArea: ServiceAreaStatus | null;

  qualificationStatus: QualificationStatus;
  conversationStatus: ConversationStatus;
  ownerNotificationStatus: OwnerNotificationStatus;
  status: LeadStatus;

  aiSummary: string | null;
  extractionMethod: ExtractionMethod | null;
  customerTurns: number;

  firstAutomatedResponseAt: string | null;
  responseTimeSeconds: number | null;
  ownerNotifiedAt: string | null;
  notifiedScore: LeadScore | null;
}

/**
 * What a LeadSourceAdapter produces from an inbound payload: identity, the
 * customer's own words, and any fields the source already gave us in
 * structured form (e.g. a ZIP from a form field).
 */
export interface NormalizedLeadInput {
  source: LeadSource;
  externalLeadId: string | null;
  sourceCreatedAt: string | null;
  originalMessage: string;
  knownFacts: Partial<LeadFacts>;
  rawPayload: unknown;
}

export function emptyFacts(): LeadFacts {
  return {
    name: null,
    phone: null,
    email: null,
    address: null,
    city: null,
    state: null,
    zip: null,
    serviceType: null,
    problemDescription: null,
    activeLeak: null,
    emergency: null,
    homeOwner: null,
    inspectionRequested: null,
    roofType: null,
    roofAge: null,
    desiredTimeframe: null,
    preferredContactTime: null,
    intent: null,
  };
}

/**
 * Combine facts: values from `overlay` win where they are known (non-null);
 * unknown values never erase something already known.
 */
export function mergeFacts(base: LeadFacts, overlay: Partial<LeadFacts>): LeadFacts {
  const merged: LeadFacts = { ...base };
  for (const key of Object.keys(merged) as (keyof LeadFacts)[]) {
    const value = overlay[key];
    if (value !== null && value !== undefined && value !== "") {
      (merged as unknown as Record<string, unknown>)[key] = value;
    }
  }
  return merged;
}

export function pickFacts(lead: Lead): LeadFacts {
  const facts = emptyFacts();
  for (const key of Object.keys(facts) as (keyof LeadFacts)[]) {
    (facts as unknown as Record<string, unknown>)[key] = lead[key];
  }
  return facts;
}
