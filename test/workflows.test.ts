import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { loadConfigSource, resolveCompanyConfig, type ConfigSource } from "../src/config/loader.ts";
import { checkConnectors, createConnectors } from "../src/connectors/factory.ts";
import { ConfigError, ForbiddenError } from "../src/core/errors.ts";
import { MemoryStore } from "../src/store/memory.ts";
import { PROJECT_ROOT } from "../src/runtime.ts";
import { ToolRegistry } from "../src/tools/registry.ts";
import { resolveWorkflows } from "../src/workflows/workflows.ts";
import { inScope, runtimeWith } from "./helpers.ts";

const source = loadConfigSource(PROJECT_ROOT);
const registry = new ToolRegistry();

function workflowsFor(id: string, overrides: unknown = {}, strict = false) {
  const config = resolveCompanyConfig(source, id, overrides);
  return resolveWorkflows(config, registry.forCompany(config), { strict });
}

function withPack(pack: Record<string, unknown>): ConfigSource {
  return { defaults: source.defaults, packs: new Map([[String(pack.id), pack]]) };
}

describe("workflows", () => {
  it("runs several workflows per company, in priority order", () => {
    assert.deepEqual(workflowsFor("gulfcool").map((w) => w.id), ["sales_enquiry", "general_enquiry"]);
    assert.deepEqual(workflowsFor("northwind").map((w) => w.id), ["rate_request"]);
  });

  it("lets a step make a tool stricter", () => {
    const general = workflowsFor("gulfcool").find((w) => w.id === "general_enquiry")!;
    // crm.create_lead is "auto" for gulfcool, but this workflow wants a person to check.
    assert.equal(general.steps[0]?.approval, "required");
    const sales = workflowsFor("gulfcool").find((w) => w.id === "sales_enquiry")!;
    assert.deepEqual(sales.steps.map((s) => `${s.tool}:${s.approval}`), ["crm.create_lead:auto", "quote.issue:required"]);
  });

  it("does not let a step make a tool looser", () => {
    const pack = structuredClone(source.packs.get("northwind")!) as any;
    pack.workflows.rate_request.steps[0].approval = "auto";
    assert.throws(() => resolveCompanyConfig(withPack(pack), "northwind"), /approval/);
  });

  it("switches one workflow off at runtime without touching the others", () => {
    const wfs = workflowsFor("gulfcool", { workflows: { general_enquiry: { enabled: false } } });
    assert.deepEqual(wfs.map((w) => w.id), ["sales_enquiry"]);
  });

  it("pauses, not breaks, a workflow when an owner switches off a tool it uses", () => {
    const wfs = workflowsFor("gulfcool", { tools: { "quote.issue": { enabled: false } } });
    const sales = wfs.find((w) => w.id === "sales_enquiry")!;
    assert.equal(sales.active, false);
    assert.match(sales.paused_reason!, /quote\.issue/);
    assert.equal(wfs.find((w) => w.id === "general_enquiry")!.active, true);
  });

  it("treats the same gap in a pack as a mistake when checking it", () => {
    const pack = structuredClone(source.packs.get("northwind")!) as any;
    pack.workflows.rate_request.steps.push({ tool: "quote.issue" }); // off in this pack
    const config = resolveCompanyConfig(withPack(pack), "northwind");
    assert.throws(() => resolveWorkflows(config, registry.forCompany(config), { strict: true }), ConfigError);
  });
});

describe("the never policy", () => {
  it("refuses the tool every time, and audits the refusal", async () => {
    const rt = await runtimeWith(new MemoryStore());
    await rt.store.withTenant("gulfcool", (tx) => tx.setOverrides({ tools: { "crm.create_lead": { approval: "never" } } }));
    const outcome = await inScope(rt, "gulfcool", (s) =>
      rt.gateway.request(s, {
        tool: "crm.create_lead",
        input: { contact: { name: "A", email: "a@x.example", phone: null, company: null }, summary: "x", urgency: "normal", custom_fields: {}, source_ref: null },
        actor: "maya@gulfcool.example",
        idempotencyKey: "never-1",
      }),
    );
    assert.equal(outcome.ok, false);
    assert.ok(!outcome.ok && outcome.error instanceof ForbiddenError);
    const audit = await rt.store.withTenant("gulfcool", (tx) => tx.listAudit());
    assert.equal(audit.at(-1)?.type, "action.refused");
    assert.equal((audit.at(-1)?.data as { reason: string }).reason, "policy_never");
  });
});

describe("connectors", () => {
  it("builds the fakes the example packs ask for", async () => {
    const connectors = createConnectors(resolveCompanyConfig(source, "gulfcool"));
    assert.equal(connectors.crm?.kind, "fake");
    const saved = await connectors.crm!.upsertLead({ name: "A", email: "A@x.example", phone: null, summary: "s", fields: {} });
    const again = await connectors.crm!.upsertLead({ name: "A", email: "a@x.example", phone: null, summary: "s2", fields: {} });
    assert.equal(again.externalId, saved.externalId);
    assert.equal(again.created, false);
  });

  it("stops startup when a pack names a connector this release does not have", () => {
    const pack = { ...source.packs.get("gulfcool")!, connectors: { mailbox: { kind: "m365", address: "ops@gulfcool.example" } } };
    assert.throws(() => checkConnectors(resolveCompanyConfig(withPack(pack), "gulfcool")), /not available in this release/);
  });

  it("never accepts a secret written into a pack, only the name of where it lives", () => {
    const pack = {
      ...source.packs.get("gulfcool")!,
      connectors: { database: { kind: "sql", dialect: "postgres", url_ref: "postgres://user:pass@db/x", allowed_tables: ["orders"] } },
    };
    assert.throws(() => resolveCompanyConfig(withPack(pack), "gulfcool"), /environment variable/);
  });
});
