import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { verifyAuditChain } from "../src/audit/chain.ts";
import { handleInboundEmail } from "../src/pipelines/email-intake.ts";
import type { Runtime } from "../src/runtime.ts";
import { fixture, runtimeWith, storeFactories } from "./helpers.ts";

for (const factory of storeFactories()) {
  describe(`email intake (${factory.name})`, () => {
    let rt: Runtime;
    beforeEach(async () => {
      rt = await runtimeWith(await factory.make());
    });
    const audit = (tenant: string) => rt.store.withTenant(tenant, (tx) => tx.listAudit());

    it("turns a quote request into a lead now and a quote awaiting approval", async () => {
      const result = await handleInboundEmail(rt, "gulfcool", fixture("gulfcool-quote"));
      assert.equal(result.status, "processed");
      const [lead, quote] = result.actions;
      assert.equal(lead?.tool, "crm.create_lead");
      assert.equal(lead?.status, "executed");
      assert.equal(quote?.tool, "quote.issue");
      assert.equal(quote?.status, "pending_approval");
      // 3 x 180 + 4 x 250 = 1540, + 5% VAT = 1617.00
      assert.equal((quote?.preview as any).total, "AED 1,617.00");

      const [stored] = await rt.store.withTenant("gulfcool", (tx) => tx.listLeads());
      assert.equal(stored?.contact.name, "Sara Khan");
      assert.deepEqual(stored?.customFields, { property_type: "villa", emirate: "Dubai" });
      assert.deepEqual(
        (await audit("gulfcool")).map((e) => e.type),
        ["email.received", "email.extracted", "action.proposed", "action.executed", "action.proposed"],
      );
    });

    it("treats a re-delivered email as a duplicate: no second lead or quote", async () => {
      const first = await handleInboundEmail(rt, "gulfcool", fixture("gulfcool-quote"));
      const again = await handleInboundEmail(rt, "gulfcool", fixture("gulfcool-quote"));
      assert.equal(again.status, "duplicate");
      assert.deepEqual(again.actions.map((a) => a.id), first.actions.map((a) => a.id));
      assert.equal((await rt.store.withTenant("gulfcool", (tx) => tx.listLeads())).length, 1);
      assert.equal((await rt.store.withTenant("gulfcool", (tx) => tx.listActions())).length, 2);
    });

    it("ignores newsletters without proposing anything", async () => {
      const result = await handleInboundEmail(rt, "gulfcool", fixture("gulfcool-newsletter"));
      assert.equal(result.status, "ignored");
      assert.equal(result.actions.length, 0);
    });

    it("parks the email for a person when the model declines, and takes no action", async () => {
      const result = await handleInboundEmail(rt, "gulfcool", fixture("gulfcool-refusal"));
      assert.equal(result.status, "needs_review");
      assert.equal((await rt.store.withTenant("gulfcool", (tx) => tx.listActions())).length, 0);
      const failed = (await audit("gulfcool")).find((e) => e.type === "email.extraction_failed");
      assert.equal((failed?.data as any).kind, "refusal");
      const inbound = await rt.store.withTenant("gulfcool", (tx) => tx.getInbound(result.inboundId));
      assert.match(inbound?.error ?? "", /^refusal/);
    });

    it("requires approval for everything when confidence is low, even auto tools", async () => {
      const result = await handleInboundEmail(rt, "gulfcool", fixture("gulfcool-vague"));
      assert.equal(result.status, "needs_review");
      assert.ok(result.actions.length > 0);
      for (const action of result.actions) {
        assert.equal(action.status, "pending_approval");
        assert.match(action.reason ?? "", /confidence/);
      }
      assert.equal((await rt.store.withTenant("gulfcool", (tx) => tx.listLeads())).length, 0);
    });

    it("handles a second industry from config alone: lead pending, no quote proposed", async () => {
      const result = await handleInboundEmail(rt, "northwind", fixture("northwind-quote"));
      assert.equal(result.status, "processed");
      assert.deepEqual(result.actions.map((a) => [a.tool, a.status]), [["crm.create_lead", "pending_approval"]]);
      const input = result.actions[0]!.input as any;
      assert.deepEqual(input.custom_fields, {
        origin: "Shanghai",
        destination: "Felixstowe",
        cargo_type: "general cargo",
        mode: "sea",
      });
    });

    it("keeps companies apart: the same Message-ID is a new email for another company", async () => {
      const email = fixture("northwind-quote");
      await handleInboundEmail(rt, "northwind", email);
      const other = await handleInboundEmail(rt, "gulfcool", email);
      assert.notEqual(other.status, "duplicate");
      assert.equal((await rt.store.withTenant("northwind", (tx) => tx.listActions())).length, 1);
    });

    it("refuses email when the channel is switched off at runtime", async () => {
      await rt.store.withTenant("gulfcool", (tx) => tx.setOverrides({ channels: { email: { enabled: false } } }));
      await assert.rejects(handleInboundEmail(rt, "gulfcool", fixture("gulfcool-quote")), /not enabled/);
      assert.equal((await audit("gulfcool")).at(-1)?.type, "email.refused");
    });

    it("leaves a verifiable audit chain for every company", async () => {
      await handleInboundEmail(rt, "gulfcool", fixture("gulfcool-quote"));
      await handleInboundEmail(rt, "gulfcool", fixture("gulfcool-refusal"));
      await handleInboundEmail(rt, "northwind", fixture("northwind-quote"));
      assert.equal(verifyAuditChain(await audit("gulfcool")).ok, true);
      assert.equal(verifyAuditChain(await audit("northwind")).ok, true);
    });
  });
}
