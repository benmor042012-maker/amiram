-- Call screening (Module 4). Every inbound call to the business number is
-- logged here with the screening decision, whether or not it became a lead.
CREATE TABLE calls (
  call_sid TEXT PRIMARY KEY,            -- Twilio CallSid
  from_e164 TEXT,                       -- NULL for withheld / invalid caller ID
  received_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  stir_verstat TEXT,                    -- Twilio STIR/SHAKEN result, if sent

  -- KNOWN_CALLER | BLOCKED | SCREENING | RING | FILTERED | VOICEMAIL | NO_RESPONSE
  decision TEXT NOT NULL,
  reason TEXT,                          -- short machine reason, e.g. intent:SPAM
  speech TEXT,                          -- what the caller said at the screening prompt
  lead_id TEXT REFERENCES leads (id),

  accepted_at TEXT,                     -- Amiram pressed 1 on the whisper
  outcome TEXT,                         -- ANSWERED | MISSED | VOICEMAIL | HUNG_UP | REJECTED | ENDED
  voicemail_transcript TEXT,
  completed_at TEXT
);
CREATE INDEX calls_received_at ON calls (received_at);
CREATE INDEX calls_from ON calls (from_e164, received_at);

-- Numbers Amiram blocked (BLOCK) or always lets through (ALLOW), plus
-- numbers auto-blocked after the screener heard spam from them.
CREATE TABLE caller_rules (
  phone_e164 TEXT PRIMARY KEY,
  rule TEXT NOT NULL,                   -- BLOCK | ALLOW
  source TEXT NOT NULL,                 -- OWNER | AUTO
  created_at TEXT NOT NULL,
  reason TEXT
);
