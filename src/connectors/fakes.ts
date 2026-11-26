import type { InboundEmailInput } from "../core/types.ts";
import type { AccountingConnector, CrmConnector, CrmContact, MailboxConnector } from "./types.ts";

/** A mailbox held in memory. Tests and the demo put messages in; sent replies are recorded. */
export class FakeMailbox implements MailboxConnector {
  readonly kind = "fake";
  readonly inbox: InboundEmailInput[] = [];
  readonly sent: { inReplyTo: string; to: string; subject: string; text: string; messageId: string }[] = [];

  deliver(message: InboundEmailInput): void {
    this.inbox.push(message);
  }

  async fetchNew(since?: string): Promise<InboundEmailInput[]> {
    const after = since ? Date.parse(since) : -Infinity;
    return this.inbox
      .filter((m) => Date.parse(m.receivedAt ?? "1970-01-01T00:00:00Z") > after)
      .sort((a, b) => Date.parse(a.receivedAt ?? "0") - Date.parse(b.receivedAt ?? "0"))
      .map((m) => structuredClone(m));
  }

  async sendReply(reply: { inReplyTo: string; to: string; subject: string; text: string }): Promise<{ messageId: string }> {
    const messageId = `<fake-${this.sent.length + 1}@opsdesk.test>`;
    this.sent.push({ ...reply, messageId });
    return { messageId };
  }
}

/** A CRM held in memory, keyed by email like most CRMs' upsert. */
export class FakeCrm implements CrmConnector {
  readonly kind = "fake";
  readonly contacts = new Map<string, CrmContact & { summary?: string; fields?: Record<string, string | null> }>();
  private next = 1;

  async findContact(query: { email?: string; phone?: string }): Promise<CrmContact | null> {
    for (const c of this.contacts.values()) {
      if ((query.email && c.email?.toLowerCase() === query.email.toLowerCase()) || (query.phone && c.phone === query.phone)) {
        return structuredClone(c);
      }
    }
    return null;
  }

  async upsertLead(lead: Parameters<CrmConnector["upsertLead"]>[0]): Promise<{ externalId: string; created: boolean }> {
    const key = lead.email?.toLowerCase() ?? `no-email-${this.next}`;
    const existing = this.contacts.get(key);
    const externalId = existing?.externalId ?? `fake-crm-${this.next++}`;
    this.contacts.set(key, {
      externalId,
      name: lead.name,
      email: lead.email,
      phone: lead.phone,
      company: existing?.company ?? null,
      summary: lead.summary,
      fields: lead.fields,
    });
    return { externalId, created: !existing };
  }
}

/** An accounting system held in memory, for "who paid late" style tests. */
export class FakeAccounting implements AccountingConnector {
  readonly kind = "fake";
  readonly invoices: Awaited<ReturnType<AccountingConnector["listInvoices"]>> = [];

  async listInvoices(filter: { status?: "open" | "paid" | "overdue" }) {
    const today = new Date().toISOString().slice(0, 10);
    return structuredClone(
      this.invoices.filter((inv) => {
        if (!filter.status) return true;
        if (filter.status === "paid") return inv.paidAt !== null;
        if (filter.status === "open") return inv.paidAt === null;
        return inv.paidAt === null && inv.dueDate < today;
      }),
    );
  }
}
