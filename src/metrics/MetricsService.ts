export interface PilotMetrics {
  from: string | null;
  to: string | null;
  leadsReceived: number;
  leadsBySource: Record<string, number>;
  leadsContacted: number;
  leadsQualified: number;
  hotLeads: number;
  warmLeads: number;
  lowLeads: number;
  ownerNotifications: number;
  customerResponses: number;
  leadsWithCustomerResponse: number;
  callbacksRequested: number;
  inspectionsScheduled: number;
  won: number;
  optOuts: number;
  customerSmsSkipped: number;
  followUps: {
    started: number;
    messagesSent: number;
    responded: number;
    accepted: number;
    optedOut: number;
    completedWithoutResponse: number;
  };
  responseTimeSeconds: { average: number | null; median: number | null; max: number | null };
}

/** Pilot metrics computed from the leads table and the event log. */
export class MetricsService {
  constructor(private readonly db: D1Database) {}

  async compute(from: string | null = null, to: string | null = null): Promise<PilotMetrics> {
    const range = "received_at >= ? AND received_at <= ?";
    const lo = from ?? "0000";
    const hi = to ?? "9999";

    const leadRow = await this.db
      .prepare(
        `SELECT
           COUNT(*) AS received,
           SUM(first_automated_response_at IS NOT NULL) AS contacted,
           SUM(qualification_status = 'COMPLETE') AS qualified,
           SUM(lead_score = 'HOT') AS hot,
           SUM(lead_score = 'WARM') AS warm,
           SUM(lead_score = 'LOW') AS low,
           SUM(customer_turns > 0) AS responded
         FROM leads WHERE ${range}`,
      )
      .bind(lo, hi)
      .first<Record<string, number | null>>();

    const { results: sources } = await this.db
      .prepare(`SELECT source, COUNT(*) AS n FROM leads WHERE ${range} GROUP BY source`)
      .bind(lo, hi)
      .all<{ source: string; n: number }>();

    const { results: times } = await this.db
      .prepare(
        `SELECT response_time_seconds AS t FROM leads
         WHERE ${range} AND response_time_seconds IS NOT NULL ORDER BY t`,
      )
      .bind(lo, hi)
      .all<{ t: number }>();

    // Events are counted by when they happened, for leads received in range.
    const eventCount = async (type: string, where = "") => {
      const row = await this.db
        .prepare(
          `SELECT COUNT(*) AS n FROM lead_events e JOIN leads l ON l.id = e.lead_id
           WHERE e.type = ? AND l.${range} ${where}`,
        )
        .bind(type, lo, hi)
        .first<{ n: number }>();
      return row?.n ?? 0;
    };
    const statusReached = (status: string) =>
      eventCount("STATUS_CHANGED", `AND json_extract(e.data, '$.to') = '${status}'`);

    const values = times.map((r) => r.t);
    return {
      from,
      to,
      leadsReceived: leadRow?.received ?? 0,
      leadsBySource: Object.fromEntries(sources.map((s) => [s.source, s.n])),
      leadsContacted: leadRow?.contacted ?? 0,
      leadsQualified: leadRow?.qualified ?? 0,
      hotLeads: leadRow?.hot ?? 0,
      warmLeads: leadRow?.warm ?? 0,
      lowLeads: leadRow?.low ?? 0,
      ownerNotifications: await eventCount("OWNER_NOTIFIED"),
      customerResponses: await eventCount("CUSTOMER_REPLIED"),
      leadsWithCustomerResponse: leadRow?.responded ?? 0,
      callbacksRequested: await statusReached("CALLBACK_REQUESTED"),
      inspectionsScheduled: await statusReached("INSPECTION_SCHEDULED"),
      won: await statusReached("WON"),
      optOuts: await eventCount("OPTED_OUT"),
      customerSmsSkipped: await eventCount("CUSTOMER_MESSAGE_SKIPPED"),
      followUps: await this.followUpMetrics(lo, hi),
      responseTimeSeconds: {
        average: values.length ? round(values.reduce((a, b) => a + b, 0) / values.length) : null,
        median: values.length ? round(median(values)) : null,
        max: values.length ? round(values[values.length - 1]!) : null,
      },
    };
  }

  /** Follow-ups started in range, by outcome. */
  private async followUpMetrics(lo: string, hi: string): Promise<PilotMetrics["followUps"]> {
    const row = await this.db
      .prepare(
        `SELECT
           COUNT(*) AS started,
           SUM(status = 'RESPONDED') AS responded,
           SUM(status = 'ACCEPTED') AS accepted,
           SUM(status = 'OPTED_OUT') AS opted_out,
           SUM(status = 'COMPLETED') AS completed,
           (SELECT COUNT(*) FROM follow_up_messages m JOIN follow_ups f ON f.id = m.follow_up_id
             WHERE m.direction = 'OUTBOUND' AND m.delivery_status = 'SENT'
               AND f.created_at >= ?1 AND f.created_at <= ?2) AS sent
         FROM follow_ups WHERE created_at >= ?1 AND created_at <= ?2`,
      )
      .bind(lo, hi)
      .first<Record<string, number | null>>();
    return {
      started: row?.started ?? 0,
      messagesSent: row?.sent ?? 0,
      responded: row?.responded ?? 0,
      accepted: row?.accepted ?? 0,
      optedOut: row?.opted_out ?? 0,
      completedWithoutResponse: row?.completed ?? 0,
    };
  }
}

function median(sorted: number[]): number {
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

function round(n: number): number {
  return Math.round(n * 10) / 10;
}
