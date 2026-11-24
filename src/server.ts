import { createApp } from "./app.ts";
import { ApiKeys } from "./http/auth.ts";
import { AnthropicExtractor } from "./llm/anthropic.ts";
import type { Extractor } from "./llm/extraction.ts";
import { FakeExtractor } from "./llm/fake.ts";
import { createRuntime } from "./runtime.ts";
import { MemoryStore } from "./store/memory.ts";
import { PostgresStore } from "./store/postgres.ts";
import type { Store } from "./store/types.ts";

function pickExtractor(): Extractor {
  const choice = process.env.OPSDESK_EXTRACTOR ?? (process.env.ANTHROPIC_API_KEY ? "anthropic" : "fake");
  if (choice === "anthropic") return new AnthropicExtractor();
  if (choice === "fake") return new FakeExtractor();
  throw new Error(`OPSDESK_EXTRACTOR must be "anthropic" or "fake", got "${choice}"`);
}

async function main() {
  const production = process.env.NODE_ENV === "production";
  const store: Store = process.env.DATABASE_URL ? new PostgresStore(process.env.DATABASE_URL) : new MemoryStore();
  if (production && store.kind === "memory") throw new Error("DATABASE_URL is required in production");

  const extractor = pickExtractor();
  if (production && extractor.name === "fake") throw new Error("The fake extractor is not allowed in production");

  const rt = await createRuntime({ store, extractor });

  let keys: ApiKeys;
  if (process.env.OPSDESK_API_KEYS) {
    keys = ApiKeys.fromJson(process.env.OPSDESK_API_KEYS);
  } else if (production) {
    throw new Error("OPSDESK_API_KEYS is required in production");
  } else {
    const dev = ApiKeys.forDevelopment([...rt.source.packs.keys()]);
    keys = dev.keys;
    console.log("Development API keys (regenerated on every start):");
    for (const k of dev.listing) console.log(`  ${k.tenantId.padEnd(10)} ${k.role.padEnd(8)} ${k.key}`);
  }

  const port = Number(process.env.PORT ?? 3000);
  const server = createApp(rt, keys).listen(port, () => {
    console.log(`opsdesk listening on :${port} (store=${store.kind}, extractor=${extractor.name}, companies=${[...rt.source.packs.keys()].join(",")})`);
  });

  const shutdown = () => {
    server.close(() => void store.close().then(() => process.exit(0)));
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
