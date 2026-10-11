# Call screening (Module 4)

Amiram's #1 problem: about 1 in 10 calls is spam, a sales pitch, or not a job
Family Roofing does, and every one of them interrupts him on a roof. This
module answers the business number first, asks unknown callers one question,
and only rings his phone for calls worth taking. When it does ring, he hears
who it is before he picks up.

## What a caller experiences

| Caller | What happens | Amiram |
|---|---|---|
| Existing customer (any earlier lead or open estimate follow-up), or an `ALLOW`ed number | "Connecting you now", rings straight through | Whisper: "call from Dana Levi, an existing customer. Press 1" |
| Unknown | "Please tell us in a few words what roofing work you need and the city of the property." | Depends on the answer, below |
| ↳ roofing request, or unclear | "One moment while we connect you", rings | Whisper: "HOT lead. Roof leak. Active leak. In Beverly Hills. Press 1" |
| ↳ spam / robocall pitch / sales (SEO, lead gen, suppliers) | "We're not able to help with this request. Goodbye." | Nothing (listed by `CALLS`) |
| ↳ job seeker, non-roofing request, out of service area, renter | Asked to leave a voicemail | Text after the call, marked low priority, plus the voicemail transcript |
| ↳ says nothing (typical robocall) | Asked to leave a voicemail | Nothing, unless they leave a real message; then it's screened and texted |
| `BLOCK`ed number, or auto-blocked after 2 spam calls | Busy signal | Nothing |

If Amiram doesn't press 1 (busy, or his own voicemail picked up), the caller
is asked to leave a message and Amiram immediately gets the full lead
summary by text ("📞 Missed call"), followed by the voicemail transcript.

**Never drops a possible customer:** anything unclear rings through, and if
Claude is slow (6-second budget while the caller waits) or down, the call
rings through with "New caller, not screened."

Every call, including the filtered ones, is logged in the `calls` table; calls
where the caller described a job also become `PHONE` leads, scored by the
same rules as Yelp and website leads (`src/config/scoring.ts`).

## Amiram's commands

Text these to the system number from `OWNER_PHONE`:

| Command | Effect |
|---|---|
| `CALLS` | Last 24h: how many calls, how many rang, and each screened-out caller with what they said |
| `ALLOW 310-555-1234` | This number always rings through (family, suppliers, a misfiled customer) |
| `BLOCK 310-555-1234` | Busy signal from now on |
| `UNBLOCK 310-555-1234` | Back to normal screening (undoes BLOCK, ALLOW, or an auto-block) |

`CALLS` is the safety check for the pilot: if a real customer ever lands in
the screened-out list, Amiram can call them back and `ALLOW` them.

## Twilio setup

1. **Get calls into Twilio.** Either port the business number to Twilio, or
   keep it with the current carrier and turn on unconditional call forwarding
   to a Twilio number. Forwarding is the quicker pilot: undoing it is one
   setting on the carrier side.
2. On the Twilio number, under *Voice configuration*:
   - *A call comes in*: Webhook, `POST https://<worker>/api/voice/incoming`
   - *Call status changes*: `POST https://<worker>/api/voice/status`
3. Secrets: `TWILIO_AUTH_TOKEN` (verifies every webhook), `OWNER_PHONE`
   (the cell that rings). Without `OWNER_PHONE` the voice routes return 503.

Amiram's phone shows the **caller's** number, so a missed call can be returned
directly. Twilio charges per minute for the inbound and the forwarded leg,
plus speech recognition and voicemail transcription; check current Twilio
pricing before the pilot.

## Configuration

`src/config/callScreening.ts`: which intents are filtered vs. sent to
voicemail, which scoring disqualifiers go to voicemail, timeouts, auto-block
threshold, and every sentence callers hear. `trustKnownCustomers` skips the
question for existing customers unless the call failed STIR/SHAKEN caller ID
verification (likely spoofed).

## Measuring it

`GET /api/admin/metrics` has a `calls` section: received, rang Amiram,
answered, missed, filtered, blocked, sent to voicemail, no response, and a
count per reason (`intent:SPAM`, `intent:VENDOR_SOLICITATION`,
`rule:out_of_area`, `no_speech`, …). Compare the filtered share to the
"1 in 10" estimate after the first weeks. `GET /api/admin/calls` lists the
calls themselves.

## To confirm with Amiram

- Out-of-area callers and renters go to voicemail. Should they ring instead?
- Should calls ring him after hours, or go to voicemail + text?
- Spanish-speaking callers: the prompt and speech recognition are English
  only for now.
- Wording of the greeting (it's the first thing every new customer hears).
