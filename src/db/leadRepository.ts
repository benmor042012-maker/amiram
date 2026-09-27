import type { Lead, LeadFacts, NormalizedLeadInput } from "../domain/lead";
import { toE164 } from "../util/phone";

type Row = Record<string, unknown>;

/** camelCase Lead field -> snake_case column. */
const COLUMNS: Record<string, string> = {
  id: "id",
  source: "source",
  externalLeadId: "external_lead_id",
  createdAt: "created_at",
  updatedAt: "updated_at",
  receivedAt: "received_at",
  sourceCreatedAt: "source_created_at",
  name: "name",
  phone: "phone",
  email: "email",
  address: "address",
  city: "city",
  state: "state",
  zip: "zip",
  serviceType: "service_type",
  problemDescription: "problem_description",
  originalMessage: "original_message",
  activeLeak: "active_leak",
  emergency: "emergency",
  homeOwner: "home_owner",
  inspectionRequested: "inspection_requested",
  roofType: "roof_type",
  roofAge: "roof_age",
  desiredTimeframe: "desired_timeframe",
  preferredContactTime: "preferred_contact_time",
  intent: "intent",
  leadScore: "lead_score",
  leadReasons: "lead_reasons",
  serviceArea: "service_area",
  qualificationStatus: "qualification_status",
  conversationStatus: "conversation_status",
  ownerNotificationStatus: "owner_notification_status",
  status: "status",
  aiSummary: "ai_summary",
  extractionMethod: "extraction_method",
  customerTurns: "customer_turns",
  firstAutomatedResponseAt: "first_automated_response_at",
  responseTimeSeconds: "response_time_seconds",
  ownerNotifiedAt: "owner_notified_at",
  notifiedScore: "notified_score",
  smsConsent: "sms_consent",
  phoneE164: "phone_e164",
};

const BOOLEAN_FIELDS = new Set(["activeLeak", "emergency", "homeOwner", "inspectionRequested", "smsConsent"]);

function toColumnValue(field: string, value: unknown): unknown {
  if (value === undefined) return null;
  if (field === "leadReasons") return JSON.stringify(value ?? []);
  if (BOOLEAN_FIELDS.has(field)) return value === null ? null : value ? 1 : 0;
  return value;
}

function fromRow(row: Row): Lead {
  const lead: Record<string, unknown> = {};
  for (const [field, column] of Object.entries(COLUMNS)) {
    let value = row[column];
    if (field === "leadReasons") value = JSON.parse((value as string) ?? "[]");
    else if (BOOLEAN_FIELDS.has(field)) value = value === null ? null : value === 1;
    lead[field] = value ?? null;
  }
  return lead as unknown as Lead;
}

export class LeadRepository {
  constructor(private readonly db: D1Database) {}

  async create(input: NormalizedLeadInput, facts: LeadFacts, now: string): Promise<Lead> {
    const lead: Lead = {
      ...facts,
      id: crypto.randomUUID(),
      source: input.source,
      externalLeadId: input.externalLeadId,
      createdAt: now,
      updatedAt: now,
      receivedAt: now,
      sourceCreatedAt: input.sourceCreatedAt,
      originalMessage: input.originalMessage,
      leadScore: null,
      leadReasons: [],
      serviceArea: null,
      qualificationStatus: "PENDING",
      conversationStatus: "NOT_STARTED",
      ownerNotificationStatus: "NOT_SENT",
      status: "NEW",
      aiSummary: null,
      extractionMethod: null,
      customerTurns: 0,
      firstAutomatedResponseAt: null,
      responseTimeSeconds: null,
      ownerNotifiedAt: null,
      notifiedScore: null,
      smsConsent: input.smsConsent ?? null,
      phoneE164: toE164(facts.phone),
    };
    const fields = Object.keys(COLUMNS);
    const columns = [...fields.map((f) => COLUMNS[f]!), "raw_payload"];
    const values = [
      ...fields.map((f) => toColumnValue(f, (lead as unknown as Row)[f])),
      JSON.stringify(input.rawPayload ?? null),
    ];
    await this.db
      .prepare(
        `INSERT INTO leads (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
      )
      .bind(...values)
      .run();
    return lead;
  }

  async update(id: string, changes: Partial<Lead>, now: string): Promise<void> {
    const derived = "phone" in changes ? { phoneE164: toE164(changes.phone) } : {};
    const entries = Object.entries({ ...changes, ...derived, updatedAt: now }).filter(
      ([field]) => field in COLUMNS && field !== "id",
    );
    if (entries.length === 0) return;
    const sets = entries.map(([field]) => `${COLUMNS[field]} = ?`).join(", ");
    const values = entries.map(([field, value]) => toColumnValue(field, value));
    await this.db
      .prepare(`UPDATE leads SET ${sets} WHERE id = ?`)
      .bind(...values, id)
      .run();
  }

  async findById(id: string): Promise<Lead | null> {
    const row = await this.db.prepare("SELECT * FROM leads WHERE id = ?").bind(id).first<Row>();
    return row ? fromRow(row) : null;
  }

  async findByExternalId(source: string, externalLeadId: string): Promise<Lead | null> {
    const row = await this.db
      .prepare("SELECT * FROM leads WHERE source = ? AND external_lead_id = ?")
      .bind(source, externalLeadId)
      .first<Row>();
    return row ? fromRow(row) : null;
  }

  async list(limit = 100): Promise<Lead[]> {
    const { results } = await this.db
      .prepare("SELECT * FROM leads ORDER BY received_at DESC LIMIT ?")
      .bind(limit)
      .all<Row>();
    return results.map(fromRow);
  }

  /** Most recent lead from `source` with this phone number. */
  async findLatestByPhone(phoneE164: string, source: string): Promise<Lead | null> {
    const row = await this.db
      .prepare("SELECT * FROM leads WHERE phone_e164 = ? AND source = ? ORDER BY received_at DESC LIMIT 1")
      .bind(phoneE164, source)
      .first<Row>();
    return row ? fromRow(row) : null;
  }

  /** Leads never shown to Amiram that were received before `receivedBefore`. */
  async findAwaitingOwnerNotification(receivedBefore: string): Promise<Lead[]> {
    const { results } = await this.db
      .prepare(
        `SELECT * FROM leads
         WHERE owner_notification_status IN ('NOT_SENT', 'FAILED') AND received_at <= ?
         ORDER BY received_at LIMIT 50`,
      )
      .bind(receivedBefore)
      .all<Row>();
    return results.map(fromRow);
  }
}
