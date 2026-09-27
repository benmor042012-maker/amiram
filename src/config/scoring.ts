import type { LeadFacts, ServiceAreaStatus } from "../domain/lead";

/** Input to every scoring rule: the lead's facts plus derived context. */
export interface ScoringContext extends LeadFacts {
  serviceArea: ServiceAreaStatus;
}

export interface ScoringSignal {
  id: string;
  points: number;
  reason: string;
  when: (lead: ScoringContext) => boolean;
}

export interface Disqualifier {
  id: string;
  reason: string;
  when: (lead: ScoringContext) => boolean;
}

/**
 * Deterministic lead-scoring rules. The AI only extracts facts; these rules
 * alone decide HOT / WARM / LOW. Adjust points and thresholds here.
 *
 * A disqualifier forces LOW. Otherwise points are summed:
 *   total >= thresholds.hot  -> HOT
 *   total >= thresholds.warm -> WARM
 *   else                     -> LOW
 */
export const scoringConfig: {
  thresholds: { hot: number; warm: number };
  disqualifiers: Disqualifier[];
  signals: ScoringSignal[];
} = {
  thresholds: { hot: 6, warm: 2 },

  disqualifiers: [
    { id: "job_seeker", reason: "Employment inquiry", when: (l) => l.intent === "JOB_SEEKER" },
    { id: "vendor", reason: "Vendor / sales solicitation", when: (l) => l.intent === "VENDOR_SOLICITATION" },
    { id: "spam", reason: "Spam", when: (l) => l.intent === "SPAM" },
    { id: "unrelated", reason: "Not a roofing request", when: (l) => l.intent === "UNRELATED" },
    { id: "out_of_area", reason: "Outside service area", when: (l) => l.serviceArea === "OUT_OF_AREA" },
    {
      id: "renter",
      reason: "Renter without owner involvement",
      when: (l) => l.homeOwner === false && l.serviceType !== "COMMERCIAL_ROOFING",
    },
  ],

  signals: [
    { id: "active_leak", points: 5, reason: "Active water leak", when: (l) => l.activeLeak === true },
    { id: "emergency", points: 5, reason: "Emergency / urgent request", when: (l) => l.emergency === true || l.serviceType === "EMERGENCY_ROOFING" },
    { id: "leak", points: 3, reason: "Roof leak", when: (l) => l.serviceType === "ROOF_LEAK" },
    { id: "replacement", points: 4, reason: "Roof replacement", when: (l) => l.serviceType === "ROOF_REPLACEMENT" },
    { id: "commercial", points: 4, reason: "Commercial roofing project", when: (l) => l.serviceType === "COMMERCIAL_ROOFING" },
    { id: "repair", points: 2, reason: "Roof repair", when: (l) => l.serviceType === "ROOF_REPAIR" },
    { id: "inspection_service", points: 1, reason: "Roof inspection", when: (l) => l.serviceType === "ROOF_INSPECTION" },
    { id: "inspection_requested", points: 2, reason: "Customer requested an inspection", when: (l) => l.inspectionRequested === true },
    { id: "homeowner", points: 2, reason: "Homeowner", when: (l) => l.homeOwner === true },
    { id: "short_timeframe", points: 2, reason: "Short timeframe", when: (l) => l.desiredTimeframe === "ASAP" || l.desiredTimeframe === "WITHIN_WEEK" },
    { id: "long_timeframe", points: -3, reason: "Planned for later (3+ months)", when: (l) => l.desiredTimeframe === "LATER" },
    { id: "in_area", points: 1, reason: "In service area", when: (l) => l.serviceArea === "IN_AREA" },
  ],
};
