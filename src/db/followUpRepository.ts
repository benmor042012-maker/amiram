export type FollowUpStatus =
  | "ACTIVE"
  | "PAUSED"
  | "RESPONDED"
  | "OPTED_OUT"
  | "ACCEPTED"
  | "COMPLETED"
  | "CANCELLED";

export type FollowUpStopReason =
  | "CUSTOMER_REPLIED"
  | "OPTED_OUT"
  | "ESTIMATE_ACCEPTED"
  | "OWNER_CANCELLED"
  | "INVALID_PHONE"
  | "SEQUENCE_FINISHED";

export interface FollowUp {
  id: string;
  leadId: string | null;
  estimateExternalId: string | null;
  customerName: string;
  phoneE164: string;
  createdAt: string;
  updatedAt: string;
  sequenceStartedAt: string;
  nextActionAt: string | null;
  lastMessageAt: string | null;
  followUpStep: number;
  status: FollowUpStatus;
  stopReason: FollowUpStopReason | null;
}

export interface FollowUpMessage {
  id: string;
  followUpId: string;
  createdAt: string;
  direction: "INBOUND" | "OUTBOUND";
  step: number | null;
  body: string;
  deliveryStatus: "RECEIVED" | "SENT" | "FAILED" | "BLOCKED_OPT_OUT";
  providerMessageId: string | null;
  error: string | null;
}

type Row = Record<string, unknown>;

function fromRow(r: Row): FollowUp {
  return {
    id: r.id as string,
    leadId: (r.lead_id as string | null) ?? null,
    estimateExternalId: (r.estimate_external_id as string | null) ?? null,
    customerName: r.customer_name as string,
    phoneE164: r.phone_e164 as string,
    createdAt: r.created_at as string,
    updatedAt: r.updated_at as string,
    sequenceStartedAt: r.sequence_started_at as string,
    nextActionAt: (r.next_action_at as string | null) ?? null,
    lastMessageAt: (r.last_message_at as string | null) ?? null,
    followUpStep: r.follow_up_step as number,
    status: r.status as FollowUpStatus,
    stopReason: (r.stop_reason as FollowUpStopReason | null) ?? null,
  };
}

/** Statuses from which the sequence can still send or be stopped. */
const OPEN = "('ACTIVE', 'PAUSED')";

export class FollowUpRepository {
  constructor(private readonly db: D1Database) {}

  async create(followUp: Omit<FollowUp, "id" | "updatedAt">): Promise<FollowUp> {
    const saved: FollowUp = { ...followUp, id: crypto.randomUUID(), updatedAt: followUp.createdAt };
    await this.db
      .prepare(
        `INSERT INTO follow_ups (id, lead_id, estimate_external_id, customer_name, phone_e164, created_at,
           updated_at, sequence_started_at, next_action_at, last_message_at, follow_up_step, status, stop_reason)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        saved.id, saved.leadId, saved.estimateExternalId, saved.customerName, saved.phoneE164, saved.createdAt,
        saved.updatedAt, saved.sequenceStartedAt, saved.nextActionAt, saved.lastMessageAt, saved.followUpStep,
        saved.status, saved.stopReason,
      )
      .run();
    return saved;
  }

  async findById(id: string): Promise<FollowUp | null> {
    const row = await this.db.prepare("SELECT * FROM follow_ups WHERE id = ?").bind(id).first<Row>();
    return row ? fromRow(row) : null;
  }

  async findOpenByPhone(phoneE164: string): Promise<FollowUp[]> {
    const { results } = await this.db
      .prepare(`SELECT * FROM follow_ups WHERE phone_e164 = ? AND status IN ${OPEN} ORDER BY created_at DESC`)
      .bind(phoneE164)
      .all<Row>();
    return results.map(fromRow);
  }

  /** Follow-ups created since `since`, newest first (for owner commands and the admin view). */
  async listSince(since: string, limit = 200): Promise<FollowUp[]> {
    const { results } = await this.db
      .prepare("SELECT * FROM follow_ups WHERE created_at >= ? ORDER BY created_at DESC LIMIT ?")
      .bind(since, limit)
      .all<Row>();
    return results.map(fromRow);
  }

  async findDue(now: string, limit = 50): Promise<FollowUp[]> {
    const { results } = await this.db
      .prepare(
        `SELECT * FROM follow_ups WHERE status = 'ACTIVE' AND next_action_at <= ?
         ORDER BY next_action_at LIMIT ?`,
      )
      .bind(now, limit)
      .all<Row>();
    return results.map(fromRow);
  }

  /**
   * Atomically claims step `step` of an active follow-up so two overlapping
   * cron runs can never send the same message twice. Returns false if
   * something else already advanced or stopped it.
   */
  async claimStep(id: string, step: number, nextActionAt: string | null, now: string): Promise<boolean> {
    const result = await this.db
      .prepare(
        `UPDATE follow_ups SET follow_up_step = ?, next_action_at = ?, last_message_at = ?, updated_at = ?
         WHERE id = ? AND status = 'ACTIVE' AND follow_up_step = ?`,
      )
      .bind(step + 1, nextActionAt, now, now, id, step)
      .run();
    return result.meta.changes === 1;
  }

  /** Undo a claimed step whose send failed, so it is retried at `retryAt`. */
  async releaseStep(id: string, step: number, retryAt: string, now: string): Promise<void> {
    await this.db
      .prepare(
        `UPDATE follow_ups SET follow_up_step = ?, next_action_at = ?, updated_at = ?
         WHERE id = ? AND status = 'ACTIVE' AND follow_up_step = ?`,
      )
      .bind(step, retryAt, now, id, step + 1)
      .run();
  }

  async reschedule(id: string, nextActionAt: string, now: string): Promise<void> {
    await this.db
      .prepare("UPDATE follow_ups SET next_action_at = ?, updated_at = ? WHERE id = ? AND status = 'ACTIVE'")
      .bind(nextActionAt, now, id)
      .run();
  }

  /** Stops an open follow-up. Returns false if it was already stopped. */
  async stop(id: string, status: FollowUpStatus, reason: FollowUpStopReason, now: string): Promise<boolean> {
    const result = await this.db
      .prepare(
        `UPDATE follow_ups SET status = ?, stop_reason = ?, next_action_at = NULL, updated_at = ?
         WHERE id = ? AND status IN ${OPEN}`,
      )
      .bind(status, reason, now, id)
      .run();
    return result.meta.changes === 1;
  }

  /** Marks the estimate accepted even if the sequence already ended. */
  async markAccepted(id: string, now: string): Promise<void> {
    await this.db
      .prepare(
        `UPDATE follow_ups SET status = 'ACCEPTED', stop_reason = 'ESTIMATE_ACCEPTED', next_action_at = NULL,
           updated_at = ? WHERE id = ?`,
      )
      .bind(now, id)
      .run();
  }

  async addMessage(message: Omit<FollowUpMessage, "id">): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO follow_up_messages (id, follow_up_id, created_at, direction, step, body, delivery_status,
           provider_message_id, error) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        crypto.randomUUID(), message.followUpId, message.createdAt, message.direction, message.step,
        message.body, message.deliveryStatus, message.providerMessageId, message.error,
      )
      .run();
  }

  async listMessages(followUpId: string): Promise<FollowUpMessage[]> {
    const { results } = await this.db
      .prepare("SELECT * FROM follow_up_messages WHERE follow_up_id = ? ORDER BY created_at, rowid")
      .bind(followUpId)
      .all<Row>();
    return results.map((r) => ({
      id: r.id as string,
      followUpId: r.follow_up_id as string,
      createdAt: r.created_at as string,
      direction: r.direction as "INBOUND" | "OUTBOUND",
      step: (r.step as number | null) ?? null,
      body: r.body as string,
      deliveryStatus: r.delivery_status as FollowUpMessage["deliveryStatus"],
      providerMessageId: (r.provider_message_id as string | null) ?? null,
      error: (r.error as string | null) ?? null,
    }));
  }
}
