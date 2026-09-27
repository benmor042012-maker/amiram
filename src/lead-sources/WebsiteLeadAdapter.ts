import { websiteFieldAliases, type WebsiteField } from "../config/websiteForm";
import type { NormalizedLeadInput } from "../domain/lead";
import { clean, InvalidLeadPayloadError, type LeadSourceAdapter } from "./LeadSourceAdapter";

/** Fields that are never stored with the lead's raw payload. */
const STRIPPED_FIELDS = new Set(["webhook secret", "secret", "g recaptcha response", "wpcf7 recaptcha response"]);

/**
 * Normalizes a website form submission, posted by the form plugin's webhook
 * (JSON or form-encoded, flattened to key/value pairs).
 */
export class WebsiteLeadAdapter implements LeadSourceAdapter {
  readonly source = "WEBSITE" as const;

  constructor(private readonly aliases = websiteFieldAliases) {}

  parseNewLead(payload: unknown): NormalizedLeadInput {
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      throw new InvalidLeadPayloadError("Website lead payload must be an object of form fields");
    }
    const fields = normalizeKeys(payload as Record<string, unknown>);
    const get = (field: WebsiteField) => {
      for (const alias of this.aliases[field]) {
        const value = fields.get(alias);
        if (value !== undefined) return clean(value);
      }
      return null;
    };

    const name = get("name") ?? (clean([get("firstName"), get("lastName")].filter(Boolean).join(" ")));
    const phone = get("phone");
    const email = get("email");
    const service = get("service");
    const message = get("message");

    if (!phone && !email) throw new InvalidLeadPayloadError("Website lead needs a phone number or email");
    if (!service && !message) throw new InvalidLeadPayloadError("Website lead has no message or service");

    const parts = [service && `Service requested: ${service}`, message].filter((p): p is string => Boolean(p));
    const entryId = get("entryId");

    return {
      source: this.source,
      // Without a plugin entry id, see withContentHashId().
      externalLeadId: entryId ? `entry:${entryId}` : null,
      sourceCreatedAt: parseDate(get("submittedAt")),
      originalMessage: parts.join("\n"),
      knownFacts: { name, phone, email, address: get("address"), city: get("city"), zip: get("zip") },
      smsConsent: parseConsent(fields, this.aliases.smsConsent),
      rawPayload: Object.fromEntries(
        Object.entries(payload as Record<string, unknown>).filter(([k]) => !STRIPPED_FIELDS.has(normalizeKey(k))),
      ),
    };
  }
}

/**
 * Adds a content-hash id when the form didn't send an entry id, so a webhook
 * retry (or a double-clicked submit) doesn't create a second lead.
 */
export async function withContentHashId(input: NormalizedLeadInput): Promise<NormalizedLeadInput> {
  if (input.externalLeadId) return input;
  const basis = [input.knownFacts.phone, input.knownFacts.email, input.originalMessage].join("|").toLowerCase();
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(basis));
  const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return { ...input, externalLeadId: `hash:${hex.slice(0, 32)}` };
}

function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[-_\s.[\]]+/g, " ").trim();
}

function normalizeKeys(payload: Record<string, unknown>): Map<string, string> {
  const fields = new Map<string, string>();
  for (const [key, value] of Object.entries(payload)) {
    const text = Array.isArray(value) ? value.map(String).join(", ") : value == null ? "" : String(value);
    fields.set(normalizeKey(key), text);
  }
  return fields;
}

/**
 * true only for an affirmative checkbox value; false if the consent field is
 * present but unticked; null if the form has no consent field at all.
 */
function parseConsent(fields: Map<string, string>, aliases: readonly string[]): boolean | null {
  for (const alias of aliases) {
    const value = fields.get(alias);
    if (value === undefined) continue;
    const v = value.trim().toLowerCase();
    if (v === "" || ["0", "false", "no", "off", "unchecked"].includes(v)) return false;
    return true; // "1", "on", "yes", "true", or the checkbox label text
  }
  return null;
}

function parseDate(value: string | null): string | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}
