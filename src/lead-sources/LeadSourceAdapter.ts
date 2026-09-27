import type { LeadSource, NormalizedLeadInput } from "../domain/lead";

export class InvalidLeadPayloadError extends Error {}

/**
 * Converts one source's inbound payload into the normalized lead input.
 * Adapters only map and validate; all business logic lives in the
 * qualification services so every source shares it.
 */
export interface LeadSourceAdapter {
  readonly source: LeadSource;
  /** @throws InvalidLeadPayloadError when the payload can't be used. */
  parseNewLead(payload: unknown): NormalizedLeadInput;
}

/** Trim a possibly-missing string; blank becomes null. */
export function clean(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}
