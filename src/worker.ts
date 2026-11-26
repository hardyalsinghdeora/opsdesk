import { AnthropicExtractor } from "./llm/anthropic.ts";
import { FakeExtractor } from "./llm/fake.ts";
import { createRuntime } from "./runtime.ts";
import { PostgresStore } from "./store/postgres.ts";
import { pollAll } from "./worker/mail-poller.ts";

/**
 * Background work beside the MCP server: polls each company's mailbox and
 * runs intake. Nothing it does skips the gateway; actions that need a person
 * wait in the approval queue.
 */
async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is required for the worker");
  const production = process.env.NODE_ENV === "production";
  const useModel = (process.env.OPSDESK_EXTRACTOR ?? (process.env.ANTHROPIC_API_KEY ? "anthropic" : "fake")) === "anthropic";
  if (production && !useModel) throw new Error("The fake extractor is not allowed in production");

  const store = new PostgresStore(url);
  const rt = await createRuntime({ store, extractor: useModel ? new AnthropicExtractor() : new FakeExtractor() });
  const every = Math.max(15, Number(process.env.OPSDESK_POLL_SECONDS ?? 60)) * 1000;
  console.log(`opsdesk worker: polling mailboxes every ${every / 1000}s (extractor=${rt.extractor.name})`);

  let stopping = false;
  const stop = () => {
    stopping = true;
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);

  while (!stopping) {
    await pollAll(rt);
    for (let waited = 0; waited < every && !stopping; waited += 1000) await new Promise((r) => setTimeout(r, 1000));
  }
  await store.close();
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
