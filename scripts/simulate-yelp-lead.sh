#!/usr/bin/env bash
# Sends the step-9 example Yelp lead to a running Worker (default: wrangler dev)
# and prints the reply, the stored lead, and the pilot metrics.
#
#   npm run dev      # in another terminal, with ANTHROPIC_API_KEY in .dev.vars
#   scripts/simulate-yelp-lead.sh
set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:8787}"
YELP_WEBHOOK_SECRET="${YELP_WEBHOOK_SECRET:?set YELP_WEBHOOK_SECRET}"
ADMIN_TOKEN="${ADMIN_TOKEN:?set ADMIN_TOKEN}"
LEAD_ID="sim-$(date +%s)"

echo "== New Yelp lead ($LEAD_ID)"
RESPONSE=$(curl -sS -X POST "$BASE_URL/api/yelp/leads" \
  -H 'content-type: application/json' -H "x-webhook-secret: $YELP_WEBHOOK_SECRET" \
  -d "{\"yelp_lead_id\":\"$LEAD_ID\",\"customer_name\":\"John Smith\",\"message\":\"Hi, we have water leaking through our bedroom ceiling in Beverly Hills. We own the house and need someone as soon as possible.\"}")
echo "$RESPONSE"
ID=$(echo "$RESPONSE" | sed -E 's/.*"lead_id":"([^"]+)".*/\1/')

sleep 1
echo; echo "== Stored lead"
curl -sS "$BASE_URL/api/admin/leads/$ID" -H "authorization: Bearer $ADMIN_TOKEN"
echo; echo; echo "== Metrics"
curl -sS "$BASE_URL/api/admin/metrics" -H "authorization: Bearer $ADMIN_TOKEN"
echo
