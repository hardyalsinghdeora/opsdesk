import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { loadConfigSource, resolveCompanyConfig, type ConfigSource } from "../src/config/loader.ts";
import { ConfigError, ValidationError } from "../src/core/errors.ts";
import { PROJECT_ROOT } from "../src/runtime.ts";
import { ToolRegistry } from "../src/tools/registry.ts";

const source = loadConfigSource(PROJECT_ROOT);
const registry = new ToolRegistry();

function withPack(pack: Record<string, unknown>): ConfigSource {
  return { defaults: source.defaults, packs: new Map([[String(pack.id), pack]]) };
}

describe("config layering", () => {
  it("loads both example companies from YAML alone", () => {
    assert.deepEqual([...source.packs.keys()].sort(), ["gulfcool", "northwind"]);
    for (const id of source.packs.keys()) registry.forCompany(resolveCompanyConfig(source, id));
  });

  it("applies defaults, then the pack, then runtime overrides", () => {
    const base = resolveCompanyConfig(source, "northwind");
    assert.equal(base.llm.model, "claude-opus-5-5"); // platform default
    assert.equal(base.channels.email.min_confidence, 0.8); // pack beats default
    assert.equal(base.approvals.default, "required");

    const overridden = resolveCompanyConfig(source, "northwind", {
      channels: { email: { min_confidence: 0.5 } },
      tools: { "crm.create_lead": { approval: "auto" } },
    });
    assert.equal(overridden.channels.email.min_confidence, 0.5);
    assert.equal(overridden.tools["crm.create_lead"]?.approval, "auto");
    assert.equal(overridden.tools["crm.create_lead"]?.settings.default_stage, "qualification"); // untouched
  });

  it("does not let runtime overrides change prices or prompts", () => {
    assert.throws(
      () => resolveCompanyConfig(source, "gulfcool", { tools: { "quote.issue": { settings: { tax_rate: 0 } } } }),
      ValidationError,
    );
    assert.throws(() => resolveCompanyConfig(source, "gulfcool", { llm: { model: "other" } }), ValidationError);
  });

  it("rejects an unknown tool in a pack", () => {
    const bad = withPack({ ...source.packs.get("northwind"), tools: { "crm.delete_everything": { enabled: true } } });
    assert.throws(() => registry.forCompany(resolveCompanyConfig(bad, "northwind")), ConfigError);
  });

  it("rejects invalid tool settings when the tool is enabled", () => {
    const pack = structuredClone(source.packs.get("gulfcool")!) as any;
    pack.tools["quote.issue"].settings.price_list = [];
    assert.throws(() => registry.forCompany(resolveCompanyConfig(withPack(pack), "gulfcool")), /price_list/);
  });

  it("ignores settings of a disabled tool", () => {
    const pack = structuredClone(source.packs.get("gulfcool")!) as any;
    pack.tools["quote.issue"] = { enabled: false, settings: { nonsense: true } };
    const toolset = registry.forCompany(resolveCompanyConfig(withPack(pack), "gulfcool"));
    assert.equal(toolset.has("quote.issue"), false);
  });

  it("rejects bad pack values with a readable message", () => {
    const bad = withPack({ ...source.packs.get("northwind"), currency: "dollars" });
    assert.throws(() => resolveCompanyConfig(bad, "northwind"), /currency/);
  });
});
