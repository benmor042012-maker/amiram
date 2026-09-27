import type { NotificationProvider, NotificationResult } from "./NotificationProvider";

export interface TwilioConfig {
  accountSid: string;
  authToken: string;
  fromNumber: string;
}

/**
 * Sends an SMS through Twilio's REST API (Messages resource). Uses fetch
 * directly because Twilio's Node SDK doesn't run on Cloudflare Workers.
 */
export async function sendTwilioSms(
  config: TwilioConfig,
  to: string,
  body: string,
  fetcher: typeof fetch = fetch,
): Promise<NotificationResult> {
  const url = `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(config.accountSid)}/Messages.json`;
  try {
    const response = await fetcher(url, {
      method: "POST",
      headers: {
        Authorization: `Basic ${btoa(`${config.accountSid}:${config.authToken}`)}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ To: to, From: config.fromNumber, Body: body }),
    });
    const data = (await response.json().catch(() => ({}))) as { sid?: string; message?: string; code?: number };
    if (!response.ok) {
      // Twilio's error message/code only; never the request (it holds credentials).
      return {
        ok: false,
        providerMessageId: null,
        error: `Twilio ${response.status} ${data.code ?? ""} ${data.message ?? ""}`.trim(),
        errorCode: data.code ?? null,
      };
    }
    return { ok: true, providerMessageId: data.sid ?? null, error: null };
  } catch (error) {
    return { ok: false, providerMessageId: null, error: error instanceof Error ? error.message : String(error) };
  }
}

export class TwilioSmsNotificationProvider implements NotificationProvider {
  readonly channel = "SMS" as const;

  constructor(
    private readonly config: TwilioConfig,
    private readonly ownerPhone: string,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  notifyOwner(text: string): Promise<NotificationResult> {
    return sendTwilioSms(this.config, this.ownerPhone, text, this.fetcher);
  }
}
