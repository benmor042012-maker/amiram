import { Hono } from "hono";
import type { AppEnv } from "../app";
import { InvalidLeadPayloadError } from "../lead-sources/LeadSourceAdapter";
import { YelpLeadAdapter, YelpZapierReplySchema } from "../lead-sources/YelpLeadAdapter";
import { LeadNotFoundError } from "../qualification/LeadQualificationService";
import { secretsMatch } from "../util/auth";

const adapter = new YelpLeadAdapter();

/**
 * Called by Zapier. The JSON response's `reply` is what the Zap's next step
 * ("Yelp Leads: Create Message") posts into the customer's Yelp thread;
 * `send_reply` is false when nothing should be posted (Zap filter step).
 */
export const yelpRoutes = new Hono<AppEnv>()
  .use(async (c, next) => {
    if (!secretsMatch(c.req.header("x-webhook-secret"), c.env.YELP_WEBHOOK_SECRET)) {
      return c.json({ error: "unauthorized" }, 401);
    }
    await next();
  })
  .post("/leads", async (c) => {
    const body = await c.req.json().catch(() => null);
    let input;
    try {
      input = adapter.parseNewLead(body);
    } catch (error) {
      if (error instanceof InvalidLeadPayloadError) return c.json({ error: error.message }, 400);
      throw error;
    }
    const result = await c.var.services.qualification.handleNewLead(input, "YELP");
    c.executionCtx.waitUntil(result.background);
    return c.json({
      lead_id: result.lead.id,
      duplicate: result.duplicate,
      send_reply: Boolean(result.reply),
      reply: result.reply ?? "",
      lead_score: result.lead.leadScore,
    });
  })
  .post("/messages", async (c) => {
    const parsed = YelpZapierReplySchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "yelp_lead_id and message are required" }, 400);
    try {
      const result = await c.var.services.qualification.handleCustomerReply(
        "YELP",
        parsed.data.yelp_lead_id.trim(),
        parsed.data.message,
        "YELP",
      );
      c.executionCtx.waitUntil(result.background);
      return c.json({
        lead_id: result.lead.id,
        send_reply: Boolean(result.reply),
        reply: result.reply ?? "",
        lead_score: result.lead.leadScore,
      });
    } catch (error) {
      if (error instanceof LeadNotFoundError) return c.json({ error: "unknown lead" }, 404);
      throw error;
    }
  });
