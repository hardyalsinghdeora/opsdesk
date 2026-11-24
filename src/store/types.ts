import type { Json } from "../core/json.ts";
import type {
  ActionRecord,
  ActionStatus,
  AuditDraft,
  AuditEntry,
  InboundEmail,
  InboundEmailInput,
  InboundStatus,
  Lead,
  Quote,
} from "../core/types.ts";

export type LeadDraft = Omit<Lead, "id" | "tenantId" | "createdAt">;
export type QuoteDraft = Omit<Quote, "id" | "tenantId" | "number" | "status" | "createdAt">;
export type ActionDraft = Pick<
  ActionRecord,
  "tool" | "input" | "preview" | "status" | "idempotencyKey" | "reason" | "requestedBy"
>;
export type ActionPatch = Partial<
  Pick<ActionRecord, "status" | "decidedBy" | "decidedAt" | "decisionNote" | "result" | "error">
>;

/**
 * Everything a request can do, already bound to one tenant. Implementations
 * must make it impossible to read or write another tenant's rows through it.
 */
export interface TenantTx {
  readonly tenantId: string;

  recordInbound(input: InboundEmailInput & { receivedAt: string }): Promise<{ record: InboundEmail; created: boolean }>;
  getInbound(id: string): Promise<InboundEmail | null>;
  updateInbound(id: string, patch: { status: InboundStatus; extraction?: Json | null; error?: string | null }): Promise<void>;

  insertLead(draft: LeadDraft): Promise<Lead>;
  listLeads(): Promise<Lead[]>;

  insertQuote(draft: QuoteDraft): Promise<Quote>;
  listQuotes(): Promise<Quote[]>;

  /** Insert, or return the existing action with the same idempotency key. */
  insertAction(draft: ActionDraft): Promise<{ record: ActionRecord; created: boolean }>;
  getAction(id: string): Promise<ActionRecord | null>;
  getActionByKey(key: string): Promise<ActionRecord | null>;
  updateAction(id: string, patch: ActionPatch): Promise<ActionRecord>;
  listActions(filter?: { status?: ActionStatus }): Promise<ActionRecord[]>;

  /** Append to the tenant's hash chain. There is no update or delete. */
  appendAudit(draft: AuditDraft): Promise<AuditEntry>;
  listAudit(): Promise<AuditEntry[]>;

  getOverrides(): Promise<Record<string, unknown>>;
  setOverrides(overrides: Record<string, unknown>): Promise<void>;

  /** Run `fn` so that a failure inside it does not poison the outer transaction. */
  attempt<T>(fn: () => Promise<T>): Promise<T>;
}

export interface Store {
  readonly kind: "memory" | "postgres";
  ensureTenant(id: string, name: string): Promise<void>;
  /** Run `fn` in one transaction scoped to `tenantId`. */
  withTenant<T>(tenantId: string, fn: (tx: TenantTx) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}
