export interface NotificationResult {
  ok: boolean;
  providerMessageId: string | null;
  error: string | null;
  /** Provider error code, when the provider gives one (e.g. Twilio 21211). */
  errorCode?: number | null;
}

/** Delivers internal notifications to the business owner (Amiram). */
export interface NotificationProvider {
  readonly channel: "SMS" | "EMAIL";
  notifyOwner(text: string): Promise<NotificationResult>;
}

/** Local development: logs instead of sending. */
export class ConsoleNotificationProvider implements NotificationProvider {
  readonly channel = "SMS" as const;
  readonly sent: string[] = [];

  async notifyOwner(text: string): Promise<NotificationResult> {
    this.sent.push(text);
    console.log(`[owner-notification] (console provider, ${text.length} chars)`);
    return { ok: true, providerMessageId: null, error: null };
  }
}
