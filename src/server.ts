import { hashToken, newToken } from "./auth/principal.ts";
import { connectCommand, publicUrl } from "./cli/connect.ts";
import { createApp } from "./http/app.ts";
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

  const url = publicUrl();
  if (production && !process.env.OPSDESK_PUBLIC_URL) throw new Error("OPSDESK_PUBLIC_URL is required in production");

  const rt = await createRuntime({ store, extractor });

  if (store.kind === "memory") {
    // Nothing persists in memory, so give each company a throwaway owner for this run.
    console.log("In-memory store: temporary owner accounts for this run only.");
    for (const id of rt.source.packs.keys()) {
      const token = newToken();
      await store.withTenant(id, (tx) =>
        tx.insertStaff({ email: `owner@${id}.dev`, name: "Dev owner", role: "owner", tokenHash: hashToken(token) }),
      );
      console.log(`\n  ${id}:\n  ${connectCommand(url, token, `opsdesk-${id}`)}`);
    }
    console.log("");
  }

  const port = Number(process.env.PORT ?? 3000);
  const host = process.env.HOST ?? (production ? "0.0.0.0" : "127.0.0.1");
  const allowedHosts = [new URL(url).hostname, "localhost", "127.0.0.1"];
  const server = createApp(rt, { host, allowedHosts }).listen(port, host, () => {
    console.log(
      `opsdesk MCP endpoint at ${url}/mcp (listening on ${host}:${port}, store=${store.kind}, ` +
        `extractor=${extractor.name}, companies=${[...rt.source.packs.keys()].join(",")})`,
    );
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
