export type CallDecision =
  | "KNOWN_CALLER"
  | "BLOCKED"
  | "SCREENING"
  | "RING"
  | "FILTERED"
  | "VOICEMAIL"
  | "NO_RESPONSE";
export type CallOutcome = "ANSWERED" | "MISSED" | "VOICEMAIL" | "HUNG_UP" | "REJECTED" | "ENDED";
export type CallerRule = "BLOCK" | "ALLOW";

export interface Call {
  callSid: string;
  fromE164: string | null;
  receivedAt: string;
  updatedAt: string;
  stirVerstat: string | null;
  decision: CallDecision;
  reason: string | null;
  speech: string | null;
  leadId: string | null;
  acceptedAt: string | null;
  outcome: CallOutcome | null;
  voicemailTranscript: string | null;
  completedAt: string | null;
}

const COLUMNS: Record<keyof Call, string> = {
  callSid: "call_sid",
  fromE164: "from_e164",
  receivedAt: "received_at",
  updatedAt: "updated_at",
  stirVerstat: "stir_verstat",
  decision: "decision",
  reason: "reason",
  speech: "speech",
  leadId: "lead_id",
  acceptedAt: "accepted_at",
  outcome: "outcome",
  voicemailTranscript: "voicemail_transcript",
  completedAt: "completed_at",
};

function fromRow(row: Record<string, unknown>): Call {
  const call: Record<string, unknown> = {};
  for (const [field, column] of Object.entries(COLUMNS)) call[field] = row[column] ?? null;
  return call as unknown as Call;
}

/** Inbound calls and the per-number BLOCK / ALLOW rules. */
export class CallRepository {
  constructor(private readonly db: D1Database) {}

  /** Inserts the call, or returns the existing row if Twilio retried the webhook. */
  async create(call: Omit<Call, "updatedAt">): Promise<{ call: Call; created: boolean }> {
    const saved: Call = { ...call, updatedAt: call.receivedAt };
    const fields = Object.keys(COLUMNS) as (keyof Call)[];
    const result = await this.db
      .prepare(
        `INSERT INTO calls (${fields.map((f) => COLUMNS[f]).join(", ")})
         VALUES (${fields.map(() => "?").join(", ")}) ON CONFLICT (call_sid) DO NOTHING`,
      )
      .bind(...fields.map((f) => saved[f]))
      .run();
    if (result.meta.changes > 0) return { call: saved, created: true };
    return { call: (await this.find(call.callSid))!, created: false };
  }

  async find(callSid: string): Promise<Call | null> {
    const row = await this.db.prepare("SELECT * FROM calls WHERE call_sid = ?").bind(callSid).first();
    return row ? fromRow(row) : null;
  }

  async update(callSid: string, changes: Partial<Omit<Call, "callSid">>, now: string): Promise<void> {
    const entries = Object.entries({ ...changes, updatedAt: now }).filter(([f]) => f in COLUMNS);
    await this.db
      .prepare(`UPDATE calls SET ${entries.map(([f]) => `${COLUMNS[f as keyof Call]} = ?`).join(", ")} WHERE call_sid = ?`)
      .bind(...entries.map(([, v]) => v ?? null), callSid)
      .run();
  }

  async listSince(since: string, limit = 200): Promise<Call[]> {
    const { results } = await this.db
      .prepare("SELECT * FROM calls WHERE received_at >= ? ORDER BY received_at DESC LIMIT ?")
      .bind(since, limit)
      .all();
    return results.map(fromRow);
  }

  /** How many earlier calls from this number were screened out with `reason`. */
  async countFiltered(fromE164: string, reason: string): Promise<number> {
    const row = await this.db
      .prepare("SELECT COUNT(*) AS n FROM calls WHERE from_e164 = ? AND decision = 'FILTERED' AND reason = ?")
      .bind(fromE164, reason)
      .first<{ n: number }>();
    return row?.n ?? 0;
  }

  async ruleFor(phoneE164: string): Promise<CallerRule | null> {
    const row = await this.db
      .prepare("SELECT rule FROM caller_rules WHERE phone_e164 = ?")
      .bind(phoneE164)
      .first<{ rule: CallerRule }>();
    return row?.rule ?? null;
  }

  async setRule(phoneE164: string, rule: CallerRule, source: "OWNER" | "AUTO", now: string, reason: string | null): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO caller_rules (phone_e164, rule, source, created_at, reason) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (phone_e164) DO UPDATE SET rule = excluded.rule, source = excluded.source,
           created_at = excluded.created_at, reason = excluded.reason`,
      )
      .bind(phoneE164, rule, source, now, reason)
      .run();
  }

  async clearRule(phoneE164: string): Promise<boolean> {
    const result = await this.db.prepare("DELETE FROM caller_rules WHERE phone_e164 = ?").bind(phoneE164).run();
    return result.meta.changes > 0;
  }
}
