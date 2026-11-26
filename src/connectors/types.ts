import type { InboundEmailInput } from "../core/types.ts";

/**
 * The external systems a company connects, behind small interfaces so tools
 * and pipelines never depend on a vendor. Every interface has a fake, so the
 * whole suite runs offline and new tools can be built before the real
 * connector exists.
 */

export interface MailboxConnector {
  readonly kind: string;
  /** Messages received after `since` (ISO time), oldest first. */
  fetchNew(since?: string): Promise<InboundEmailInput[]>;
  /** Replies in the thread of `inReplyTo`. Only the executor calls this, after approval. */
  sendReply(reply: { inReplyTo: string; to: string; subject: string; text: string }): Promise<{ messageId: string }>;
}

export interface CrmContact {
  externalId: string;
  name: string | null;
  email: string | null;
  phone: string | null;
  company: string | null;
}

export interface CrmConnector {
  readonly kind: string;
  findContact(query: { email?: string; phone?: string }): Promise<CrmContact | null>;
  /** Creates or updates by email. Only the executor calls this, after the gateway allows it. */
  upsertLead(lead: { name: string | null; email: string | null; phone: string | null; summary: string; fields: Record<string, string | null> }): Promise<{ externalId: string; created: boolean }>;
}

export interface AccountingConnector {
  readonly kind: string;
  listInvoices(filter: { status?: "open" | "paid" | "overdue" }): Promise<
    { externalId: string; number: string; customerEmail: string | null; dueDate: string; totalMinor: number; currency: string; paidAt: string | null }[]
  >;
}

export interface Connectors {
  mailbox?: MailboxConnector;
  crm?: CrmConnector;
  accounting?: AccountingConnector;
}
