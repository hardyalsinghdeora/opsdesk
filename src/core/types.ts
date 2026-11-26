import type { Json } from "./json.ts";

export interface Contact {
  name: string | null;
  email: string | null;
  phone: string | null;
  company: string | null;
}

export type Urgency = "low" | "normal" | "high";

export interface InboundEmailInput {
  messageId: string;
  from: string;
  to: string;
  subject: string;
  text: string;
  receivedAt?: string;
}

export type InboundStatus = "received" | "processed" | "ignored" | "needs_review";

export interface InboundEmail extends InboundEmailInput {
  id: string;
  tenantId: string;
  receivedAt: string;
  status: InboundStatus;
  extraction: Json | null;
  error: string | null;
}

export interface ContactRecord extends Contact {
  id: string;
  tenantId: string;
  /** The contact's id in the company's CRM, once synced. */
  crmRef: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Lead {
  id: string;
  tenantId: string;
  contactId: string | null;
  contact: Contact;
  summary: string;
  stage: string;
  owner: string | null;
  urgency: Urgency;
  customFields: Record<string, string | null>;
  source: string;
  sourceRef: string | null;
  createdAt: string;
}

export interface QuoteLine {
  code: string;
  name: string;
  unit: string;
  quantity: number;
  unitPriceMinor: number;
  lineTotalMinor: number;
  note: string | null;
}

export interface Quote {
  id: string;
  tenantId: string;
  number: string;
  customer: { name: string | null; email: string | null };
  currency: string;
  lines: QuoteLine[];
  subtotalMinor: number;
  taxMinor: number;
  totalMinor: number;
  taxRate: number;
  validUntil: string;
  status: "issued";
  sourceRef: string | null;
  createdAt: string;
}

export type ActionStatus = "pending_approval" | "executed" | "rejected" | "failed" | "expired";

export interface ActionRecord {
  id: string;
  tenantId: string;
  tool: string;
  input: Json;
  preview: Json | null;
  status: ActionStatus;
  idempotencyKey: string;
  reason: string | null;
  requestedBy: string;
  requestedAt: string;
  decidedBy: string | null;
  decidedAt: string | null;
  decisionNote: string | null;
  result: Json | null;
  error: string | null;
}

export interface AuditDraft {
  actor: string;
  type: string;
  subject: string | null;
  data: Json;
}

export interface AuditEntry extends AuditDraft {
  tenantId: string;
  seq: number;
  id: string;
  at: string;
  prevHash: string;
  hash: string;
}

export interface StaffRecord {
  id: string;
  tenantId: string;
  email: string;
  name: string;
  role: "viewer" | "staff" | "approver" | "owner";
  createdAt: string;
  revokedAt: string | null;
}
