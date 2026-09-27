import { z } from "zod";
import type { NormalizedLeadInput } from "../domain/lead";
import { clean, InvalidLeadPayloadError, type LeadSourceAdapter } from "./LeadSourceAdapter";

/**
 * Body posted by the "Webhooks by Zapier" step of the Yelp Leads Zap
 * (trigger: Yelp Leads "New Lead"). We define this shape ourselves and map
 * Yelp's fields onto it in the Zap editor, so we don't depend on
 * undocumented Yelp field names. See docs/yelp-zapier-setup.md.
 */
export const YelpZapierLeadSchema = z.object({
  yelp_lead_id: z.string().min(1),
  message: z.string().optional(),
  customer_name: z.string().optional(),
  /** Yelp may only provide a masked number; stored as given. */
  phone: z.string().optional(),
  email: z.string().optional(),
  zip: z.string().optional(),
  city: z.string().optional(),
  /** Service / job name(s) the customer picked in Yelp's request form. */
  job_type: z.string().optional(),
  /** Request-a-Quote survey answers, flattened to text by Zapier. */
  survey_answers: z.string().optional(),
  created_at: z.string().optional(),
});
export type YelpZapierLead = z.infer<typeof YelpZapierLeadSchema>;

export const YelpZapierReplySchema = z.object({
  yelp_lead_id: z.string().min(1),
  message: z.string().min(1),
});

export class YelpLeadAdapter implements LeadSourceAdapter {
  readonly source = "YELP" as const;

  parseNewLead(payload: unknown): NormalizedLeadInput {
    const parsed = YelpZapierLeadSchema.safeParse(payload);
    if (!parsed.success) {
      throw new InvalidLeadPayloadError(
        `Invalid Yelp lead payload: ${parsed.error.issues.map((i) => i.path.join(".") || i.message).join(", ")}`,
      );
    }
    const lead = parsed.data;

    // The customer's own words: their message plus anything they chose in the
    // Yelp request form. The extraction step reads all of it.
    const parts = [
      clean(lead.job_type) && `Service requested: ${clean(lead.job_type)}`,
      clean(lead.survey_answers) && `Request details: ${clean(lead.survey_answers)}`,
      clean(lead.message),
    ].filter((p): p is string => Boolean(p));
    if (parts.length === 0) {
      throw new InvalidLeadPayloadError("Yelp lead has no message or request details");
    }

    return {
      source: this.source,
      externalLeadId: lead.yelp_lead_id.trim(),
      sourceCreatedAt: parseDate(lead.created_at),
      originalMessage: parts.join("\n"),
      knownFacts: {
        name: clean(lead.customer_name),
        phone: clean(lead.phone),
        email: clean(lead.email),
        zip: clean(lead.zip),
        city: clean(lead.city),
      },
      rawPayload: payload,
    };
  }
}

function parseDate(value: string | undefined): string | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}
