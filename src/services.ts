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
import { OptOutRepository } from "./db/optOutRepository";
import type { Env } from "./env";
import {
  ConsoleCustomerMessaging,
  OptOutGuardedMessaging,
  TwilioCustomerMessaging,
  type CustomerMessagingProvider,
} from "./messaging/CustomerMessagingProvider";
import { SmsInboundService } from "./messaging/SmsInboundService";
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
  optOuts: OptOutRepository;
  qualification: LeadQualificationService;
  smsInbound: SmsInboundService;
  metrics: MetricsService;
}

export interface ServiceOverrides {
  extractor?: LeadExtractor;
  notifier?: NotificationProvider;
  /** Raw provider; the opt-out guard is always applied on top. */
  customerMessaging?: CustomerMessagingProvider;
  clock?: () => Date;
}

const DEFAULT_MODEL = "claude-opus-5";

/** Composition root: builds every service from the Worker environment. */
export function createServices(env: Env, overrides: ServiceOverrides = {}): Services {
  const leads = new LeadRepository(env.DB);
  const messages = new MessageRepository(env.DB);
  const events = new EventRepository(env.DB);
  const optOuts = new OptOutRepository(env.DB);

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
    customerMessaging: new OptOutGuardedMessaging(
      overrides.customerMessaging ?? createCustomerMessaging(env),
      optOuts,
    ),
    clock: overrides.clock,
  });
  const smsInbound = new SmsInboundService({ leads, events, optOuts, qualification, clock: overrides.clock });

  return { leads, messages, events, optOuts, qualification, smsInbound, metrics: new MetricsService(env.DB) };
}

function twilioConfig(env: Env, purpose: string) {
  const { TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER } = env;
  if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !TWILIO_FROM_NUMBER) {
    throw new Error(`${purpose}=twilio requires TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN and TWILIO_FROM_NUMBER`);
  }
  return { accountSid: TWILIO_ACCOUNT_SID, authToken: TWILIO_AUTH_TOKEN, fromNumber: TWILIO_FROM_NUMBER };
}

function createCustomerMessaging(env: Env): CustomerMessagingProvider {
  if (env.CUSTOMER_SMS_PROVIDER === "twilio") {
    return new TwilioCustomerMessaging(twilioConfig(env, "CUSTOMER_SMS_PROVIDER"));
  }
  return new ConsoleCustomerMessaging();
}

function createNotifier(env: Env): NotificationProvider {
  if (env.NOTIFICATION_PROVIDER === "twilio") {
    if (!env.OWNER_PHONE) throw new Error("NOTIFICATION_PROVIDER=twilio requires OWNER_PHONE");
    return new TwilioSmsNotificationProvider(twilioConfig(env, "NOTIFICATION_PROVIDER"), env.OWNER_PHONE);
  }
  return new ConsoleNotificationProvider();
}
