# Family Roofing: AI Lead Automation

An automation layer around Family Roofing's existing tools. It replies to new
leads right away, qualifies them in a short exchange, scores them with
deterministic rules, and texts Amiram the leads worth calling.

It does **not** replace Joist (CRM / estimates / invoices) and does **not**
answer phone calls; Joist's AI Receptionist is being evaluated separately for that.

## Status

| Module | Status |
|---|---|
| 1. Yelp lead automation | Built and tested with simulated leads. Live connection goes through Yelp's official Zapier app ([setup](docs/yelp-zapier-setup.md)). |
| 2. Website lead automation | Built and tested with simulated submissions: same pipeline, SMS replies to consenting customers, STOP/START handling ([setup](docs/website-form-setup.md)). Needs the real form's plugin/field names. |
| 3. Estimate follow-up | Later. Joist has no API, webhooks or Zapier app. Joist emails Amiram when an estimate is signed, so that email can stop follow-ups automatically; starting a follow-up is manual for now. |

## How a lead flows

```
Yelp "New Lead" ─► Zapier ─► POST /api/yelp/leads
                                  │
         YelpLeadAdapter ─────────┤  normalize
         LeadExtractionService ───┤  Claude reads the message → structured facts (null = unknown)
         LeadScoringService ──────┤  deterministic rules → HOT / WARM / LOW + reasons
         ConversationService ─────┤  reply that asks only for what's missing
                                  ▼
          JSON { reply } ─► Zapier ─► Yelp "Create Message"   (customer gets the reply)
          background ─────► NotificationProvider (Twilio SMS) ─► Amiram
```

Website form submissions (`POST /api/website/leads`) go through the same
pipeline; the reply goes out by SMS, only to customers who ticked the SMS
consent box, and their texted answers come back via `POST /api/sms/inbound`.

- **AI does not score.** Claude only extracts facts and writes a neutral
  summary for Amiram. `src/config/scoring.ts` alone decides HOT/WARM/LOW.
- **Customer text is templated** (`src/config/conversation.ts`), so it never
  contains prices, diagnoses or promises, and questions already answered are
  never re-asked.
- **When Amiram is notified:** immediately for HOT leads, when qualification
  completes, or when the AI is unavailable. Otherwise the cron trigger notifies
  him 10 minutes after the lead arrived. Spam is never notified.
- **If Claude is down,** a conservative keyword fallback still replies and
  notifies Amiram, and the notification says the AI was unavailable.

## Project layout

```
src/
  index.ts / app.ts           Worker entry (HTTP + cron), thin Hono routes
  routes/                     yelp.ts (Zapier), website.ts (form webhook), sms.ts (Twilio inbound), admin.ts
  domain/lead.ts              normalized lead model + enums
  lead-sources/               LeadSourceAdapter, YelpLeadAdapter, WebsiteLeadAdapter
  messaging/                  customer SMS (Twilio / console) with opt-out guard, inbound SMS handling
  ai/                         LeadExtractionService (Claude), ConversationService, LeadSummaryService
  qualification/             LeadScoringService, LeadQualificationService (the pipeline)
  notifications/              NotificationProvider, Twilio SMS, console (dev)
  metrics/                    pilot metrics from the leads table + event log
  config/                     scoring rules, service area, message templates
  db/                         D1 repositories
migrations/                   D1 schema
test/                         unit tests + full simulated Yelp flow
```

## Stack

Cloudflare Workers + Hono, D1 (SQLite), a Cron Trigger (every 5 minutes),
Claude via `@anthropic-ai/sdk` with structured outputs, and Twilio's REST API
for SMS.

## Develop

```bash
npm install
cp .env.example .dev.vars          # fill in values; never commit
npm run db:migrate:local
npm run dev                         # http://localhost:8787
npm test                            # runs in the Workers runtime with a local D1
npm run typecheck

# Step-9 example lead against the running dev server (uses Claude if ANTHROPIC_API_KEY is set):
YELP_WEBHOOK_SECRET=... ADMIN_TOKEN=... scripts/simulate-yelp-lead.sh
```

## Deploy

```bash
npx wrangler d1 create family-roofing-leads   # put the id in wrangler.toml
npm run db:migrate:remote
npx wrangler secret put ANTHROPIC_API_KEY     # repeat for each secret in .env.example
npm run deploy
```

Set `NOTIFICATION_PROVIDER=twilio` and the `TWILIO_*` / `OWNER_PHONE` secrets
to text Amiram for real, and `CUSTOMER_SMS_PROVIDER=twilio` to text customers
(only after A2P 10DLC approval).

## API

| Method | Path | Auth | Purpose |
|---|---|---|---|
| POST | `/api/yelp/leads` | `x-webhook-secret` | New Yelp lead from Zapier; returns `{ reply, send_reply, lead_score }` |
| POST | `/api/yelp/messages` | `x-webhook-secret` | Customer reply in a Yelp thread (if Zapier supports that trigger) |
| POST | `/api/website/leads` | `x-webhook-secret` (or `webhook_secret` field) | Website form submission (JSON or form-encoded) |
| POST | `/api/sms/inbound` | Twilio signature | Customer texts: replies continue qualification; STOP/START manage opt-out |
| GET | `/api/admin/leads` | Bearer `ADMIN_TOKEN` | Lead list (score, source, status, notified?) |
| GET | `/api/admin/leads/:id` | Bearer | Full lead, conversation, event log |
| POST | `/api/admin/leads/:id/status` | Bearer | Amiram marks `CALLBACK_REQUESTED`, `INSPECTION_SCHEDULED`, `WON`, `LOST`, `CLOSED` |
| GET | `/api/admin/metrics?from=&to=` | Bearer | Pilot metrics incl. response time |

## Open items / limitations

- **Yelp:** it isn't confirmed yet whether Zapier's Yelp Leads app can trigger
  on *customer replies* (not just new leads), or how fast its New Lead trigger
  fires. Both need checking on the real account.
- **Service area** (`src/config/serviceArea.ts`) and **scoring weights** need
  Amiram's confirmation.
- **Twilio:** texting *customers* (website leads, follow-ups) needs A2P 10DLC
  registration. Texting Amiram alone is simpler, but registration should start now.
- **Joist:** no official API, webhooks or Zapier integration. Estimate
  follow-up will be triggered manually or via QuickBooks Online if they use it.
