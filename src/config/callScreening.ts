import type { LeadIntent } from "../domain/lead";

/**
 * Call screening (Module 4). Unknown callers are asked one question before
 * Amiram's phone rings; what they say is extracted and scored like any lead.
 * TO CONFIRM WITH AMIRAM: which calls he wants rung through vs. sent to
 * voicemail, and the wording of the prompts.
 *
 * The rule of thumb is: never silently drop a possible customer. Anything
 * unclear rings through, and when the AI is unavailable every call rings.
 */
export const callScreeningConfig = {
  /** Seconds the caller has to start answering the screening question. */
  gatherTimeoutSeconds: 6,
  /** Hard budget for the AI while the caller waits; past it, keyword fallback. */
  aiBudgetMs: 6000,
  /** How long Amiram's phone rings before the caller goes to voicemail. */
  ringTimeoutSeconds: 20,
  /** Seconds Amiram has to press 1 after the whisper. */
  acceptTimeoutSeconds: 6,
  voicemailMaxSeconds: 120,

  /** Callers who are already leads or follow-up customers skip the question. */
  trustKnownCustomers: true,
  /** ...unless their number failed STIR/SHAKEN verification (likely spoofed). */
  screenFailedVerification: true,

  /** Polite goodbye, no voicemail, no text to Amiram (listed by CALLS). */
  filteredIntents: ["SPAM", "VENDOR_SOLICITATION"] as LeadIntent[],
  /** Not a roofing job: take a message instead of ringing. */
  voicemailIntents: ["JOB_SEEKER", "UNRELATED"] as LeadIntent[],
  /** Roofing requests that fail these rules (config/scoring.ts ids) go to voicemail. */
  voicemailDisqualifiers: ["out_of_area", "renter"],
  /**
   * A number the AI heard spam from this many times is blocked for good
   * (Amiram can UNBLOCK it). 0 disables auto-blocking.
   */
  autoBlockAfterSpamCalls: 2,

  /** Twilio speech-recognition hints. */
  speechHints: "roof, roofing, leak, leaking, repair, replacement, new roof, inspection, estimate, shingle, tile, flat roof",
};

/** What callers and Amiram hear. Keep free of prices, diagnoses or promises. */
export const callScripts = {
  voice: "Polly.Joanna" as const,
  greeting:
    "Thanks for calling Family Roofing. So we can get you to the right person, " +
    "please tell us in a few words what roofing work you need and the city of the property.",
  thanksConnecting: "Thank you. One moment while we connect you.",
  connecting: "Thanks for calling Family Roofing. Connecting you now.",
  noResponse:
    "We didn't catch that. If you're calling about a roofing project, please leave your name, " +
    "number, and what you need after the tone.",
  voicemail:
    "Thanks. Amiram isn't available right now. Please leave your name, number, " +
    "and a short message after the tone, and he'll get back to you.",
  missed:
    "Sorry, Amiram couldn't get to the phone. Please leave your name, number, " +
    "and a short message after the tone, and he'll call you back.",
  filtered: "Thanks for calling Family Roofing. We're not able to help with this request. Goodbye.",
  voicemailThanks: "Thank you, we got your message. Goodbye.",
  /** Whisper Amiram hears before the caller is connected. */
  whisperAccept: "Press 1 to take the call.",
};
