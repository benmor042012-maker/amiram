import { Hono } from "hono";
import type { AppEnv } from "../app";
import { MANUAL_LEAD_STATUSES, type LeadStatus } from "../domain/lead";
import { LeadNotFoundError } from "../qualification/LeadQualificationService";
import { secretsMatch } from "../util/auth";

/**
 * Operational visibility for debugging the pilot. Joist stays the system of
 * record; this is intentionally not a CRM.
 */
export const adminRoutes = new Hono<AppEnv>()
  .use(async (c, next) => {
    const token = c.req.header("authorization")?.replace(/^Bearer\s+/i, "");
    if (!secretsMatch(token, c.env.ADMIN_TOKEN)) return c.json({ error: "unauthorized" }, 401);
    await next();
  })
  .get("/leads", async (c) => {
    const leads = await c.var.services.leads.list(Number(c.req.query("limit") ?? 100));
    return c.json({
      leads: leads.map((l) => ({
        id: l.id,
        score: l.leadScore,
        source: l.source,
        customer: l.name,
        service: l.serviceType,
        location: [l.city, l.zip].filter(Boolean).join(" ") || null,
        receivedAt: l.receivedAt,
        status: l.status,
        qualification: l.qualificationStatus,
        conversation: l.conversationStatus,
        ownerNotified: l.ownerNotificationStatus,
        responseTimeSeconds: l.responseTimeSeconds,
      })),
    });
  })
  .get("/leads/:id", async (c) => {
    const { leads, messages, events } = c.var.services;
    const lead = await leads.findById(c.req.param("id"));
    if (!lead) return c.json({ error: "not found" }, 404);
    return c.json({
      lead,
      messages: await messages.listForLead(lead.id),
      events: await events.listForLead(lead.id),
    });
  })
  .post("/leads/:id/status", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { status?: string };
    if (!MANUAL_LEAD_STATUSES.includes(body.status as (typeof MANUAL_LEAD_STATUSES)[number])) {
      return c.json({ error: `status must be one of ${MANUAL_LEAD_STATUSES.join(", ")}` }, 400);
    }
    try {
      const lead = await c.var.services.qualification.setStatus(c.req.param("id"), body.status as LeadStatus);
      return c.json({ id: lead.id, status: lead.status });
    } catch (error) {
      if (error instanceof LeadNotFoundError) return c.json({ error: "not found" }, 404);
      throw error;
    }
  })
  .get("/metrics", async (c) => {
    return c.json(await c.var.services.metrics.compute(c.req.query("from") ?? null, c.req.query("to") ?? null));
  });
