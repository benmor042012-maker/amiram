import { describe, expect, it } from "vitest";
import { ClaudeLeadExtractionService, type Extraction } from "../src/ai/LeadExtractionService";

const extraction: Extraction = {
  name: null, phone: null, email: null, address: null, city: "Beverly Hills", state: "CA", zip: null,
  serviceType: "ROOF_LEAK", problemDescription: "Water leaking through bedroom ceiling",
  activeLeak: true, emergency: true, homeOwner: null, renterWithoutOwner: true, inspectionRequested: null,
  roofType: null, roofAge: null, desiredTimeframe: "ASAP", preferredContactTime: null,
  intent: "ROOFING_REQUEST", summary: "Renter reports an active leak.",
};

function fakeApi(stopReason = "end_turn") {
  const calls: { headers: Headers; body: any }[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) });
    return new Response(
      JSON.stringify({
        id: "msg_1", type: "message", role: "assistant", model: "claude-opus-5",
        content: [{ type: "text", text: JSON.stringify(extraction) }],
        stop_reason: stopReason, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;
  return { calls, fetchImpl };
}

describe("ClaudeLeadExtractionService", () => {
  it("requests schema-constrained output and maps the result", async () => {
    const { calls, fetchImpl } = fakeApi();
    const service = new ClaudeLeadExtractionService("test-key", "claude-opus-5", fetchImpl);
    const result = await service.extract({ customerMessages: ["Water leaking into the bedroom, I rent"], knownFacts: { name: "Ann", zip: null } });

    const { headers, body } = calls[0]!;
    expect(body.model).toBe("claude-opus-5");
    expect(body.output_config.effort).toBe("low");
    expect(body.output_config.format.type).toBe("json_schema");
    expect(body.fallbacks).toBe("default");
    expect(headers.get("anthropic-beta")).toContain("server-side-fallback-2026-07-01");
    expect(body.messages[0].content).toContain('{"name":"Ann"}'); // null known facts omitted
    expect(body.messages[0].content).toContain("Water leaking into the bedroom");

    expect(result.method).toBe("AI");
    expect(result.summary).toBe("Renter reports an active leak.");
    expect(result.facts).toMatchObject({ serviceType: "ROOF_LEAK", activeLeak: true, homeOwner: false });
    expect(result.facts).not.toHaveProperty("renterWithoutOwner");
  });

  it("throws on a refusal so the caller can fall back", async () => {
    const { fetchImpl } = fakeApi("refusal");
    const service = new ClaudeLeadExtractionService("test-key", "claude-opus-5", fetchImpl);
    await expect(service.extract({ customerMessages: ["x"], knownFacts: {} })).rejects.toThrow(/refusal/);
  });
});
