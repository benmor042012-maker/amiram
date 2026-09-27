# Estimate follow-up (Module 3)

Joist has no API, webhooks or Zapier app, so the system can't see estimates
by itself. For now Amiram starts a follow-up with one text after sending an
estimate in Joist.

## Amiram's commands

Text these to the system's Twilio number from `OWNER_PHONE`:

| Command | Effect |
|---|---|
| `EST John Smith 310-555-1234 #1042` | Start the sequence (estimate number optional) |
| `WON John` or `WON 310-555-1234` | Estimate accepted: stop, mark the matching lead WON |
| `DONE John` | Stop the sequence |
| `LIST` | Active follow-ups |

The system texts back a confirmation. Names match on part of the name; if two
customers match, use the phone number.

**Don't** text a bare `STOP`, `CANCEL` or `HELP` to the system number:
Twilio handles those words itself and would opt Amiram's phone out.

The same actions exist in the admin API (`/api/admin/follow-ups`).

## Sequence

Configured in `src/config/followUp.ts` (wording and timing):

- Day 1: "Just checking that you received your roofing estimate…"
- Day 3: "Amiram can go over the scope, timing, or next steps…"
- Day 7: "Checking in one last time…"

Texts only go out 9:00–18:00 Los Angeles time; anything due outside that
window waits for the next morning. The first text ends with "Reply STOP to opt out."

## Stop conditions

| Event | Result |
|---|---|
| Customer texts back (anything) | `RESPONDED`; the reply is forwarded to Amiram |
| Customer texts STOP / UNSUBSCRIBE / CANCEL… | `OPTED_OUT`; number never texted again until START |
| `WON` | `ACCEPTED` (matching lead → `WON`) |
| `DONE` | `CANCELLED` |
| Number can't receive texts (Twilio 21211, 21614, …) | `CANCELLED` / `INVALID_PHONE`; Amiram is told |
| Day-7 text sent | `COMPLETED` |

Transient send failures are retried an hour later. Overlapping cron runs
can't send the same step twice (each step is claimed in the database first).

## Consent

Only start a follow-up for customers who agreed to receive texts about their
estimate (e.g. confirmed during the inspection). Every text goes through the
opt-out list.

## Next: automatic stop from Joist emails

Joist emails Amiram when an estimate is signed. With a real sample of that
email, a forwarding rule + Cloudflare Email Routing can mark the follow-up
accepted automatically, replacing the `WON` text.
