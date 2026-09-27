/**
 * Customer SMS rules. Keywords follow the standard carrier / CTIA list.
 * Matching is on the whole message, case-insensitive ("stop", " STOP ").
 */
export const messagingConfig = {
  /**
   * Only text a website lead who ticked an SMS-consent box. Keep true unless
   * a legal review says the form's wording already covers it.
   */
  requireExplicitSmsConsent: true,
  optOutKeywords: ["STOP", "STOPALL", "UNSUBSCRIBE", "CANCEL", "END", "QUIT", "OPTOUT", "REVOKE"],
  optInKeywords: ["START", "UNSTOP", "YES"],
  /** Appended to the first automated text a customer receives. */
  firstSmsNotice: "Reply STOP to opt out.",
};
