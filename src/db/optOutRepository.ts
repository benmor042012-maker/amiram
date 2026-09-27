/** Numbers that asked not to receive automated texts. */
export class OptOutRepository {
  constructor(private readonly db: D1Database) {}

  async optOut(phoneE164: string, keyword: string, now: string): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO sms_opt_outs (phone_e164, opted_out_at, keyword) VALUES (?, ?, ?)
         ON CONFLICT (phone_e164) DO UPDATE SET opted_out_at = excluded.opted_out_at, keyword = excluded.keyword`,
      )
      .bind(phoneE164, now, keyword)
      .run();
  }

  async optIn(phoneE164: string): Promise<void> {
    await this.db.prepare("DELETE FROM sms_opt_outs WHERE phone_e164 = ?").bind(phoneE164).run();
  }

  async isOptedOut(phoneE164: string): Promise<boolean> {
    const row = await this.db
      .prepare("SELECT 1 AS found FROM sms_opt_outs WHERE phone_e164 = ?")
      .bind(phoneE164)
      .first();
    return row !== null;
  }
}
