import { describe, expect, it } from "vitest";
import { ConversationService } from "../src/ai/ConversationService";
import { FallbackLeadExtractor, ResilientLeadExtractor } from "../src/ai/LeadExtractionService";
import { lead } from "./helpers";

const conversation = new ConversationService();

describe("ConversationService", () => {
  it("only asks for what the customer has not already told us", () => {
    const reply = conversation.buildFirstReply(
      lead({ name: "John Smith", serviceType: "ROOF_LEAK", activeLeak: true, homeOwner: true, city: "Beverly Hills" }),
    )!;
    expect(reply).toContain("Hi John");
    expect(reply).toContain("Sorry to hear about the leak");
    expect(reply).toContain("property address");
    expect(reply).toContain("best phone number");
    expect(reply).not.toMatch(/own the property|actively coming in|kind of roofing help/);
  });

  it("asks at most three questions in one message", () => {
    const reply = conversation.buildFirstReply(lead())!;
    expect(reply.match(/^• /gm)).toHaveLength(3);
  });

  it("asks nothing when everything is known", () => {
    const complete = lead({
      serviceType: "ROOF_REPAIR", zip: "90046", phone: "310-555-0101", homeOwner: true,
      activeLeak: false, preferredContactTime: "weekday mornings",
    });
    expect(conversation.buildFirstReply(complete)).toContain("We have what we need");
    expect(conversation.qualificationStatus(complete)).toBe("COMPLETE");
    expect(conversation.expectsAnswer(complete)).toBe(false);
  });

  it("does not use a masked Yelp phone number as a callback number", () => {
    expect(conversation.missingQuestions(lead({ phone: "(310) xxx-xx12" })).map((q) => q.id)).toContain("phone");
  });

  it("treats job seekers and spam as non-leads", () => {
    expect(conversation.qualificationStatus(lead({ intent: "JOB_SEEKER" }))).toBe("NOT_A_LEAD");
    expect(conversation.buildFirstReply(lead({ intent: "SPAM" }))).toBeNull();
    expect(conversation.buildFirstReply(lead({ intent: "VENDOR_SOLICITATION" }))).toBeNull();
  });

  it("stops asking after the configured number of customer turns", () => {
    const reply = conversation.buildFollowUpReply(lead({ customerTurns: 2, conversationStatus: "CUSTOMER_REPLIED" }))!;
    expect(reply).toContain("We have what we need");
    expect(reply).not.toContain("•");
  });
});

describe("extraction fallback", () => {
  it("falls back to conservative extraction when the AI call fails", async () => {
    const failing = { extract: async () => { throw new Error("API down"); } };
    let logged = false;
    const extractor = new ResilientLeadExtractor(failing, new FallbackLeadExtractor(), () => { logged = true; });
    const result = await extractor.extract({
      customerMessages: ["Roof is leaking, call me at 310-555-0199, zip 90210"],
      knownFacts: {},
    });
    expect(logged).toBe(true);
    expect(result.method).toBe("FALLBACK");
    expect(result.facts).toMatchObject({ serviceType: "ROOF_LEAK", phone: "310-555-0199", zip: "90210" });
    // Never infers urgency or ownership without the AI.
    expect(result.facts.activeLeak).toBeUndefined();
    expect(result.facts.homeOwner).toBeUndefined();
  });
});
