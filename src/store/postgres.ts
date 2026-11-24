import { randomUUID } from "node:crypto";
import pg from "pg";
import { sealAuditEntry } from "../audit/chain.ts";
import { NotFoundError } from "../core/errors.ts";
import type { Json } from "../core/json.ts";
import type { ActionRecord, AuditEntry, InboundEmail, Lead, Quote } from "../core/types.ts";
import type { Store, TenantTx } from "./types.ts";

type Row = Record<string, any>;

const iso = (v: Date | string | null): string | null => (v === null ? null : new Date(v).toISOString());
const json = (v: unknown): string => JSON.stringify(v);

/**
 * Postgres store. Isolation does not depend on this file remembering a
 * WHERE clause: each transaction drops to the opsdesk_app role and sets
 * app.tenant_id, and row-level security filters every table.
 */
export class PostgresStore implements Store {
  readonly kind = "postgres";
  readonly pool: pg.Pool;
  private readonly clock: () => Date;

  constructor(connectionString: string, clock: () => Date = () => new Date()) {
    this.pool = new pg.Pool({ connectionString, max: 10, allowExitOnIdle: true });
    this.clock = clock;
  }

  async ensureTenant(id: string, name: string): Promise<void> {
    await this.pool.query(
      "INSERT INTO tenants (id, name) VALUES ($1, $2) ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name",
      [id, name],
    );
  }

  async withTenant<T>(tenantId: string, fn: (tx: TenantTx) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL ROLE opsdesk_app");
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
      const exists = await client.query("SELECT 1 FROM tenants WHERE id = $1", [tenantId]);
      if (exists.rowCount === 0) throw new NotFoundError(`Tenant ${tenantId}`);
      const result = await fn(new PgTenantTx(client, tenantId, this.clock));
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    if (!this.pool.ended) await this.pool.end();
  }
}

function toInbound(r: Row): InboundEmail {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    messageId: r.message_id,
    from: r.from_addr,
    to: r.to_addr,
    subject: r.subject,
    text: r.body,
    receivedAt: iso(r.received_at)!,
    status: r.status,
    extraction: r.extraction,
    error: r.error,
  };
}

function toLead(r: Row): Lead {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    contact: r.contact,
    summary: r.summary,
    stage: r.stage,
    owner: r.owner,
    urgency: r.urgency,
    customFields: r.custom_fields,
    source: r.source,
    sourceRef: r.source_ref,
    createdAt: iso(r.created_at)!,
  };
}

function toQuote(r: Row): Quote {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    number: r.number,
    customer: r.customer,
    currency: r.currency,
    lines: r.lines,
    subtotalMinor: Number(r.subtotal_minor),
    taxMinor: Number(r.tax_minor),
    totalMinor: Number(r.total_minor),
    taxRate: Number(r.tax_rate),
    validUntil: r.valid_until,
    status: r.status,
    sourceRef: r.source_ref,
    createdAt: iso(r.created_at)!,
  };
}

function toAction(r: Row): ActionRecord {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    tool: r.tool,
    input: r.input,
    preview: r.preview,
    status: r.status,
    idempotencyKey: r.idempotency_key,
    reason: r.reason,
    requestedBy: r.requested_by,
    requestedAt: iso(r.requested_at)!,
    decidedBy: r.decided_by,
    decidedAt: iso(r.decided_at),
    decisionNote: r.decision_note,
    result: r.result,
    error: r.error,
  };
}

function toAudit(r: Row): AuditEntry {
  return {
    tenantId: r.tenant_id,
    seq: Number(r.seq),
    id: r.id,
    at: iso(r.at)!,
    actor: r.actor,
    type: r.type,
    subject: r.subject,
    data: r.data as Json,
    prevHash: r.prev_hash,
    hash: r.hash,
  };
}

const QUOTE_COLUMNS = "*, valid_until::text AS valid_until";

class PgTenantTx implements TenantTx {
  readonly tenantId: string;
  private readonly db: pg.PoolClient;
  private readonly clock: () => Date;
  private savepoints = 0;

  constructor(db: pg.PoolClient, tenantId: string, clock: () => Date) {
    this.db = db;
    this.tenantId = tenantId;
    this.clock = clock;
  }

  private async one(sql: string, params: unknown[]): Promise<Row | null> {
    const res = await this.db.query(sql, params);
    return res.rows[0] ?? null;
  }

  async recordInbound(input: Parameters<TenantTx["recordInbound"]>[0]) {
    const inserted = await this.one(
      `INSERT INTO inbound_emails (id, tenant_id, message_id, from_addr, to_addr, subject, body, received_at, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'received')
       ON CONFLICT (tenant_id, message_id) DO NOTHING RETURNING *`,
      [randomUUID(), this.tenantId, input.messageId, input.from, input.to, input.subject, input.text, input.receivedAt],
    );
    if (inserted) return { record: toInbound(inserted), created: true };
    const existing = await this.one("SELECT * FROM inbound_emails WHERE tenant_id = $1 AND message_id = $2", [
      this.tenantId,
      input.messageId,
    ]);
    return { record: toInbound(existing!), created: false };
  }

  async getInbound(id: string) {
    const r = await this.one("SELECT * FROM inbound_emails WHERE id = $1", [id]);
    return r ? toInbound(r) : null;
  }

  async updateInbound(id: string, patch: Parameters<TenantTx["updateInbound"]>[1]) {
    const res = await this.db.query(
      `UPDATE inbound_emails SET status = $2,
         extraction = CASE WHEN $3::boolean THEN $4::jsonb ELSE extraction END,
         error = CASE WHEN $5::boolean THEN $6 ELSE error END
       WHERE id = $1`,
      [id, patch.status, patch.extraction !== undefined, json(patch.extraction ?? null), patch.error !== undefined, patch.error ?? null],
    );
    if (res.rowCount === 0) throw new NotFoundError("Inbound email");
  }

  async insertLead(d: Parameters<TenantTx["insertLead"]>[0]) {
    const r = await this.one(
      `INSERT INTO leads (id, tenant_id, contact, summary, stage, owner, urgency, custom_fields, source, source_ref, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING *`,
      [randomUUID(), this.tenantId, json(d.contact), d.summary, d.stage, d.owner, d.urgency, json(d.customFields), d.source, d.sourceRef, this.clock()],
    );
    return toLead(r!);
  }

  async listLeads() {
    const res = await this.db.query("SELECT * FROM leads ORDER BY created_at, id");
    return res.rows.map(toLead);
  }

  async insertQuote(d: Parameters<TenantTx["insertQuote"]>[0]) {
    const count = await this.one("SELECT count(*)::int AS n FROM quotes", []);
    const number = `Q-${String((count?.n ?? 0) + 1).padStart(5, "0")}`;
    const r = await this.one(
      `INSERT INTO quotes (id, tenant_id, number, customer, currency, lines, subtotal_minor, tax_minor, total_minor,
                           tax_rate, valid_until, status, source_ref, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'issued', $12, $13) RETURNING ${QUOTE_COLUMNS}`,
      [randomUUID(), this.tenantId, number, json(d.customer), d.currency, json(d.lines), d.subtotalMinor, d.taxMinor, d.totalMinor, d.taxRate, d.validUntil, d.sourceRef, this.clock()],
    );
    return toQuote(r!);
  }

  async listQuotes() {
    const res = await this.db.query(`SELECT ${QUOTE_COLUMNS} FROM quotes ORDER BY created_at, number`);
    return res.rows.map(toQuote);
  }

  async insertAction(d: Parameters<TenantTx["insertAction"]>[0]) {
    const inserted = await this.one(
      `INSERT INTO actions (id, tenant_id, tool, input, preview, status, idempotency_key, reason, requested_by, requested_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT (tenant_id, idempotency_key) DO NOTHING RETURNING *`,
      [randomUUID(), this.tenantId, d.tool, json(d.input), json(d.preview), d.status, d.idempotencyKey, d.reason, d.requestedBy, this.clock()],
    );
    if (inserted) return { record: toAction(inserted), created: true };
    return { record: (await this.getActionByKey(d.idempotencyKey))!, created: false };
  }

  async getAction(id: string) {
    const r = await this.one("SELECT * FROM actions WHERE id = $1", [id]);
    return r ? toAction(r) : null;
  }

  async getActionByKey(key: string) {
    const r = await this.one("SELECT * FROM actions WHERE tenant_id = $1 AND idempotency_key = $2", [this.tenantId, key]);
    return r ? toAction(r) : null;
  }

  async updateAction(id: string, patch: Parameters<TenantTx["updateAction"]>[1]) {
    const columns: Record<string, string> = {
      status: "status",
      decidedBy: "decided_by",
      decidedAt: "decided_at",
      decisionNote: "decision_note",
      result: "result",
      error: "error",
    };
    const sets: string[] = [];
    const params: unknown[] = [id];
    for (const [key, column] of Object.entries(columns)) {
      const value = (patch as Record<string, unknown>)[key];
      if (value === undefined) continue;
      params.push(key === "result" ? json(value) : value);
      sets.push(`${column} = $${params.length}`);
    }
    const r = await this.one(`UPDATE actions SET ${sets.join(", ")} WHERE id = $1 RETURNING *`, params);
    if (!r) throw new NotFoundError("Action");
    return toAction(r);
  }

  async listActions(filter: { status?: ActionRecord["status"] } = {}) {
    const res = filter.status
      ? await this.db.query("SELECT * FROM actions WHERE status = $1 ORDER BY requested_at, id", [filter.status])
      : await this.db.query("SELECT * FROM actions ORDER BY requested_at, id");
    return res.rows.map(toAction);
  }

  async appendAudit(draft: Parameters<TenantTx["appendAudit"]>[0]) {
    // Serialise appends per tenant so two requests cannot both claim seq N.
    await this.db.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`audit:${this.tenantId}`]);
    const last = await this.one("SELECT * FROM audit_log ORDER BY seq DESC LIMIT 1", []);
    const entry = sealAuditEntry(this.tenantId, last ? toAudit(last) : null, draft, this.clock());
    await this.db.query(
      `INSERT INTO audit_log (tenant_id, seq, id, at, actor, type, subject, data, prev_hash, hash)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [entry.tenantId, entry.seq, entry.id, entry.at, entry.actor, entry.type, entry.subject, json(entry.data), entry.prevHash, entry.hash],
    );
    return entry;
  }

  async listAudit() {
    const res = await this.db.query("SELECT * FROM audit_log ORDER BY seq");
    return res.rows.map(toAudit);
  }

  async getOverrides() {
    const r = await this.one("SELECT overrides FROM tenant_settings", []);
    return (r?.overrides as Record<string, unknown>) ?? {};
  }

  async setOverrides(overrides: Record<string, unknown>) {
    await this.db.query(
      `INSERT INTO tenant_settings (tenant_id, overrides, updated_at) VALUES ($1, $2, now())
       ON CONFLICT (tenant_id) DO UPDATE SET overrides = EXCLUDED.overrides, updated_at = now()`,
      [this.tenantId, json(overrides)],
    );
  }

  async attempt<T>(fn: () => Promise<T>): Promise<T> {
    const name = `sp_${++this.savepoints}`;
    await this.db.query(`SAVEPOINT ${name}`);
    try {
      const result = await fn();
      await this.db.query(`RELEASE SAVEPOINT ${name}`);
      return result;
    } catch (error) {
      await this.db.query(`ROLLBACK TO SAVEPOINT ${name}`);
      throw error;
    }
  }
}
