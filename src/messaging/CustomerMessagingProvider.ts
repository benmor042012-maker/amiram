import type { OptOutRepository } from "../db/optOutRepository";
import { sendTwilioSms, type TwilioConfig } from "../notifications/TwilioSmsNotificationProvider";

export interface SendResult {
  status: "SENT" | "FAILED" | "BLOCKED_OPT_OUT";
  providerMessageId: string | null;
  error: string | null;
}

/** Sends automated SMS to customers. */
export interface CustomerMessagingProvider {
  sendSms(toE164: string, body: string): Promise<SendResult>;
}

export class TwilioCustomerMessaging implements CustomerMessagingProvider {
  constructor(
    private readonly config: TwilioConfig,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  async sendSms(toE164: string, body: string): Promise<SendResult> {
    const result = await sendTwilioSms(this.config, toE164, body, this.fetcher);
    return { status: result.ok ? "SENT" : "FAILED", providerMessageId: result.providerMessageId, error: result.error };
  }
}

/** Local development / tests: records instead of sending. */
export class ConsoleCustomerMessaging implements CustomerMessagingProvider {
  readonly sent: { to: string; body: string }[] = [];

  async sendSms(to: string, body: string): Promise<SendResult> {
    this.sent.push({ to, body });
    console.log(`[customer-sms] (console provider, ${body.length} chars)`);
    return { status: "SENT", providerMessageId: null, error: null };
  }
}

/**
 * Wraps any provider so a number on the opt-out list is never texted,
 * whichever part of the system (qualification, follow-up) sends.
 */
export class OptOutGuardedMessaging implements CustomerMessagingProvider {
  constructor(
    private readonly inner: CustomerMessagingProvider,
    private readonly optOuts: OptOutRepository,
  ) {}

  async sendSms(toE164: string, body: string): Promise<SendResult> {
    if (await this.optOuts.isOptedOut(toE164)) {
      return { status: "BLOCKED_OPT_OUT", providerMessageId: null, error: null };
    }
    return this.inner.sendSms(toE164, body);
  }
}
