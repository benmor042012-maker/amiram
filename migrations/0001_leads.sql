-- Normalized lead model shared by every lead source (Yelp, website, ...).
-- Timestamps are ISO-8601 UTC strings. Booleans are 0/1/NULL (NULL = unknown).
CREATE TABLE leads (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,                 -- YELP | WEBSITE
  external_lead_id TEXT,                -- id in the source system (e.g. Yelp lead id)

  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  received_at TEXT NOT NULL,            -- when our system received the lead
  source_created_at TEXT,               -- when the source says the lead was created

  name TEXT,
  phone TEXT,
  email TEXT,
  address TEXT,
  city TEXT,
  state TEXT,
  zip TEXT,

  service_type TEXT,                    -- ServiceType enum
  problem_description TEXT,
  original_message TEXT NOT NULL,

  active_leak INTEGER,
  emergency INTEGER,
  home_owner INTEGER,
  inspection_requested INTEGER,
  roof_type TEXT,
  roof_age TEXT,
  desired_timeframe TEXT,               -- Timeframe enum
  preferred_contact_time TEXT,
  intent TEXT,                          -- LeadIntent enum

  lead_score TEXT,                      -- HOT | WARM | LOW
  lead_reasons TEXT NOT NULL DEFAULT '[]',  -- JSON string[]
  service_area TEXT,                    -- IN_AREA | OUT_OF_AREA | UNKNOWN

  qualification_status TEXT NOT NULL,
  conversation_status TEXT NOT NULL,
  owner_notification_status TEXT NOT NULL,
  status TEXT NOT NULL,

  ai_summary TEXT,
  extraction_method TEXT,               -- AI | FALLBACK
  customer_turns INTEGER NOT NULL DEFAULT 0,

  first_automated_response_at TEXT,
  response_time_seconds REAL,
  owner_notified_at TEXT,
  notified_score TEXT,                  -- score included in the last owner notification

  raw_payload TEXT                      -- original inbound payload, for debugging
);

CREATE UNIQUE INDEX leads_source_external_id ON leads (source, external_lead_id)
  WHERE external_lead_id IS NOT NULL;
CREATE INDEX leads_received_at ON leads (received_at);
CREATE INDEX leads_owner_notification ON leads (owner_notification_status, received_at);

-- Every message exchanged with the customer (and the owner notifications).
CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  lead_id TEXT NOT NULL REFERENCES leads (id),
  created_at TEXT NOT NULL,
  direction TEXT NOT NULL,              -- INBOUND | OUTBOUND
  channel TEXT NOT NULL,                -- YELP | SMS | EMAIL | WEBSITE
  recipient TEXT NOT NULL,              -- CUSTOMER | OWNER
  body TEXT NOT NULL,
  delivery_status TEXT NOT NULL,        -- RECEIVED | SENT | HANDED_OFF | FAILED
  provider_message_id TEXT,
  error TEXT
);
CREATE INDEX messages_lead ON messages (lead_id, created_at);

-- Append-only event log. All pilot metrics are computed from here + leads.
CREATE TABLE lead_events (
  id TEXT PRIMARY KEY,
  lead_id TEXT NOT NULL REFERENCES leads (id),
  created_at TEXT NOT NULL,
  type TEXT NOT NULL,
  data TEXT                             -- JSON, no secrets
);
CREATE INDEX lead_events_lead ON lead_events (lead_id, created_at);
CREATE INDEX lead_events_type ON lead_events (type, created_at);
