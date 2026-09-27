export type LeadEventType =
  | "LEAD_RECEIVED"
  | "DUPLICATE_RECEIVED"
  | "EXTRACTED"
  | "EXTRACTION_FAILED"
  | "SCORED"
  | "AUTO_RESPONSE_SENT"
  | "CUSTOMER_REPLIED"
  | "QUALIFIED"
  | "OWNER_NOTIFIED"
  | "OWNER_NOTIFICATION_FAILED"
  | "STATUS_CHANGED";

export interface LeadEvent {
  id: string;
  leadId: string;
  createdAt: string;
  type: LeadEventType;
  data: Record<string, unknown> | null;
}

export class EventRepository {
  constructor(private readonly db: D1Database) {}

  /** `data` must never contain secrets; keep customer PII out of it too. */
  async record(
    leadId: string,
    type: LeadEventType,
    now: string,
    data: Record<string, unknown> | null = null,
  ): Promise<void> {
    await this.db
      .prepare("INSERT INTO lead_events (id, lead_id, created_at, type, data) VALUES (?, ?, ?, ?, ?)")
      .bind(crypto.randomUUID(), leadId, now, type, data ? JSON.stringify(data) : null)
      .run();
  }

  async listForLead(leadId: string): Promise<LeadEvent[]> {
    const { results } = await this.db
      .prepare("SELECT * FROM lead_events WHERE lead_id = ? ORDER BY created_at, rowid")
      .bind(leadId)
      .all<Record<string, unknown>>();
    return results.map((r) => ({
      id: r.id as string,
      leadId: r.lead_id as string,
      createdAt: r.created_at as string,
      type: r.type as LeadEventType,
      data: r.data ? JSON.parse(r.data as string) : null,
    }));
  }
}
