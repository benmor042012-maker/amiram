import type { Call, CallRepository } from "../db/callRepository";
import type { FollowUp } from "../db/followUpRepository";
import type { NotificationProvider } from "../notifications/NotificationProvider";
import { toE164 } from "../util/phone";
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
  "CALLS: calls screened out in the last 24h",
  "BLOCK / ALLOW / UNBLOCK <phone>: caller rules",
].join("\n");

const PHONE_PATTERN = /(\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}/;

export class OwnerCommandService {
  constructor(
    private readonly followUps: EstimateFollowUpService,
    private readonly notifier: NotificationProvider,
    private readonly calls?: CallRepository,
    private readonly clock: () => Date = () => new Date(),
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
      case "CALLS":
        return this.screenedCalls();
      case "BLOCK":
      case "ALLOW":
        return this.setCallerRule(verb.toUpperCase() as "BLOCK" | "ALLOW", rest);
      case "UNBLOCK":
        return this.clearCallerRule(rest);
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

  /** Calls that did not ring Amiram, so he can spot a real customer. */
  private async screenedCalls(): Promise<string> {
    if (!this.calls) return "Call screening is not set up.";
    const since = new Date(this.clock().getTime() - 24 * 3600_000).toISOString();
    const calls = await this.calls.listSince(since);
    const rang = calls.filter((c) => c.decision === "RING" || c.decision === "KNOWN_CALLER").length;
    const out = calls.filter((c) => SCREENED_OUT.has(c.decision));
    const lines = [`Calls (24h): ${calls.length} total, ${rang} rang you, ${out.length} screened out.`];
    for (const c of out.slice(0, 8)) lines.push(`• ${c.fromE164 ?? "withheld"}: ${describeCall(c)}`);
    if (out.length > 8) lines.push(`…and ${out.length - 8} more`);
    if (out.length > 0) lines.push("Wrongly screened? Text ALLOW <phone>.");
    return lines.join("\n");
  }

  private async setCallerRule(rule: "BLOCK" | "ALLOW", args: string): Promise<string> {
    const phone = toE164(args.match(PHONE_PATTERN)?.[0]);
    if (!this.calls) return "Call screening is not set up.";
    if (!phone) return `Usage: ${rule} <phone>\nExample: ${rule} 310-555-1234`;
    await this.calls.setRule(phone, rule, "OWNER", this.clock().toISOString(), null);
    return rule === "BLOCK"
      ? `🚫 ${phone} is blocked: their calls won't ring. Text UNBLOCK ${phone} to undo.`
      : `✅ ${phone} always rings through now. Text UNBLOCK ${phone} to undo.`;
  }

  private async clearCallerRule(args: string): Promise<string> {
    const phone = toE164(args.match(PHONE_PATTERN)?.[0]);
    if (!this.calls) return "Call screening is not set up.";
    if (!phone) return "Usage: UNBLOCK <phone>";
    return (await this.calls.clearRule(phone))
      ? `${phone} is back to normal screening.`
      : `${phone} wasn't blocked or allowed.`;
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

const SCREENED_OUT = new Set<Call["decision"]>(["FILTERED", "BLOCKED", "VOICEMAIL", "NO_RESPONSE"]);

const REASON_LABEL: Record<string, string> = {
  "intent:SPAM": "spam",
  "intent:VENDOR_SOLICITATION": "sales call",
  "intent:JOB_SEEKER": "job inquiry",
  "intent:UNRELATED": "not roofing",
  "rule:out_of_area": "out of area",
  "rule:renter": "renter",
  blocklist: "blocked number",
  no_speech: "didn't answer the question",
};

function describeCall(call: Call): string {
  const reason = (call.reason && REASON_LABEL[call.reason]) ?? call.reason ?? call.decision.toLowerCase();
  const said = call.speech ?? call.voicemailTranscript;
  const voicemail = call.outcome === "VOICEMAIL" ? " (left voicemail)" : "";
  return `${reason}${voicemail}${said ? ` "${said.length > 60 ? `${said.slice(0, 59)}…` : said}"` : ""}`;
}
