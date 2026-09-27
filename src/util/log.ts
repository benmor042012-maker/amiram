/**
 * Structured logging. Pass ids, statuses and counts only: never secrets, and
 * no customer names, phone numbers, emails, addresses or message text.
 */
export function log(event: string, fields: Record<string, string | number | boolean | null | undefined> = {}): void {
  console.log(JSON.stringify({ event, ...fields }));
}

export function logError(event: string, error: unknown, fields: Record<string, string | number | null | undefined> = {}): void {
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  console.error(JSON.stringify({ event, error: message.slice(0, 300), ...fields }));
}
