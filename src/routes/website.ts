import { Hono } from "hono";
import type { AppEnv } from "../app";
import { InvalidLeadPayloadError } from "../lead-sources/LeadSourceAdapter";
import { WebsiteLeadAdapter, withContentHashId } from "../lead-sources/WebsiteLeadAdapter";
import { secretsMatch } from "../util/auth";

const adapter = new WebsiteLeadAdapter();

/**
 * Called by the website form plugin's webhook on every submission. The
 * customer gets their first text (if they consented) before this returns.
 */
export const websiteRoutes = new Hono<AppEnv>().post("/leads", async (c) => {
  const payload = await readBody(c.req.raw);
  // Some WordPress webhook plugins can't set headers, so the secret may also
  // arrive as a form field; it is stripped before the payload is stored.
  const secret = c.req.header("x-webhook-secret") ?? stringField(payload, "webhook_secret");
  if (!secretsMatch(secret, c.env.WEBSITE_WEBHOOK_SECRET)) return c.json({ error: "unauthorized" }, 401);

  let input;
  try {
    input = await withContentHashId(adapter.parseNewLead(payload));
  } catch (error) {
    if (error instanceof InvalidLeadPayloadError) return c.json({ error: error.message }, 400);
    throw error;
  }
  const result = await c.var.services.qualification.handleNewLead(input);
  c.executionCtx.waitUntil(result.background);
  return c.json({
    lead_id: result.lead.id,
    duplicate: result.duplicate,
    customer_texted: Boolean(result.lead.firstAutomatedResponseAt),
    lead_score: result.lead.leadScore,
  });
});

async function readBody(request: Request): Promise<unknown> {
  const type = request.headers.get("content-type") ?? "";
  if (type.includes("application/json")) return request.json().catch(() => null);
  if (type.includes("form")) {
    const form = await request.formData().catch(() => null);
    if (!form) return null;
    const fields: Record<string, string | string[]> = {};
    for (const [key, value] of form.entries()) {
      if (typeof value !== "string") continue; // file uploads are not handled yet
      const existing = fields[key];
      fields[key] = existing === undefined ? value : [...(Array.isArray(existing) ? existing : [existing]), value];
    }
    return fields;
  }
  return null;
}

function stringField(payload: unknown, key: string): string | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  const value = (payload as Record<string, unknown>)[key];
  return typeof value === "string" ? value : undefined;
}
