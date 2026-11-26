import { OpsdeskError } from "../core/errors.ts";
import { handleInboundEmail } from "../pipelines/email-intake.ts";
import type { Runtime } from "../runtime.ts";

export const CURSOR_KEY = "mailbox.cursor";

export interface PollResult {
  tenantId: string;
  fetched: number;
  handled: number;
  /** Set when the poll stopped early; the cursor stays before the message that failed. */
  stoppedAt: { messageId: string; reason: string } | null;
}

/**
 * Reads one company's mailbox from where the last poll stopped and feeds
 * each message through intake, oldest first. The saved position only moves
 * past a message once intake has handled it, so a failure is retried on the
 * next poll instead of being skipped. Intake ignores a Message-ID it has
 * already seen, so overlap between polls is harmless.
 */
export async function pollMailbox(rt: Runtime, tenantId: string): Promise<PollResult> {
  const result: PollResult = { tenantId, fetched: 0, handled: 0, stoppedAt: null };
  const mailbox = rt.connectors.get(tenantId)?.mailbox;
  if (!mailbox) return result;

  const cursor = await rt.store.withTenant(tenantId, (tx) => tx.getSyncState(CURSOR_KEY));
  const messages = await mailbox.fetchNew(cursor ?? undefined);
  result.fetched = messages.length;

  for (const message of messages) {
    try {
      await handleInboundEmail(rt, tenantId, message);
    } catch (error) {
      const reason = error instanceof OpsdeskError ? `${error.code}: ${error.message}` : error instanceof Error ? error.message : String(error);
      result.stoppedAt = { messageId: message.messageId, reason };
      break;
    }
    result.handled += 1;
    if (message.receivedAt && (!cursor || message.receivedAt > cursor)) {
      await rt.store.withTenant(tenantId, (tx) => tx.setSyncState(CURSOR_KEY, message.receivedAt!));
    }
  }
  return result;
}

/** One pass over every company with a mailbox. Never throws: one company's problem stops only that company. */
export async function pollAll(rt: Runtime, log: (line: string) => void = console.log): Promise<PollResult[]> {
  const results: PollResult[] = [];
  for (const tenantId of rt.source.packs.keys()) {
    if (!rt.connectors.get(tenantId)?.mailbox) continue;
    try {
      const r = await pollMailbox(rt, tenantId);
      results.push(r);
      if (r.fetched > 0 || r.stoppedAt) {
        log(`${tenantId}: ${r.handled}/${r.fetched} handled${r.stoppedAt ? `, stopped at ${r.stoppedAt.messageId} (${r.stoppedAt.reason})` : ""}`);
      }
    } catch (error) {
      log(`${tenantId}: mailbox poll failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return results;
}
