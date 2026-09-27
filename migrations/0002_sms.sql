-- Website leads are answered by SMS, which needs consent tracking, a
-- normalized phone number to match inbound texts, and a global opt-out list.
ALTER TABLE leads ADD COLUMN sms_consent INTEGER;   -- 1 = explicit consent, 0 = declined, NULL = not asked
ALTER TABLE leads ADD COLUMN phone_e164 TEXT;       -- normalized from phone, for matching inbound SMS
CREATE INDEX leads_phone_e164 ON leads (phone_e164, received_at);

-- A number that texted STOP (or similar) never receives automated texts again
-- until it texts START.
CREATE TABLE sms_opt_outs (
  phone_e164 TEXT PRIMARY KEY,
  opted_out_at TEXT NOT NULL,
  keyword TEXT NOT NULL
);
