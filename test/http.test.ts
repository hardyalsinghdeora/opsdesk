import assert from "node:assert/strict";
import { before, describe, it } from "node:test";
import request from "supertest";
import { createApp } from "../src/app.ts";
import { ApiKeys } from "../src/http/auth.ts";
import { MemoryStore } from "../src/store/memory.ts";
import { fixture, runtimeWith } from "./helpers.ts";

const KEYS = {
  gulfIngest: "test-gulfcool-ingest-0001",
  gulfOps: "test-gulfcool-operator-0001",
  gulfOps2: "test-gulfcool-operator-0002",
  gulfAdmin: "test-gulfcool-admin-00001",
  northOps: "test-northwind-operator-01",
};

describe("HTTP API", () => {
  let app: ReturnType<typeof createApp>;
  let store: MemoryStore;

  before(async () => {
    store = new MemoryStore();
    const rt = await runtimeWith(store);
    const keys = new ApiKeys();
    keys.add(KEYS.gulfIngest, { tenantId: "gulfcool", actor: "mailhook@gulfcool", role: "ingest" });
    keys.add(KEYS.gulfOps, { tenantId: "gulfcool", actor: "maya@gulfcool", role: "operator" });
    keys.add(KEYS.gulfOps2, { tenantId: "gulfcool", actor: "omar@gulfcool", role: "operator" });
    keys.add(KEYS.gulfAdmin, { tenantId: "gulfcool", actor: "admin@gulfcool", role: "admin" });
    keys.add(KEYS.northOps, { tenantId: "northwind", actor: "lee@northwind", role: "operator" });
    app = createApp(rt, keys);
  });

  const as = (key: string) => ({ Authorization: `Bearer ${key}` });

  it("requires an API key", async () => {
    await request(app).get("/t/gulfcool/actions").expect(401);
    await request(app).get("/t/gulfcool/actions").set(as("not-a-real-key-at-all")).expect(401);
  });

  it("hides other companies entirely: a valid key for another tenant gets 404", async () => {
    await request(app).get("/t/gulfcool/leads").set(as(KEYS.northOps)).expect(404);
  });

  it("enforces roles: an ingest key cannot approve or read", async () => {
    await request(app).get("/t/gulfcool/leads").set(as(KEYS.gulfIngest)).expect(403);
    await request(app).put("/t/gulfcool/settings").set(as(KEYS.gulfOps)).send({}).expect(403);
  });

  it("validates the inbound payload", async () => {
    const res = await request(app).post("/t/gulfcool/inbound/email").set(as(KEYS.gulfIngest)).send({ from: "x" }).expect(422);
    assert.equal(res.body.error.code, "validation_failed");
  });

  it("runs email -> proposal -> approval -> issued quote -> verified audit", async () => {
    const intake = await request(app).post("/t/gulfcool/inbound/email").set(as(KEYS.gulfIngest)).send(fixture("gulfcool-quote")).expect(201);
    assert.equal(intake.body.status, "processed");

    const pending = await request(app).get("/t/gulfcool/actions?status=pending_approval").set(as(KEYS.gulfOps)).expect(200);
    assert.equal(pending.body.length, 1);
    const quoteAction = pending.body[0];
    assert.equal(quoteAction.tool, "quote.issue");

    const approved = await request(app)
      .post(`/t/gulfcool/actions/${quoteAction.id}/approve`)
      .set(as(KEYS.gulfOps))
      .send({ note: "checked against site survey" })
      .expect(200);
    assert.equal(approved.body.status, "executed");

    await request(app).post(`/t/gulfcool/actions/${quoteAction.id}/approve`).set(as(KEYS.gulfOps2)).send({}).expect(409);

    const quotes = await request(app).get("/t/gulfcool/quotes").set(as(KEYS.gulfOps)).expect(200);
    assert.equal(quotes.body[0].totalMinor, 161_700);

    const verify = await request(app).get("/t/gulfcool/audit/verify").set(as(KEYS.gulfOps)).expect(200);
    assert.equal(verify.body.ok, true);

    await request(app).post("/t/gulfcool/inbound/email").set(as(KEYS.gulfIngest)).send(fixture("gulfcool-quote")).expect(200);
  });

  it("reports tampering with the audit log", async () => {
    const rows = store.unsafeAuditRows("gulfcool");
    const original = rows[0]!.actor;
    rows[0]!.actor = "someone-else";
    try {
      const verify = await request(app).get("/t/gulfcool/audit/verify").set(as(KEYS.gulfOps)).expect(200);
      assert.equal(verify.body.ok, false);
      assert.equal(verify.body.brokenAtSeq, 1);
    } finally {
      rows[0]!.actor = original;
    }
  });

  it("lets an admin switch a tool off at runtime, and audits the change", async () => {
    const res = await request(app)
      .put("/t/gulfcool/settings")
      .set(as(KEYS.gulfAdmin))
      .send({ tools: { "quote.issue": { enabled: false } } })
      .expect(200);
    assert.deepEqual(res.body.tools.map((t: { name: string }) => t.name), ["crm.create_lead"]);
    const audit = await request(app).get("/t/gulfcool/audit").set(as(KEYS.gulfAdmin)).expect(200);
    assert.equal(audit.body.at(-1).type, "settings.changed");
    await request(app).put("/t/gulfcool/settings").set(as(KEYS.gulfAdmin)).send({}).expect(200);
  });

  it("rejects overrides that would leave the company misconfigured", async () => {
    // Not an allowed runtime key: models and prompts change through the pack.
    await request(app).put("/t/gulfcool/settings").set(as(KEYS.gulfAdmin)).send({ llm: { model: "x" } }).expect(422);
    // Allowed key, but the result is invalid: crm.create_lead needs no change, an unknown tool does.
    await request(app)
      .put("/t/gulfcool/settings")
      .set(as(KEYS.gulfAdmin))
      .send({ tools: { "crm.delete_all": { enabled: true } } })
      .expect(422);
  });
});
