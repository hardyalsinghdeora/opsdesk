import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { verifyAuditChain } from "../src/audit/chain.ts";
import { ToolDisabledError } from "../src/core/errors.ts";
import { unwrap } from "../src/gateway/gateway.ts";
import type { Runtime } from "../src/runtime.ts";
import { inScope, runtimeWith, storeFactories } from "./helpers.ts";

const leadInput = {
  contact: { name: "Ana Diaz", email: "ana@example.com", phone: null, company: null },
  summary: "Wants a maintenance contract",
  urgency: "normal",
  custom_fields: { property_type: "office", emirate: "Sharjah", not_declared: "dropped" },
  source: "api",
  source_ref: null,
};
const quoteInput = {
  customer: { name: "Ana Diaz", email: "ana@example.com" },
  items: [{ code: "AC-SERVICE", quantity: 2, note: null }],
  source_ref: null,
};

for (const factory of storeFactories()) {
  describe(`action gateway (${factory.name})`, () => {
    let rt: Runtime;
    beforeEach(async () => {
      rt = await runtimeWith(await factory.make());
    });

    it("runs a write tool at once when its policy is auto", async () => {
      const outcome = await inScope(rt, "gulfcool", (s) =>
        rt.gateway.request(s, { tool: "crm.create_lead", input: leadInput, actor: "ops@a", idempotencyKey: "k1" }),
      );
      const { action } = unwrap(outcome);
      assert.equal(action.status, "executed");
      const leads = await rt.store.withTenant("gulfcool", (tx) => tx.listLeads());
      assert.equal(leads.length, 1);
      assert.deepEqual(leads[0]!.customFields, { property_type: "office", emirate: "Sharjah" }, "undeclared fields are dropped");
    });

    it("holds a write tool for approval, shows a priced preview, then executes once approved", async () => {
      const { action } = unwrap(
        await inScope(rt, "gulfcool", (s) =>
          rt.gateway.request(s, { tool: "quote.issue", input: quoteInput, actor: "ops@a", idempotencyKey: "q1" }),
        ),
      );
      assert.equal(action.status, "pending_approval");
      assert.equal((action.preview as any).total, "AED 378.00");
      assert.equal((await rt.store.withTenant("gulfcool", (tx) => tx.listQuotes())).length, 0, "nothing happens before approval");

      const approved = unwrap(await inScope(rt, "gulfcool", (s) => rt.gateway.approve(s, action.id, "manager@a"))).action;
      assert.equal(approved.status, "executed");
      assert.equal(approved.decidedBy, "manager@a");
      const [quote] = await rt.store.withTenant("gulfcool", (tx) => tx.listQuotes());
      assert.equal(quote!.totalMinor, 37_800);
      assert.equal(quote!.number, "Q-00001");
    });

    it("refuses a disabled tool and keeps the refusal in the audit log", async () => {
      const outcome = await inScope(rt, "northwind", (s) =>
        rt.gateway.request(s, { tool: "quote.issue", input: quoteInput, actor: "ops@n", idempotencyKey: "q1" }),
      );
      assert.equal(outcome.ok, false);
      assert.ok(!outcome.ok && outcome.error instanceof ToolDisabledError);
      const audit = await rt.store.withTenant("northwind", (tx) => tx.listAudit());
      assert.equal(audit.at(-1)?.type, "action.refused");
      assert.equal((audit.at(-1)?.data as any).reason, "tool_disabled");
      assert.equal((await rt.store.withTenant("northwind", (tx) => tx.listActions())).length, 0);
    });

    it("refuses invalid input without creating an action", async () => {
      const outcome = await inScope(rt, "gulfcool", (s) =>
        rt.gateway.request(s, { tool: "quote.issue", input: { ...quoteInput, items: [] }, actor: "ops@a", idempotencyKey: "q1" }),
      );
      assert.equal(outcome.ok, false);
      assert.equal((await rt.store.withTenant("gulfcool", (tx) => tx.listActions())).length, 0);
    });

    it("refuses an unknown catalogue code at proposal time", async () => {
      const input = { ...quoteInput, items: [{ code: "GOLD-PLATING", quantity: 1, note: null }] };
      const outcome = await inScope(rt, "gulfcool", (s) =>
        rt.gateway.request(s, { tool: "quote.issue", input, actor: "ops@a", idempotencyKey: "q1" }),
      );
      assert.equal(outcome.ok, false);
      assert.match(!outcome.ok ? outcome.error.message : "", /Unknown service code/);
    });

    it("never acts twice for the same idempotency key", async () => {
      const req = { tool: "crm.create_lead", input: leadInput, actor: "ops@a", idempotencyKey: "same" };
      const first = unwrap(await inScope(rt, "gulfcool", (s) => rt.gateway.request(s, req)));
      const second = unwrap(await inScope(rt, "gulfcool", (s) => rt.gateway.request(s, req)));
      assert.equal(first.created, true);
      assert.equal(second.created, false);
      assert.equal(second.action.id, first.action.id);
      assert.equal((await rt.store.withTenant("gulfcool", (tx) => tx.listLeads())).length, 1);
    });

    it("does not let the requester approve their own action", async () => {
      const { action } = unwrap(
        await inScope(rt, "gulfcool", (s) =>
          rt.gateway.request(s, { tool: "quote.issue", input: quoteInput, actor: "ops@a", idempotencyKey: "q1" }),
        ),
      );
      const outcome = await inScope(rt, "gulfcool", (s) => rt.gateway.approve(s, action.id, "ops@a"));
      assert.equal(outcome.ok, false);
      const audit = await rt.store.withTenant("gulfcool", (tx) => tx.listAudit());
      assert.equal((audit.at(-1)?.data as any).reason, "self_approval");
    });

    it("refuses to approve if the tool was switched off after the proposal", async () => {
      const { action } = unwrap(
        await inScope(rt, "gulfcool", (s) =>
          rt.gateway.request(s, { tool: "quote.issue", input: quoteInput, actor: "ops@a", idempotencyKey: "q1" }),
        ),
      );
      await rt.store.withTenant("gulfcool", (tx) => tx.setOverrides({ tools: { "quote.issue": { enabled: false } } }));
      const outcome = await inScope(rt, "gulfcool", (s) => rt.gateway.approve(s, action.id, "manager@a"));
      assert.ok(!outcome.ok && outcome.error instanceof ToolDisabledError);
      assert.equal((await rt.store.withTenant("gulfcool", (tx) => tx.listQuotes())).length, 0);
    });

    it("records a rejection and refuses to decide twice", async () => {
      const { action } = unwrap(
        await inScope(rt, "gulfcool", (s) =>
          rt.gateway.request(s, { tool: "quote.issue", input: quoteInput, actor: "ops@a", idempotencyKey: "q1" }),
        ),
      );
      const rejected = await inScope(rt, "gulfcool", (s) => rt.gateway.reject(s, action.id, "manager@a", "price agreed by phone"));
      assert.equal(rejected.status, "rejected");
      await assert.rejects(inScope(rt, "gulfcool", (s) => rt.gateway.approve(s, action.id, "manager@a")), /not pending/);
    });

    it("marks an action failed, and rolls back its partial writes, when the tool throws", async () => {
      const crm = rt.registry.forCompany((await inScope(rt, "gulfcool", async (s) => s.config))).get("crm.create_lead").tool;
      const original = crm.execute;
      crm.execute = async (ctx, input) => {
        await original(ctx, input); // writes a lead...
        throw new Error("CRM timed out"); // ...then fails
      };
      try {
        const { action } = unwrap(
          await inScope(rt, "gulfcool", (s) =>
            rt.gateway.request(s, { tool: "crm.create_lead", input: leadInput, actor: "ops@a", idempotencyKey: "f1" }),
          ),
        );
        assert.equal(action.status, "failed");
        assert.equal(action.error, "CRM timed out");
        assert.equal((await rt.store.withTenant("gulfcool", (tx) => tx.listLeads())).length, 0);
      } finally {
        crm.execute = original;
      }
    });

    it("keeps a valid hash chain across all of the above", async () => {
      await inScope(rt, "gulfcool", (s) =>
        rt.gateway.request(s, { tool: "crm.create_lead", input: leadInput, actor: "ops@a", idempotencyKey: "c1" }),
      );
      const check = verifyAuditChain(await rt.store.withTenant("gulfcool", (tx) => tx.listAudit()));
      assert.equal(check.ok, true);
    });
  });
}
