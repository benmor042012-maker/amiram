import { ConversationService } from "./ai/ConversationService";
import {
  ClaudeLeadExtractionService,
  ResilientLeadExtractor,
  type LeadExtractor,
} from "./ai/LeadExtractionService";
import { LeadSummaryService } from "./ai/LeadSummaryService";
import { EventRepository } from "./db/eventRepository";
import { LeadRepository } from "./db/leadRepository";
import { MessageRepository } from "./db/messageRepository";
import type { Env } from "./env";
import { MetricsService } from "./metrics/MetricsService";
import { ConsoleNotificationProvider, type NotificationProvider } from "./notifications/NotificationProvider";
import { TwilioSmsNotificationProvider } from "./notifications/TwilioSmsNotificationProvider";
import { LeadQualificationService } from "./qualification/LeadQualificationService";
import { LeadScoringService } from "./qualification/LeadScoringService";
import { logError } from "./util/log";

export interface Services {
  leads: LeadRepository;
  messages: MessageRepository;
  events: EventRepository;
  qualification: LeadQualificationService;
  metrics: MetricsService;
}

export interface ServiceOverrides {
  extractor?: LeadExtractor;
  notifier?: NotificationProvider;
  clock?: () => Date;
}

const DEFAULT_MODEL = "claude-opus-5";

/** Composition root: builds every service from the Worker environment. */
export function createServices(env: Env, overrides: ServiceOverrides = {}): Services {
  const leads = new LeadRepository(env.DB);
  const messages = new MessageRepository(env.DB);
  const events = new EventRepository(env.DB);

  const extractor =
    overrides.extractor ??
    new ResilientLeadExtractor(
      env.ANTHROPIC_API_KEY
        ? new ClaudeLeadExtractionService(env.ANTHROPIC_API_KEY, env.CLAUDE_MODEL || DEFAULT_MODEL)
        : null,
      undefined,
      (error) => logError("extraction.failed", error),
    );

  const qualification = new LeadQualificationService({
    leads,
    messages,
    events,
    extractor,
    scoring: new LeadScoringService(),
    conversation: new ConversationService(),
    summary: new LeadSummaryService(),
    notifier: overrides.notifier ?? createNotifier(env),
    clock: overrides.clock,
  });

  return { leads, messages, events, qualification, metrics: new MetricsService(env.DB) };
}

function createNotifier(env: Env): NotificationProvider {
  if (env.NOTIFICATION_PROVIDER === "twilio") {
    const { TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER, OWNER_PHONE } = env;
    if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !TWILIO_FROM_NUMBER || !OWNER_PHONE) {
      throw new Error(
        "NOTIFICATION_PROVIDER=twilio requires TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER and OWNER_PHONE",
      );
    }
    return new TwilioSmsNotificationProvider(
      { accountSid: TWILIO_ACCOUNT_SID, authToken: TWILIO_AUTH_TOKEN, fromNumber: TWILIO_FROM_NUMBER },
      OWNER_PHONE,
    );
  }
  return new ConsoleNotificationProvider();
}
