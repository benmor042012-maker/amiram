-- Estimate follow-up sequences (Module 3). Started manually by Amiram for
-- now (Joist has no API); an estimate may or may not match a tracked lead.
CREATE TABLE follow_ups (
  id TEXT PRIMARY KEY,
  lead_id TEXT REFERENCES leads (id),   -- set when the phone matches a known lead
  estimate_external_id TEXT,            -- Joist estimate number, if given
  customer_name TEXT NOT NULL,
  phone_e164 TEXT NOT NULL,

  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  sequence_started_at TEXT NOT NULL,
  next_action_at TEXT,                  -- NULL once the sequence has stopped
  last_message_at TEXT,

  follow_up_step INTEGER NOT NULL DEFAULT 0,  -- messages sent so far
  status TEXT NOT NULL,                 -- ACTIVE | PAUSED | RESPONDED | OPTED_OUT | ACCEPTED | COMPLETED | CANCELLED
  stop_reason TEXT                      -- e.g. CUSTOMER_REPLIED, OWNER_CANCELLED, INVALID_PHONE
);
CREATE INDEX follow_ups_due ON follow_ups (status, next_action_at);
CREATE INDEX follow_ups_phone ON follow_ups (phone_e164, created_at);

CREATE TABLE follow_up_messages (
  id TEXT PRIMARY KEY,
  follow_up_id TEXT NOT NULL REFERENCES follow_ups (id),
  created_at TEXT NOT NULL,
  direction TEXT NOT NULL,              -- INBOUND | OUTBOUND
  step INTEGER,                         -- sequence step for outbound messages
  body TEXT NOT NULL,
  delivery_status TEXT NOT NULL,        -- RECEIVED | SENT | FAILED | BLOCKED_OPT_OUT
  provider_message_id TEXT,
  error TEXT
);
CREATE INDEX follow_up_messages_follow_up ON follow_up_messages (follow_up_id, created_at);
