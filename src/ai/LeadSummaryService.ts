import type { Lead, LeadScore, ServiceType, Timeframe } from "../domain/lead";

const SCORE_HEADER: Record<LeadScore, string> = {
  HOT: "🔥 HOT LEAD",
  WARM: "WARM LEAD",
  LOW: "LOW-PRIORITY LEAD",
};

const RECOMMENDED_ACTION: Record<LeadScore, string> = {
  HOT: "Call immediately.",
  WARM: "Call back today.",
  LOW: "Review when convenient.",
};

const SERVICE_LABEL: Record<ServiceType, string> = {
  ROOF_LEAK: "Roof Leak",
  ROOF_REPAIR: "Roof Repair",
  ROOF_REPLACEMENT: "Roof Replacement",
  ROOF_INSPECTION: "Roof Inspection",
  COMMERCIAL_ROOFING: "Commercial Roofing",
  EMERGENCY_ROOFING: "Emergency Roofing",
  OTHER: "Other",
};

const TIMEFRAME_LABEL: Record<Timeframe, string> = {
  ASAP: "ASAP",
  WITHIN_WEEK: "Within a week",
  WITHIN_MONTH: "Within a month",
  WITHIN_3_MONTHS: "Within 3 months",
  LATER: "3+ months",
  FLEXIBLE: "Flexible",
};

const SOURCE_LABEL = { YELP: "Yelp", WEBSITE: "Website" } as const;

/**
 * Builds the text Amiram receives. The AI summary comes from the extraction
 * step; everything else is the structured data and the deterministic score.
 */
export class LeadSummaryService {
  ownerNotification(lead: Lead): string {
    const score = lead.leadScore ?? "LOW";
    const location = [lead.address, lead.city, lead.zip].filter(Boolean).join(", ");
    const lines = [
      SCORE_HEADER[score],
      "",
      `Source: ${SOURCE_LABEL[lead.source]}`,
      `Name: ${lead.name ?? "Unknown"}`,
      `Phone: ${lead.phone ?? (lead.source === "YELP" ? "Not given (reply in Yelp)" : "Unknown")}`,
      `Location: ${location || "Unknown"}`,
      `Service: ${lead.serviceType ? SERVICE_LABEL[lead.serviceType] : "Unknown"}`,
      "",
      `Active leak: ${yesNo(lead.activeLeak)}`,
      `Homeowner: ${yesNo(lead.homeOwner)}`,
      `Timing: ${lead.desiredTimeframe ? TIMEFRAME_LABEL[lead.desiredTimeframe] : "Unknown"}`,
    ];
    if (lead.preferredContactTime) lines.push(`Best time: ${lead.preferredContactTime}`);
    lines.push("", "Customer message:", `"${truncate(lead.originalMessage, 300)}"`);
    if (lead.aiSummary) lines.push("", "AI summary:", lead.aiSummary);
    lines.push("", `Why ${score}: ${lead.leadReasons.join("; ") || "n/a"}`);
    if (lead.extractionMethod === "FALLBACK") {
      lines.push("(AI was unavailable, details may be incomplete; please read the message.)");
    }
    lines.push("", "Recommended action:", RECOMMENDED_ACTION[score]);
    return lines.join("\n");
  }

  /** Customer wrote again after the automated exchange ended. */
  customerMessageForward(lead: Lead, message: string): string {
    return [
      `💬 New message from ${lead.name ?? "a customer"} (${SOURCE_LABEL[lead.source]}, ${lead.leadScore ?? "unscored"})`,
      "",
      `"${truncate(message, 500)}"`,
    ].join("\n");
  }
}

function yesNo(value: boolean | null): string {
  return value === null ? "Unknown" : value ? "YES" : "NO";
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
