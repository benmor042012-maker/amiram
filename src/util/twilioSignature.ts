/**
 * Validates Twilio's X-Twilio-Signature header: base64 HMAC-SHA1 (keyed with
 * the account auth token) of the full request URL followed by every POST
 * parameter's name and value, sorted by name.
 * https://www.twilio.com/docs/usage/webhooks/webhooks-security
 */
export async function isValidTwilioSignature(
  authToken: string,
  url: string,
  params: Record<string, string>,
  signature: string | undefined,
): Promise<boolean> {
  if (!signature) return false;
  const expected = await twilioSignature(authToken, url, params);
  const a = new TextEncoder().encode(expected);
  const b = new TextEncoder().encode(signature);
  return a.byteLength === b.byteLength && crypto.subtle.timingSafeEqual(a, b);
}

export async function twilioSignature(authToken: string, url: string, params: Record<string, string>): Promise<string> {
  const data = url + Object.keys(params).sort().map((k) => k + params[k]).join("");
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(authToken),
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
  return btoa(String.fromCharCode(...new Uint8Array(mac)));
}
