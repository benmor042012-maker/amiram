import type { FollowUp } from "../db/followUpRepository";
import type { NotificationProvider } from "../notifications/NotificationProvider";
import { EstimateFollowUpService, InvalidFollowUpError } from "./EstimateFollowUpService";

/*
 * Commands Amiram texts to the system number. The words are deliberately not
 * STOP / CANCEL / HELP: Twilio intercepts those itself, and a bare "STOP"
 * would opt Amiram's own phone out of the system number.
 */
const USAGE = [
  "Commands:",
  "EST <name> <phone> [#estimate]: start estimate follow-up",
  "WON <name or phone>: estimate accepted, stop follow-up",
  "DONE <name or phone>: stop follow-up",
  "LIST: active follow-ups",
].join("\n");

const PHONE_PATTERN = /(\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}/;

export class OwnerCommandService {
  constructor(
    private readonly followUps: EstimateFollowUpService,
    private readonly notifier: NotificationProvider,
  ) {}

  /** Runs one command and texts the result back to Amiram. */
  async handle(text: string): Promise<string> {
    const reply = await this.run(text.trim());
    await this.notifier.notifyOwner(reply);
    return reply;
  }

  private async run(text: string): Promise<string> {
    const [, verb = "", rest = ""] = text.match(/^(\S+)\s*([\s\S]*)$/) ?? [];
    switch (verb.toUpperCase()) {
      case "EST":
        return this.start(rest);
      case "WON":
        return this.withMatch(rest, async (f) => {
          await this.followUps.markAccepted(f);
          return `✅ ${f.customerName}: marked as accepted. No more follow-ups.`;
        });
      case "DONE":
        return this.withMatch(rest, async (f) => {
          const stopped = await this.followUps.cancel(f);
          return stopped
            ? `⏹ Follow-up for ${f.customerName} stopped.`
            : `Follow-up for ${f.customerName} was already stopped (${f.status.toLowerCase()}).`;
        });
      case "LIST":
        return this.list();
      default:
        return `Didn't understand that.\n${USAGE}`;
    }
  }

  private async start(args: string): Promise<string> {
    const phone = args.match(PHONE_PATTERN)?.[0];
    const estimateId = args.match(/#\s?(\S+)/)?.[1] ?? null;
    const name = args
      .replace(PHONE_PATTERN, " ")
      .replace(/#\s?\S+/, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (!phone || !name) return `Usage: EST <name> <phone> [#estimate]\nExample: EST John Smith 310-555-1234 #1042`;
    try {
      const { followUp, created } = await this.followUps.start({ customerName: name, phone, estimateExternalId: estimateId });
      if (!created) return `A follow-up for ${followUp.customerName} (${followUp.phoneE164}) is already active.`;
      return `👍 Follow-up started for ${followUp.customerName}${estimateId ? ` (#${estimateId})` : ""}. Texts go out on days ${this.followUps.dayOffsets.join(", ")} unless they reply. Text WON or DONE + name to stop.`;
    } catch (error) {
      if (error instanceof InvalidFollowUpError) return `Couldn't start: ${error.message}.`;
      throw error;
    }
  }

  private async withMatch(query: string, action: (f: FollowUp) => Promise<string>): Promise<string> {
    if (!query.trim()) return USAGE;
    const matches = await this.followUps.find(query);
    if (matches.length === 0) return `No follow-up found for "${query.trim()}".`;
    if (matches.length > 1) {
      const names = matches.slice(0, 5).map((f) => `${f.customerName} ${f.phoneE164}`).join("\n");
      return `More than one match, please use the phone number:\n${names}`;
    }
    return action(matches[0]!);
  }

  private async list(): Promise<string> {
    const active = await this.followUps.listActive();
    if (active.length === 0) return "No active follow-ups.";
    const total = this.followUps.stepCount;
    return [
      `Active follow-ups (${active.length}):`,
      ...active.slice(0, 10).map((f) => `${f.customerName}: ${f.followUpStep}/${total} sent`),
    ].join("\n");
  }
}
