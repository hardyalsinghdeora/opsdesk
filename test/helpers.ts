import { readFileSync } from "node:fs";
import path from "node:path";
import { migrate } from "../scripts/migrate.ts";
import type { InboundEmailInput } from "../src/core/types.ts";
import type { Extractor } from "../src/llm/extraction.ts";
import { createRuntime, PROJECT_ROOT, scopeFor, type Runtime, type TenantScope } from "../src/runtime.ts";
import { MemoryStore } from "../src/store/memory.ts";
import { PostgresStore } from "../src/store/postgres.ts";
import type { Store } from "../src/store/types.ts";
import pg from "pg";

export function fixture(name: string): InboundEmailInput {
  return JSON.parse(readFileSync(path.join(PROJECT_ROOT, "fixtures", "emails", `${name}.json`), "utf8"));
}

export interface StoreFactory {
  name: string;
  make(): Promise<Store>;
}

let migrated = false;
let current: Store | null = null;

/** Fresh schema once per process; tables truncated for every new store. */
async function freshPostgres(url: string): Promise<Store> {
  // One live store at a time, so test runs do not pile up idle connections.
  await current?.close();
  if (!migrated) {
    const admin = new pg.Client({ connectionString: url });
    await admin.connect();
    await admin.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
    await admin.end();
    await migrate(url, () => undefined);
    migrated = true;
  } else {
    const admin = new pg.Client({ connectionString: url });
    await admin.connect();
    await admin.query("TRUNCATE inbound_emails, leads, contacts, sync_state, quotes, actions, audit_log, tenant_settings, staff, tenants");
    await admin.end();
  }
  current = new PostgresStore(url);
  return current;
}

/** The memory store always; Postgres too when DATABASE_URL is set. */
export function storeFactories(): StoreFactory[] {
  const factories: StoreFactory[] = [{ name: "memory", make: async () => new MemoryStore() }];
  const url = process.env.DATABASE_URL;
  if (url) factories.push({ name: "postgres", make: () => freshPostgres(url) });
  return factories;
}

export async function runtimeWith(store: Store, extractor?: Extractor): Promise<Runtime> {
  return createRuntime({ store, extractor });
}

/** Run `fn` with a resolved scope for one tenant, in one transaction. */
export function inScope<T>(rt: Runtime, tenantId: string, fn: (scope: TenantScope) => Promise<T>): Promise<T> {
  return rt.store.withTenant(tenantId, async (tx) => fn(await scopeFor(rt, tx)));
}
