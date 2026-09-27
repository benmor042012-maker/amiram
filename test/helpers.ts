import type { ExtractionRequest, ExtractionResult, LeadExtractor } from "../src/ai/LeadExtractionService";
import { emptyFacts, type Lead, type LeadFacts } from "../src/domain/lead";

export function facts(overrides: Partial<LeadFacts> = {}): LeadFacts {
  return { ...emptyFacts(), intent: "ROOFING_REQUEST", ...overrides };
}

export function lead(overrides: Partial<Lead> = {}): Lead {
  return {
    ...facts(),
    id: "lead-1",
    source: "YELP",
    externalLeadId: "yelp-1",
    createdAt: "2026-09-27T10:00:00.000Z",
    updatedAt: "2026-09-27T10:00:00.000Z",
    receivedAt: "2026-09-27T10:00:00.000Z",
    sourceCreatedAt: null,
    originalMessage: "",
    leadScore: null,
    leadReasons: [],
    serviceArea: null,
    qualificationStatus: "PENDING",
    conversationStatus: "NOT_STARTED",
    ownerNotificationStatus: "NOT_SENT",
    status: "NEW",
    aiSummary: null,
    extractionMethod: null,
    customerTurns: 0,
    firstAutomatedResponseAt: null,
    responseTimeSeconds: null,
    ownerNotifiedAt: null,
    notifiedScore: null,
    ...overrides,
  };
}

/** A controllable clock for deterministic response-time assertions. */
export class FakeClock {
  constructor(private ms = Date.parse("2026-09-27T17:00:00.000Z")) {}
  now = () => new Date(this.ms);
  advance(seconds: number) {
    this.ms += seconds * 1000;
  }
}

/**
 * Stands in for Claude: returns scripted extractions keyed by the latest
 * customer message, and simulates AI latency on the fake clock.
 */
export class ScriptedExtractor implements LeadExtractor {
  readonly requests: ExtractionRequest[] = [];

  constructor(
    private readonly script: Record<string, ExtractionResult>,
    private readonly clock?: FakeClock,
    private readonly latencySeconds = 0,
  ) {}

  async extract(request: ExtractionRequest): Promise<ExtractionResult> {
    this.requests.push(request);
    this.clock?.advance(this.latencySeconds);
    const latest = request.customerMessages[request.customerMessages.length - 1]!;
    const key = Object.keys(this.script).find((k) => latest.includes(k));
    if (!key) throw new Error(`No scripted extraction for: ${latest}`);
    return this.script[key]!;
  }
}
