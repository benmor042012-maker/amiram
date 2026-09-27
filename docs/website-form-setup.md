# Website form → Lead Automation setup

The website form keeps working exactly as today (Amiram still gets the usual
email). In addition, the form plugin posts each submission to our Worker,
which texts the customer (if they consented), qualifies and scores the lead,
and texts Amiram.

## 1. Send submissions to the Worker

**Still to confirm:** which form plugin familyroofinginc.com uses. Most can
send a webhook:

| Plugin | How |
|---|---|
| WPForms | *Webhooks* addon (Pro/Elite) → Request URL, JSON body |
| Gravity Forms | *Webhooks Add-On* → POST, JSON, all fields |
| Contact Form 7 | a webhook plugin such as "CF7 to Webhook" |
| Elementor Forms | *Actions After Submit* → Webhook (sends form-encoded fields) |

- URL: `https://<worker-host>/api/website/leads`
- Auth: header `x-webhook-secret: <WEBSITE_WEBHOOK_SECRET>`. If the plugin
  can't set headers, add a hidden field named `webhook_secret` with the same
  value; it is removed before the submission is stored.
- JSON and form-encoded bodies both work.

Field names are matched loosely (`src/config/websiteForm.ts`): `name` /
`your-name` / `First Name`+`Last Name`, `phone` / `your-tel`, `email`,
`address`, `city`, `zip`, `service`, `message` / `your-message`, `sms_consent`,
`entry_id`. Once we see the real form, add its exact field names there.

A submission needs a phone or an email, and a message or a service.

## 2. SMS consent checkbox (required before texting customers)

Customers are only texted if the form sends an affirmative SMS-consent value
(`requireExplicitSmsConsent` in `src/config/messaging.ts`). Add an optional
checkbox named `sms_consent`, for example:

> ☐ Text me about my request. Msg & data rates may apply. Reply STOP to opt out.

Without it, the lead is still scored and Amiram is notified immediately, with
a note that the customer was not texted.

## 3. Twilio

- Buy a local number and complete **A2P 10DLC** registration (brand + campaign).
  Customer texting only works once the campaign is approved.
- Number → Messaging → "A message comes in" → Webhook POST
  `https://<worker-host>/api/sms/inbound`. Requests are verified with the
  `X-Twilio-Signature` header using `TWILIO_AUTH_TOKEN`.
- Keep Twilio's Advanced Opt-Out enabled: Twilio replies to STOP/HELP itself;
  we record the opt-out and never text that number again until it sends START.
- Set `CUSTOMER_SMS_PROVIDER=twilio` (and `NOTIFICATION_PROVIDER=twilio`).
