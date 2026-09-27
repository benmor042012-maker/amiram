/**
 * Estimate follow-up sequence. Edit the wording and timing here; the
 * follow-up service contains no customer-facing text.
 * {firstName} is replaced with the customer's first name.
 */
export const followUpConfig = {
  steps: [
    {
      dayOffset: 1,
      template:
        "Hi {firstName}, this is Family Roofing. Just checking that you received your roofing estimate. Let us know if you have any questions.",
    },
    {
      dayOffset: 3,
      template:
        "Hi {firstName}, just following up on your roofing estimate. If you'd like, Amiram can go over the scope, timing, or next steps with you.",
    },
    {
      dayOffset: 7,
      template:
        "Hi {firstName}, checking in one last time regarding your roofing project. Let us know if you'd like to move forward or have any questions.",
    },
  ],
  /** Texts are only sent between these local hours (start inclusive, end exclusive). */
  sendWindow: { timeZone: "America/Los_Angeles", startHour: 9, endHour: 18 },
  /** Appended to the first follow-up text. */
  firstMessageNotice: "Reply STOP to opt out.",
  /** How far back WON / DONE commands look for a matching follow-up. */
  commandLookbackDays: 60,
};

export type FollowUpConfig = typeof followUpConfig;
