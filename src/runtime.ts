import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfigSource, resolveCompanyConfig, type ConfigSource } from "./config/loader.ts";
import type { CompanyConfig } from "./config/schema.ts";
import { ActionGateway, type GatewayScope } from "./gateway/gateway.ts";
import type { Extractor } from "./llm/extraction.ts";
import { FakeExtractor } from "./llm/fake.ts";
import { MemoryStore } from "./store/memory.ts";
import type { Store, TenantTx } from "./store/types.ts";
import { ToolRegistry, type Toolset } from "./tools/registry.ts";

export const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Everything a request needs. Build one per process; it holds no tenant state. */
export interface Runtime {
  store: Store;
  source: ConfigSource;
  registry: ToolRegistry;
  gateway: ActionGateway;
  extractor: Extractor;
  clock: () => Date;
}

export interface RuntimeOptions {
  store?: Store;
  /** Directory holding config/ and companies/. Defaults to the project root. */
  configRoot?: string;
  source?: ConfigSource;
  registry?: ToolRegistry;
  extractor?: Extractor;
  clock?: () => Date;
}

/**
 * Build a runtime and check every company pack before serving traffic: a
 * typo in a pack stops startup instead of failing on a customer's email.
 */
export async function createRuntime(options: RuntimeOptions = {}): Promise<Runtime> {
  const clock = options.clock ?? (() => new Date());
  const rt: Runtime = {
    store: options.store ?? new MemoryStore(clock),
    source: options.source ?? loadConfigSource(options.configRoot ?? PROJECT_ROOT),
    registry: options.registry ?? new ToolRegistry(),
    gateway: new ActionGateway(clock),
    extractor: options.extractor ?? new FakeExtractor(),
    clock,
  };
  for (const id of rt.source.packs.keys()) {
    const config = resolveCompanyConfig(rt.source, id);
    rt.registry.forCompany(config);
    await rt.store.ensureTenant(id, config.name);
  }
  return rt;
}

export interface TenantScope extends GatewayScope {
  config: CompanyConfig;
  toolset: Toolset;
}

/** Resolve the tenant's config (with its stored overrides) inside a transaction. */
export async function scopeFor(rt: Runtime, tx: TenantTx): Promise<TenantScope> {
  const config = resolveCompanyConfig(rt.source, tx.tenantId, await tx.getOverrides());
  return { tx, config, toolset: rt.registry.forCompany(config) };
}
