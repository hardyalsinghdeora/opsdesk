import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import pg from "pg";
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
  });

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
});
