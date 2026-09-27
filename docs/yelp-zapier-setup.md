# Yelp → Zapier → Lead Automation setup

Yelp's Leads API is only available to official Yelp partners. A single business
connects through **Yelp's official "Yelp Leads" app on Zapier**, signing in
with its own Yelp Business account. No scraping, no unofficial access.

## Prerequisites

- Claimed Yelp business page with **Request-a-Quote** enabled.
- Zapier account.
- Amiram's Yelp Business login (to connect the Yelp Leads app in Zapier).
- This Worker deployed, with `YELP_WEBHOOK_SECRET` set.
- Optional: Yelp's phone allowlisting form, if Amiram wants to call Yelp's masked numbers.

## Zap 1: new lead → instant reply

1. **Trigger:** Yelp Leads → *New Lead*.
2. **Action:** Webhooks by Zapier → *POST*
   - URL: `https://<worker-host>/api/yelp/leads`
   - Payload type: JSON
   - Headers: `x-webhook-secret: <YELP_WEBHOOK_SECRET>`
   - Data (map from the trigger / *Get Lead Details*):

     | Key | Yelp field |
     |---|---|
     | `yelp_lead_id` (required) | Lead ID |
     | `message` | Customer's message text |
     | `customer_name` | Customer display name |
     | `job_type` | Job / service name(s) |
     | `survey_answers` | Request-a-Quote answers (any text form) |
     | `zip`, `city` | Location, if provided |
     | `phone`, `email` | If provided (phone may be masked) |
     | `created_at` | Lead creation time |

   At least one of `message`, `job_type` or `survey_answers` must be present.
   Field names on the Yelp side are chosen in the Zap editor; confirm them
   against a real test lead.
3. **Filter:** only continue if `send_reply` is `true`.
4. **Action:** Yelp Leads → *Create Message*, body = `reply` from step 2.
5. *(Optional)* Yelp Leads → *Mark Lead as Replied*.

The response time we measure runs from when our endpoint receives the lead to
when it returns the reply. `sourceToResponseSeconds` (in the lead's events)
also includes Yelp → Zapier delay when `created_at` is mapped.

## Zap 2: customer replies (only if Zapier offers a trigger for it)

**Not yet verified:** whether the Yelp Leads app has a trigger for new
customer messages in an existing lead. If it does:

1. **Trigger:** Yelp Leads → new message event (customer messages only).
2. **Action:** Webhooks by Zapier → POST `https://<worker-host>/api/yelp/messages`
   with `{ "yelp_lead_id": ..., "message": ... }` and the same secret header.
3. **Filter:** `send_reply` is `true`.
4. **Action:** Yelp Leads → *Create Message* with `reply`.

If no such trigger exists, the first message already asks for everything that
is missing in one go. The customer's answers arrive in Yelp as usual, and
Amiram is notified within 10 minutes (sooner for HOT leads) either way.

## Test before going live

Run Zap 1's test with a sample lead, then check
`GET /api/admin/leads` (Bearer `ADMIN_TOKEN`) to see the stored lead, score and reply.
