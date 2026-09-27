/**
 * Normalize a US phone number to E.164 (+1XXXXXXXXXX). Returns null for
 * anything that isn't a complete US number (including Yelp's masked numbers).
 */
export function toE164(phone: string | null | undefined): string | null {
  if (!phone) return null;
  const trimmed = phone.trim();
  const digits = trimmed.replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return null;
}

/** For logs: keep only the last two digits. */
export function maskPhone(e164: string | null): string {
  return e164 ? `***${e164.slice(-2)}` : "none";
}
