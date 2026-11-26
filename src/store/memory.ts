import { randomUUID } from "node:crypto";
import { sealAuditEntry } from "../audit/chain.ts";
import { ConflictError, NotFoundError } from "../core/errors.ts";
import type { Principal } from "../auth/principal.ts";
import type { ActionRecord, AuditEntry, ContactRecord, InboundEmail, Lead, Quote, StaffRecord } from "../core/types.ts";
import type { Store, TenantTx } from "./types.ts";

interface TenantState {
  name: string;
  inbound: InboundEmail[];
  leads: Lead[];
  quotes: Quote[];
  actions: ActionRecord[];
  audit: AuditEntry[];
  overrides: Record<string, unknown>;
  staff: (StaffRecord & { tokenHash: string })[];
  contacts: ContactRecord[];
  sync: Record<string, string>;
}

const clone = <T>(value: T): T => structuredClone(value);

/**
 * In-process store for the demo, local development and fast tests. Each
 * transaction works on a copy of the tenant's state and commits on success,
 * so failed requests leave nothing behind, like the Postgres store.
 */
export class MemoryStore implements Store {
  readonly kind = "memory";
  private readonly tenants = new Map<string, TenantState>();
  private readonly locks = new Map<string, Promise<unknown>>();
  private readonly clock: () => Date;

  constructor(clock: () => Date = () => new Date()) {
    this.clock = clock;
  }

  async ensureTenant(id: string, name: string): Promise<void> {
    if (!this.tenants.has(id)) {
      this.tenants.set(id, { name, inbound: [], leads: [], quotes: [], actions: [], audit: [], overrides: {}, staff: [], contacts: [], sync: {} });
    }
  }

  async withTenant<T>(tenantId: string, fn: (tx: TenantTx) => Promise<T>): Promise<T> {
    const previous = this.locks.get(tenantId) ?? Promise.resolve();
    const run = previous.catch(() => undefined).then(async () => {
      const committed = this.tenants.get(tenantId);
      if (!committed) throw new NotFoundError(`Tenant ${tenantId}`);
      const working = clone(committed);
      const result = await fn(new MemoryTenantTx(tenantId, working, this.clock));
      this.tenants.set(tenantId, working);
      return result;
    });
    this.locks.set(tenantId, run);
    return run;
  }

  async resolveToken(tokenHash: string): Promise<Principal | null> {
    for (const [tenantId, state] of this.tenants) {
      const person = state.staff.find((p) => p.tokenHash === tokenHash && p.revokedAt === null);
      if (person) return { tenantId, staffId: person.id, actor: person.email, role: person.role };
    }
    return null;
  }

  async close(): Promise<void> {}

  /** Test hook: mutate committed audit rows to simulate tampering. */
  unsafeAuditRows(tenantId: string): AuditEntry[] {
    return this.tenants.get(tenantId)?.audit ?? [];
  }
}

class MemoryTenantTx implements TenantTx {
  readonly tenantId: string;
  private readonly s: TenantState;
  private readonly clock: () => Date;

  constructor(tenantId: string, state: TenantState, clock: () => Date) {
    this.tenantId = tenantId;
    this.s = state;
    this.clock = clock;
  }

  private now(): string {
    return this.clock().toISOString();
  }

  async recordInbound(input: Parameters<TenantTx["recordInbound"]>[0]) {
    const existing = this.s.inbound.find((m) => m.messageId === input.messageId);
    if (existing) return { record: clone(existing), created: false };
    const record: InboundEmail = {
      ...input,
      id: randomUUID(),
      tenantId: this.tenantId,
      status: "received",
      extraction: null,
      error: null,
    };
    this.s.inbound.push(record);
    return { record: clone(record), created: true };
  }

  async getInbound(id: string) {
    const found = this.s.inbound.find((m) => m.id === id);
    return found ? clone(found) : null;
  }

  async updateInbound(id: string, patch: Parameters<TenantTx["updateInbound"]>[1]) {
    const found = this.s.inbound.find((m) => m.id === id);
    if (!found) throw new NotFoundError("Inbound email");
    found.status = patch.status;
    if (patch.extraction !== undefined) found.extraction = patch.extraction;
    if (patch.error !== undefined) found.error = patch.error;
  }

  async listInbound(filter: { status?: InboundEmail["status"] } = {}) {
    return clone(this.s.inbound.filter((m) => !filter.status || m.status === filter.status));
  }

  async findContact(query: { email: string | null; phone: string | null }) {
    const email = query.email?.toLowerCase() ?? null;
    const found =
      (email && this.s.contacts.find((c) => c.email === email)) ||
      (query.phone && this.s.contacts.find((c) => c.phone === query.phone)) ||
      null;
    return found ? clone(found) : null;
  }

  async insertContact(contact: Parameters<TenantTx["insertContact"]>[0]) {
    const email = contact.email?.toLowerCase() ?? null;
    if (email && this.s.contacts.some((c) => c.email === email)) {
      throw new ConflictError("contact_exists", `${email} is already a contact`);
    }
    const now = this.now();
    const record: ContactRecord = { ...clone(contact), email, id: randomUUID(), tenantId: this.tenantId, crmRef: null, createdAt: now, updatedAt: now };
    this.s.contacts.push(record);
    return clone(record);
  }

  async updateContact(id: string, patch: Parameters<TenantTx["updateContact"]>[1]) {
    const found = this.s.contacts.find((c) => c.id === id);
    if (!found) throw new NotFoundError("Contact");
    if (patch.name) found.name = patch.name;
    if (patch.email) found.email = patch.email.toLowerCase();
    if (patch.phone) found.phone = patch.phone;
    if (patch.company) found.company = patch.company;
    if (patch.crmRef) found.crmRef = patch.crmRef;
    found.updatedAt = this.now();
    return clone(found);
  }

  async listContacts() {
    return clone(this.s.contacts);
  }

  async getSyncState(key: string) {
    return this.s.sync[key] ?? null;
  }

  async setSyncState(key: string, value: string) {
    this.s.sync[key] = value;
  }

  async insertLead(draft: Parameters<TenantTx["insertLead"]>[0]) {
    const lead: Lead = { ...clone(draft), id: randomUUID(), tenantId: this.tenantId, createdAt: this.now() };
    this.s.leads.push(lead);
    return clone(lead);
  }

  async listLeads() {
    return clone(this.s.leads);
  }

  async insertQuote(draft: Parameters<TenantTx["insertQuote"]>[0]) {
    const quote: Quote = {
      ...clone(draft),
      id: randomUUID(),
      tenantId: this.tenantId,
      number: `Q-${String(this.s.quotes.length + 1).padStart(5, "0")}`,
      status: "issued",
      createdAt: this.now(),
    };
    this.s.quotes.push(quote);
    return clone(quote);
  }

  async listQuotes() {
    return clone(this.s.quotes);
  }

  async insertAction(draft: Parameters<TenantTx["insertAction"]>[0]) {
    const existing = this.s.actions.find((a) => a.idempotencyKey === draft.idempotencyKey);
    if (existing) return { record: clone(existing), created: false };
    const record: ActionRecord = {
      ...clone(draft),
      id: randomUUID(),
      tenantId: this.tenantId,
      requestedAt: this.now(),
      decidedBy: null,
      decidedAt: null,
      decisionNote: null,
      result: null,
      error: null,
    };
    this.s.actions.push(record);
    return { record: clone(record), created: true };
  }

  async getAction(id: string) {
    const found = this.s.actions.find((a) => a.id === id);
    return found ? clone(found) : null;
  }

  async getActionByKey(key: string) {
    const found = this.s.actions.find((a) => a.idempotencyKey === key);
    return found ? clone(found) : null;
  }

  async updateAction(id: string, patch: Parameters<TenantTx["updateAction"]>[1]) {
    const found = this.s.actions.find((a) => a.id === id);
    if (!found) throw new NotFoundError("Action");
    Object.assign(found, clone(patch));
    return clone(found);
  }

  async listActions(filter: { status?: ActionRecord["status"] } = {}) {
    return clone(this.s.actions.filter((a) => !filter.status || a.status === filter.status));
  }

  async appendAudit(draft: Parameters<TenantTx["appendAudit"]>[0]) {
    const entry = sealAuditEntry(this.tenantId, this.s.audit.at(-1) ?? null, clone(draft), this.clock());
    this.s.audit.push(entry);
    return clone(entry);
  }

  async listAudit() {
    return clone(this.s.audit);
  }

  async insertStaff(draft: Parameters<TenantTx["insertStaff"]>[0]) {
    const email = draft.email.toLowerCase();
    if (this.s.staff.some((p) => p.email === email && p.revokedAt === null)) {
      throw new ConflictError("staff_exists", `${email} already has access`);
    }
    const record = { id: randomUUID(), tenantId: this.tenantId, email, name: draft.name, role: draft.role, createdAt: this.now(), revokedAt: null, tokenHash: draft.tokenHash };
    this.s.staff.push(record);
    const { tokenHash: _hash, ...visible } = record;
    return clone(visible);
  }

  async listStaff() {
    return clone(this.s.staff.map(({ tokenHash: _hash, ...visible }) => visible));
  }

  async revokeStaff(email: string) {
    const person = this.s.staff.find((p) => p.email === email.toLowerCase() && p.revokedAt === null);
    if (!person) return false;
    person.revokedAt = this.now();
    return true;
  }

  async getOverrides() {
    return clone(this.s.overrides);
  }

  async setOverrides(overrides: Record<string, unknown>) {
    this.s.overrides = clone(overrides);
  }

  async attempt<T>(fn: () => Promise<T>): Promise<T> {
    const snapshot = clone(this.s);
    try {
      return await fn();
    } catch (error) {
      Object.assign(this.s, snapshot);
      throw error;
    }
  }
}
