import {
  conversationConfig,
  customerMessages,
  qualificationQuestions,
  type QualificationQuestion,
} from "../config/conversation";
import type { Lead, QualificationStatus } from "../domain/lead";

/**
 * Decides what to say to the customer next.
 *
 * Replies are assembled from configured templates rather than written freely
 * by the AI: the AI's job is understanding what the customer already said
 * (so we never re-ask it), and the wording the customer sees stays fixed and
 * reviewable. That guarantees no prices, diagnoses, or promises.
 */
export class ConversationService {
  constructor(
    private readonly questions = qualificationQuestions,
    private readonly config = conversationConfig,
    private readonly text = customerMessages,
  ) {}

  isRealLead(lead: Lead): boolean {
    return lead.intent === null || lead.intent === "ROOFING_REQUEST" || lead.intent === "UNCLEAR";
  }

  missingQuestions(lead: Lead): QualificationQuestion[] {
    return this.questions.filter(
      (q) => (!q.sources || q.sources.includes(lead.source)) && q.missing(lead),
    );
  }

  qualificationStatus(lead: Lead): QualificationStatus {
    if (!this.isRealLead(lead)) return "NOT_A_LEAD";
    return this.missingQuestions(lead).some((q) => q.essential) ? "PARTIAL" : "COMPLETE";
  }

  /** First automated response to a new lead; null means send nothing. */
  buildFirstReply(lead: Lead): string | null {
    if (!this.isRealLead(lead)) {
      return lead.intent ? (this.text.nonLeadReplies[lead.intent] ?? null) : null;
    }
    const urgent = lead.activeLeak === true || lead.emergency === true;
    const ack = lead.activeLeak === true
      ? this.text.urgentLeakAck
      : urgent
        ? this.text.urgentAck
        : this.text.standardAck;
    return [this.greeting(lead), ack, this.questionsOrAllSet(lead)].join(" ");
  }

  /**
   * Reply after the customer answered. Returns null once the short
   * qualification exchange is over (the customer's messages then go
   * straight to Amiram instead).
   */
  buildFollowUpReply(lead: Lead): string | null {
    if (!this.isRealLead(lead) || lead.conversationStatus === "CLOSED") return null;
    if (lead.customerTurns >= this.config.maxCustomerTurns) {
      return `${this.text.followUpThanks} ${this.text.allSet}`;
    }
    return `${this.text.followUpThanks} ${this.questionsOrAllSet(lead)}`;
  }

  /** Whether the reply just built still expects an answer from the customer. */
  expectsAnswer(lead: Lead): boolean {
    return (
      this.isRealLead(lead) &&
      lead.customerTurns < this.config.maxCustomerTurns &&
      this.missingQuestions(lead).length > 0
    );
  }

  private questionsOrAllSet(lead: Lead): string {
    const questions = this.missingQuestions(lead).slice(0, this.config.maxQuestionsPerMessage);
    if (questions.length === 0) return this.text.allSet;
    return `${this.text.askIntro}\n${questions.map((q) => `• ${q.ask}`).join("\n")}`;
  }

  private greeting(lead: Lead): string {
    const firstName = lead.name?.trim().split(/\s+/)[0];
    return firstName
      ? this.text.greeting.replace("{firstName}", firstName)
      : this.text.greetingNoName;
  }
}
