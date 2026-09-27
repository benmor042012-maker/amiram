import { describe, expect, it } from "vitest";
import { LeadScoringService } from "../src/qualification/LeadScoringService";
import { facts } from "./helpers";

const scoring = new LeadScoringService();

describe("LeadScoringService", () => {
  it("scores an active leak at a homeowner's property in the service area as HOT", () => {
    const result = scoring.score(
      facts({ serviceType: "ROOF_LEAK", activeLeak: true, emergency: true, homeOwner: true, desiredTimeframe: "ASAP", city: "Beverly Hills" }),
    );
    expect(result.leadScore).toBe("HOT");
    expect(result.serviceArea).toBe("IN_AREA");
    expect(result.leadReasons).toEqual(
      expect.arrayContaining(["Active water leak", "Emergency / urgent request", "Roof leak", "Homeowner", "Short timeframe", "In service area"]),
    );
  });

  it("scores a homeowner's roof replacement as HOT", () => {
    expect(scoring.score(facts({ serviceType: "ROOF_REPLACEMENT", homeOwner: true })).leadScore).toBe("HOT");
  });

  it("scores a commercial project as HOT when timing is short", () => {
    expect(scoring.score(facts({ serviceType: "COMMERCIAL_ROOFING", desiredTimeframe: "WITHIN_WEEK" })).leadScore).toBe("HOT");
  });

  it("scores a non-urgent repair as WARM", () => {
    expect(scoring.score(facts({ serviceType: "ROOF_REPAIR", homeOwner: true, desiredTimeframe: "WITHIN_MONTH" })).leadScore).toBe("WARM");
  });

  it("scores a planned future replacement as WARM", () => {
    const result = scoring.score(facts({ serviceType: "ROOF_REPLACEMENT", homeOwner: true, desiredTimeframe: "LATER" }));
    expect(result.leadScore).toBe("WARM");
    expect(result.leadReasons).toContain("Planned for later (3+ months)");
  });

  it("scores a routine inspection as WARM", () => {
    expect(scoring.score(facts({ serviceType: "ROOF_INSPECTION", inspectionRequested: true })).leadScore).toBe("WARM");
  });

  it.each([
    ["JOB_SEEKER", "Employment inquiry"],
    ["VENDOR_SOLICITATION", "Vendor / sales solicitation"],
    ["SPAM", "Spam"],
    ["UNRELATED", "Not a roofing request"],
  ] as const)("forces LOW for %s regardless of other signals", (intent, reason) => {
    const result = scoring.score(facts({ intent, serviceType: "ROOF_LEAK", activeLeak: true }));
    expect(result.leadScore).toBe("LOW");
    expect(result.leadReasons).toContain(reason);
  });

  it("forces LOW outside the service area", () => {
    const result = scoring.score(facts({ serviceType: "ROOF_LEAK", activeLeak: true, zip: "94103" }));
    expect(result).toMatchObject({ leadScore: "LOW", serviceArea: "OUT_OF_AREA" });
  });

  it("forces LOW for a renter without the owner involved", () => {
    expect(scoring.score(facts({ serviceType: "ROOF_REPAIR", homeOwner: false })).leadScore).toBe("LOW");
  });

  it("does not penalize an unrecognized city", () => {
    const result = scoring.score(facts({ serviceType: "ROOF_REPLACEMENT", homeOwner: true, city: "Somewhere Small" }));
    expect(result).toMatchObject({ leadScore: "HOT", serviceArea: "UNKNOWN" });
    expect(result.leadReasons).toContain("Location not confirmed");
  });

  it("is deterministic", () => {
    const input = facts({ serviceType: "ROOF_REPAIR", homeOwner: true, zip: "90046" });
    expect(scoring.score(input)).toEqual(scoring.score(input));
  });

  it("evaluates service area by ZIP first", () => {
    expect(scoring.evaluateServiceArea({ zip: "90210", city: null, state: null })).toBe("IN_AREA");
    expect(scoring.evaluateServiceArea({ zip: "10001", city: "Beverly Hills", state: null })).toBe("OUT_OF_AREA");
    expect(scoring.evaluateServiceArea({ zip: null, city: null, state: "NV" })).toBe("OUT_OF_AREA");
    expect(scoring.evaluateServiceArea({ zip: null, city: "Santa Monica", state: "CA" })).toBe("IN_AREA");
  });
});
