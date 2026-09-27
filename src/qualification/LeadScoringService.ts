import { scoringConfig } from "../config/scoring";
import { serviceAreaConfig } from "../config/serviceArea";
import type { LeadFacts, LeadScore, ServiceAreaStatus } from "../domain/lead";

export interface ScoreResult {
  leadScore: LeadScore;
  leadReasons: string[];
  points: number;
  serviceArea: ServiceAreaStatus;
}

/**
 * Deterministic scoring: the same facts always give the same score. No AI is
 * involved; rules live in config/scoring.ts.
 */
export class LeadScoringService {
  constructor(
    private readonly config = scoringConfig,
    private readonly area = serviceAreaConfig,
  ) {}

  score(facts: LeadFacts): ScoreResult {
    const serviceArea = this.evaluateServiceArea(facts);
    const context = { ...facts, serviceArea };

    const disqualifiers = this.config.disqualifiers.filter((d) => d.when(context));
    if (disqualifiers.length > 0) {
      return { leadScore: "LOW", leadReasons: disqualifiers.map((d) => d.reason), points: 0, serviceArea };
    }

    const matched = this.config.signals.filter((s) => s.when(context));
    const points = matched.reduce((sum, s) => sum + s.points, 0);
    const { hot, warm } = this.config.thresholds;
    const leadScore: LeadScore = points >= hot ? "HOT" : points >= warm ? "WARM" : "LOW";

    const leadReasons = matched.map((s) => s.reason);
    if (serviceArea === "UNKNOWN") leadReasons.push("Location not confirmed");
    if (matched.length === 0) leadReasons.push("Not enough information yet");
    return { leadScore, leadReasons, points, serviceArea };
  }

  evaluateServiceArea(facts: Pick<LeadFacts, "zip" | "city" | "state">): ServiceAreaStatus {
    const zip = facts.zip?.match(/\d{5}/)?.[0];
    if (zip) return this.area.zipPrefixes.includes(zip.slice(0, 3)) ? "IN_AREA" : "OUT_OF_AREA";

    const state = facts.state?.trim().toUpperCase();
    if (state && state !== this.area.state && state !== "CALIFORNIA") return "OUT_OF_AREA";

    const city = facts.city?.trim().toLowerCase();
    if (city && this.area.cities.includes(city)) return "IN_AREA";
    return "UNKNOWN";
  }
}
