import { readFileSync } from "node:fs";
import path from "node:path";
import { hashToken, newToken, type Role } from "../auth/principal.ts";
import { FakeMailbox } from "../connectors/fakes.ts";
import type { InboundEmailInput } from "../core/types.ts";
import type { Extractor } from "../llm/extraction.ts";
import { createRuntime, PROJECT_ROOT, type Runtime } from "../runtime.ts";
import { MemoryStore } from "../store/memory.ts";
import { pollMailbox } from "../worker/mail-poller.ts";

/** The people in the demo. Each gets their own Claude Code window and token. */
export const DEMO_PEOPLE: { label: string; tenant: string; email: string; name: string; role: Role }[] = [
  { label: "maya", tenant: "gulfcool", email: "maya@gulfcool.example", name: "Maya (sales, GulfCool)", role: "staff" },
  { label: "omar", tenant: "gulfcool", email: "omar@gulfcool.example", name: "Omar (operations manager, GulfCool)", role: "approver" },
  { label: "lee", tenant: "northwind", email: "lee@northwind.example", name: "Lee (sales lead, Northwind)", role: "approver" },
];

const fixture = (name: string): InboundEmailInput =>
  JSON.parse(readFileSync(path.join(PROJECT_ROOT, "fixtures", "emails", `${name}.json`), "utf8"));

/** The emails, in the order the recording uses them. All people and companies are fictional. */
export const DEMO_EMAILS: { tenant: string; what: string; email: InboundEmailInput }[] = [
  { tenant: "gulfcool", what: "a quote request from a new customer", email: fixture("gulfcool-quote") },
  {
    tenant: "gulfcool",
    what: "a service problem, not a quote",
    email: {
      messageId: "<demo-priya-01@villa.example>",
      from: "Priya Nair <priya@villa.example>",
      to: "enquiries@gulfcool.example",
      subject: "Noise from the outdoor unit",
      text: "Hello,\n\nThe outdoor unit makes a loud rattling noise at night. Can someone check it this week?\n\nThanks,\nPriya Nair\n+971 50 555 0101",
    },
  },
  { tenant: "gulfcool", what: "an email that tries to give the AI orders", email: fixture("gulfcool-injection") },
  {
    tenant: "gulfcool",
    what: "the first customer again, for a second villa",
    email: {
      ...fixture("gulfcool-quote"),
      messageId: "<demo-sara-02@mail.villa.example>",
      subject: "Quote for our second villa too",
      text: "Hello again,\n\nCould you also quote duct cleaning for 3 rooms at our second villa?\nProperty type: villa, Emirate: Sharjah.\n\nThanks,\nSara Khan\n+971 50 123 4567",
    },
  },
  { tenant: "northwind", what: "a freight rate request at the second company", email: fixture("northwind-quote") },
];

const TOOL_WORDS: Record<string, string> = { "crm.create_lead": "lead", "quote.issue": "quote", "email.send_reply": "reply" };
const STATUS_WORDS: Record<string, string> = {
  executed: "done",
  pending_approval: "waiting for approval",
  rejected: "rejected",
  failed: "failed",
  expired: "expired",
};

export interface Delivered {
  index: number;
  tenant: string;
  what: string;
  subject: string;
  status: string;
  workflow: string | null;
  /** One line a viewer can follow, e.g. "lead done, quote waiting for approval (AED 1,617.00)". */
  outcome: string;
}

export interface Demo {
  rt: Runtime;
  people: (typeof DEMO_PEOPLE[number] & { token: string })[];
  remaining(): number;
  deliverNext(): Promise<Delivered | null>;
}

/**
 * The whole demo in memory: the two example companies, three people with
 * fixed tokens (so their Claude Code setup survives restarts), and a queue of
 * emails delivered one at a time to the companies' stand-in mailboxes and
 * picked up exactly as the worker would.
 */
export async function createDemo(options: { tokens?: Record<string, string>; extractor?: Extractor } = {}): Promise<Demo> {
  const rt = await createRuntime({ store: new MemoryStore(), extractor: options.extractor });
  for (const tenant of new Set(DEMO_EMAILS.map((e) => e.tenant))) {
    if (!(rt.connectors.get(tenant)?.mailbox instanceof FakeMailbox)) {
      throw new Error(`The demo needs ${tenant}'s pack to use the stand-in mailbox (mailbox: { kind: fake })`);
    }
  }

  const people = [];
  for (const p of DEMO_PEOPLE) {
    const token = options.tokens?.[p.label] ?? newToken();
    await rt.store.withTenant(p.tenant, (tx) => tx.insertStaff({ email: p.email, name: p.name, role: p.role, tokenHash: hashToken(token) }));
    people.push({ ...p, token });
  }

  let next = 0;
  let lastTime = 0;
  return {
    rt,
    people,
    remaining: () => DEMO_EMAILS.length - next,
    async deliverNext() {
      const item = DEMO_EMAILS[next];
      if (!item) return null;
      next += 1;
      // Strictly increasing, so the mailbox's saved position always moves past it.
      lastTime = Math.max(Date.now(), lastTime + 1000);
      const email = { ...item.email, receivedAt: new Date(lastTime).toISOString() };
      (rt.connectors.get(item.tenant)!.mailbox as FakeMailbox).deliver(email);
      await pollMailbox(rt, item.tenant);

      return rt.store.withTenant(item.tenant, async (tx) => {
        const inbound = (await tx.listInbound()).find((m) => m.messageId === email.messageId);
        const actions = (await tx.listActions()).filter((a) => a.idempotencyKey.startsWith(`email:${email.messageId}:`));
        const audit = await tx.listAudit();
        const routed = audit.find((e) => e.type === "email.routed" && e.subject === inbound?.id);
        const parts = actions.map((a) => {
          const total = a.tool === "quote.issue" ? ((a.preview ?? {}) as { total?: string }).total : undefined;
          return `${TOOL_WORDS[a.tool] ?? a.tool} ${STATUS_WORDS[a.status] ?? a.status}${total ? ` (${total})` : ""}`;
        });
        if (inbound?.status === "needs_review") parts.push("parked for a person to review");
        if (inbound?.status === "ignored") parts.push("ignored (not a business enquiry)");
        return {
          index: next,
          tenant: item.tenant,
          what: item.what,
          subject: email.subject,
          status: inbound?.status ?? "unknown",
          workflow: (routed?.data as { workflow?: string } | undefined)?.workflow ?? null,
          outcome: parts.join(", ") || "nothing to do",
        };
      });
    },
  };
}
