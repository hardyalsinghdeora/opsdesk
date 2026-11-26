import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { z } from "zod";
import { loadConfigSource, resolveCompanyConfig } from "../src/config/loader.ts";
import { FakeCrm } from "../src/connectors/fakes.ts";
import { buildExtractionRequest } from "../src/llm/extraction.ts";
import { handleInboundEmail } from "../src/pipelines/email-intake.ts";
import { PROJECT_ROOT, type Runtime } from "../src/runtime.ts";
import { ToolRegistry } from "../src/tools/registry.ts";
import { fixture, runtimeWith, storeFactories } from "./helpers.ts";

const email = (id: string, from: string, subject: string, text: string) => ({ messageId: `<${id}@test.example>`, from, to: "enquiries@gulfcool.example", subject, text });

const general = (id: string, from = "Priya Nair <priya@villa.example>") =>
  email(id, from, "Noise from the outdoor unit", "Hello,\n\nThe outdoor unit makes a loud rattling noise at night. Can someone check it?\n\nThanks,\nPriya Nair\n+971 50 555 0101");

for (const factory of storeFactories()) {
  describe(`email routed to workflows (${factory.name})`, () => {
    let rt: Runtime;
    beforeEach(async () => {
      rt = await runtimeWith(await factory.make());
    });
    const leads = (tenant: string) => rt.store.withTenant(tenant, (tx) => tx.listLeads());
    const contacts = (tenant: string) => rt.store.withTenant(tenant, (tx) => tx.listContacts());

    it("sends a quote request to the sales workflow: lead now, quote for approval", async () => {
      const result = await handleInboundEmail(rt, "gulfcool", fixture("gulfcool-quote"));
      assert.equal(result.workflow, "sales_enquiry");
      assert.equal(result.extraction?.intent, "quote");
      assert.deepEqual(result.actions.map((a) => [a.tool, a.status]), [["crm.create_lead", "executed"], ["quote.issue", "pending_approval"]]);
    });

    it("sends any other enquiry to the general workflow, where the stricter step waits for a person", async () => {
      const result = await handleInboundEmail(rt, "gulfcool", general("g1"));
      assert.equal(result.workflow, "general_enquiry");
      assert.deepEqual(result.actions.map((a) => [a.tool, a.status]), [["crm.create_lead", "pending_approval"]]);
      assert.match(result.actions[0]!.reason ?? "", /general_enquiry/);
      assert.equal((await leads("gulfcool")).length, 0);
    });

    it("parks an email no active workflow takes, for a person, with no actions", async () => {
      const result = await handleInboundEmail(rt, "northwind", { ...general("n1", "Ann Lee <ann@shipper.example>"), to: "sales@northwind.example" });
      assert.equal(result.workflow, null);
      assert.equal(result.status, "needs_review");
      assert.equal(result.actions.length, 0);
      const audit = await rt.store.withTenant("northwind", (tx) => tx.listAudit());
      assert.equal(audit.at(-1)?.type, "email.unrouted");
    });

    it("follows a workflow switched off at runtime: quotes fall through to the general workflow", async () => {
      await rt.store.withTenant("gulfcool", (tx) => tx.setOverrides({ workflows: { sales_enquiry: { enabled: false } } }));
      const result = await handleInboundEmail(rt, "gulfcool", fixture("gulfcool-quote"));
      assert.equal(result.workflow, "general_enquiry");
      assert.deepEqual(result.actions.map((a) => a.tool), ["crm.create_lead"]);
    });

    it("recognises a repeat customer: one contact, a new lead per enquiry", async () => {
      await handleInboundEmail(rt, "gulfcool", fixture("gulfcool-quote"));
      await handleInboundEmail(rt, "gulfcool", {
        ...fixture("gulfcool-quote"),
        messageId: "<second-request@mail.villa.example>",
        subject: "Quote for AC servicing at our second villa",
      });
      const people = await contacts("gulfcool");
      assert.equal(people.length, 1);
      assert.equal(people[0]?.email, "sara.khan@villa.example");
      const all = await leads("gulfcool");
      assert.equal(all.length, 2);
      assert.ok(all.every((l) => l.contactId === people[0]!.id));
    });

    it("mirrors new leads into the company's CRM and remembers the CRM id", async () => {
      await handleInboundEmail(rt, "gulfcool", fixture("gulfcool-quote"));
      const crm = rt.connectors.get("gulfcool")!.crm as FakeCrm;
      const saved = crm.contacts.get("sara.khan@villa.example");
      assert.ok(saved);
      assert.match(saved.summary ?? "", /AC servicing/i);
      assert.equal((await contacts("gulfcool"))[0]?.crmRef, saved.externalId);
    });

    it("keeps each company's contacts apart", async () => {
      const shared = fixture("northwind-quote");
      await handleInboundEmail(rt, "northwind", shared);
      assert.equal((await contacts("gulfcool")).length, 0);
      assert.equal((await contacts("northwind")).length, 0); // northwind's lead waits for approval, so no contact yet
    });
  });
}

describe("what the model is asked to label", () => {
  const source = loadConfigSource(PROJECT_ROOT);
  const registry = new ToolRegistry();
  const request = (id: string, overrides: unknown = {}) => {
    const config = resolveCompanyConfig(source, id, overrides);
    return buildExtractionRequest(config, registry.forCompany(config), fixture("gulfcool-quote"));
  };

  it("offers only the intents of the company's active email workflows", () => {
    assert.deepEqual(request("gulfcool").intents.map((i) => i.name), ["quote"]);
    const schema = JSON.stringify(z.toJSONSchema(request("gulfcool").schema));
    assert.match(schema, /"intent"/);
  });

  it("drops an intent as soon as its workflow is switched off", () => {
    const off = request("gulfcool", { workflows: { sales_enquiry: { enabled: false } } });
    assert.equal(off.intents.length, 0);
    assert.doesNotMatch(JSON.stringify(z.toJSONSchema(off.schema)), /"intent"/);
    assert.doesNotMatch(off.system, /Intents/);
  });
});
