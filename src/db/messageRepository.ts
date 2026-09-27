export type MessageDirection = "INBOUND" | "OUTBOUND";
export type MessageChannel = "YELP" | "SMS" | "EMAIL" | "WEBSITE";
export type MessageRecipient = "CUSTOMER" | "OWNER";
/** HANDED_OFF = returned to an integration (e.g. Zapier) that performs the send. */
export type DeliveryStatus = "RECEIVED" | "SENT" | "HANDED_OFF" | "FAILED";

export interface LeadMessage {
  id: string;
  leadId: string;
  createdAt: string;
  direction: MessageDirection;
  channel: MessageChannel;
  recipient: MessageRecipient;
  body: string;
  deliveryStatus: DeliveryStatus;
  providerMessageId: string | null;
  error: string | null;
}

export class MessageRepository {
  constructor(private readonly db: D1Database) {}

  async add(message: Omit<LeadMessage, "id">): Promise<LeadMessage> {
    const saved = { ...message, id: crypto.randomUUID() };
    await this.db
      .prepare(
        `INSERT INTO messages (id, lead_id, created_at, direction, channel, recipient, body,
           delivery_status, provider_message_id, error)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        saved.id,
        saved.leadId,
        saved.createdAt,
        saved.direction,
        saved.channel,
        saved.recipient,
        saved.body,
        saved.deliveryStatus,
        saved.providerMessageId,
        saved.error,
      )
      .run();
    return saved;
  }

  async listForLead(leadId: string): Promise<LeadMessage[]> {
    const { results } = await this.db
      .prepare("SELECT * FROM messages WHERE lead_id = ? ORDER BY created_at, rowid")
      .bind(leadId)
      .all<Record<string, unknown>>();
    return results.map((r) => ({
      id: r.id as string,
      leadId: r.lead_id as string,
      createdAt: r.created_at as string,
      direction: r.direction as MessageDirection,
      channel: r.channel as MessageChannel,
      recipient: r.recipient as MessageRecipient,
      body: r.body as string,
      deliveryStatus: r.delivery_status as DeliveryStatus,
      providerMessageId: (r.provider_message_id as string | null) ?? null,
      error: (r.error as string | null) ?? null,
    }));
  }
}
