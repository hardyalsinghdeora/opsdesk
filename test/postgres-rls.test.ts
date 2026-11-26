import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import pg from "pg";
import { hashToken, newToken } from "../src/auth/principal.ts";
import { handleInboundEmail } from "../src/pipelines/email-intake.ts";
import type { Runtime } from "../src/runtime.ts";
import { fixture, runtimeWith, storeFactories } from "./helpers.ts";

const url = process.env.DATABASE_URL;

/**
 * These tests talk to Postgres directly, bypassing the store, to prove that
 * isolation is enforced by the database and not only by application code.
 */
describe("Postgres row-level security", { skip: url ? false : "DATABASE_URL not set" }, () => {
  let rt: Runtime;
  let pool: pg.Pool;

  before(async () => {
    const factory = storeFactories().find((f) => f.name === "postgres")!;
    rt = await runtimeWith(await factory.make());
    pool = new pg.Pool({ connectionString: url });
    await handleInboundEmail(rt, "gulfcool", fixture("gulfcool-quote"));
    await handleInboundEmail(rt, "northwind", fixture("northwind-quote"));
    await rt.store.withTenant("gulfcool", (tx) =>
      tx.insertStaff({ email: "maya@gulfcool.example", name: "Maya", role: "approver", tokenHash: hashToken(token) }),
    );
  });

  const token = newToken();

  after(async () => {
    await pool.end();
    await rt.store.close();
  });

  async function asTenant<T>(tenantId: string | null, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL ROLE opsdesk_app");
      if (tenantId) await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
      return await fn(client);
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  }

  it("shows a tenant only its own rows, even with no WHERE clause", async () => {
    const rows = await asTenant("northwind", async (c) => (await c.query("SELECT tenant_id FROM actions")).rows);
    assert.ok(rows.length > 0);
    assert.ok(rows.every((r) => r.tenant_id === "northwind"));
    const leads = await asTenant("northwind", async (c) => (await c.query("SELECT count(*)::int AS n FROM leads WHERE tenant_id = 'gulfcool'")).rows[0]);
    assert.equal(leads.n, 0);
  });

  it("shows nothing when no tenant is set", async () => {
    const n = await asTenant(null, async (c) => (await c.query("SELECT count(*)::int AS n FROM audit_log")).rows[0].n);
    assert.equal(n, 0);
  });

  it("refuses to write a row for another tenant", async () => {
    await assert.rejects(
      asTenant("northwind", (c) =>
        c.query(
          `INSERT INTO leads (id, tenant_id, contact, summary, stage, urgency, source)
           VALUES (gen_random_uuid(), 'gulfcool', '{}', 'x', 'new', 'normal', 'test')`,
        ),
      ),
      /row-level security/,
    );
  });

  it("makes the audit log append-only for the application role", async () => {
    await assert.rejects(asTenant("gulfcool", (c) => c.query("UPDATE audit_log SET actor = 'x'")), /permission denied/);
    await assert.rejects(asTenant("gulfcool", (c) => c.query("DELETE FROM audit_log")), /permission denied/);
  });

  it("hides another company's people from the application role", async () => {
    const rows = await asTenant("northwind", async (c) => (await c.query("SELECT email FROM staff")).rows);
    assert.equal(rows.length, 0);
    const none = await asTenant(null, async (c) => (await c.query("SELECT count(*)::int AS n FROM staff")).rows[0].n);
    assert.equal(none, 0);
  });

  it("lets the application resolve a token only through the narrow lookup", async () => {
    const found = await asTenant(null, async (c) => (await c.query("SELECT * FROM opsdesk_resolve_token($1)", [hashToken(token)])).rows);
    assert.deepEqual(found.map((r) => [r.tenant_id, r.email, r.role]), [["gulfcool", "maya@gulfcool.example", "approver"]]);
    assert.ok(!("token_hash" in found[0]));
  });

  it("does not let the application rewrite anyone's token or role", async () => {
    await assert.rejects(asTenant("gulfcool", (c) => c.query("UPDATE staff SET role = 'owner'")), /permission denied/);
    await assert.rejects(asTenant("gulfcool", (c) => c.query("UPDATE staff SET token_hash = repeat('0', 64)")), /permission denied/);
    await assert.rejects(asTenant("gulfcool", (c) => c.query("DELETE FROM staff")), /permission denied/);
  });

  it("isolates contacts and saved sync positions too", async () => {
    await rt.store.withTenant("gulfcool", (tx) => tx.setSyncState("mailbox.cursor", "2026-11-25T09:00:00.000Z"));
    const gulf = await asTenant("gulfcool", async (c) => (await c.query("SELECT count(*)::int AS n FROM contacts")).rows[0].n);
    assert.ok(gulf > 0, "gulfcool's quote email created a contact");
    for (const table of ["contacts", "sync_state"]) {
      const seen = await asTenant("northwind", async (c) => (await c.query(`SELECT count(*)::int AS n FROM ${table} WHERE tenant_id = 'gulfcool'`)).rows[0].n);
      assert.equal(seen, 0, table);
    }
  });
});
