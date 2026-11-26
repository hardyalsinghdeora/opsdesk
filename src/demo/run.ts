import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { connectCommand } from "../cli/connect.ts";
import { createApp } from "../http/app.ts";
import { AnthropicExtractor } from "../llm/anthropic.ts";
import { FakeExtractor } from "../llm/fake.ts";
import { PROJECT_ROOT } from "../runtime.ts";
import { createDemo, DEMO_EMAILS } from "./demo.ts";

/**
 * npm run demo: the recorded walkthrough, at the presenter's pace.
 * Starts opsdesk in memory on this computer only, prints one Claude Code
 * setup line per person, then delivers the next demo email on each Enter.
 */
async function main() {
  const port = Number(process.env.PORT ?? 3000);
  const url = `http://localhost:${port}`;
  const workspace = path.join(PROJECT_ROOT, "demo-workspace");
  const tokenFile = path.join(workspace, ".tokens.json");

  // The same tokens every run, so each person's Claude Code setup is done once.
  // They only work against this local demo server.
  mkdirSync(workspace, { recursive: true });
  const saved: Record<string, string> = existsSync(tokenFile) ? JSON.parse(readFileSync(tokenFile, "utf8")) : {};
  const useModel = Boolean(process.env.ANTHROPIC_API_KEY) && process.env.OPSDESK_EXTRACTOR !== "fake";
  const demo = await createDemo({ tokens: saved, extractor: useModel ? new AnthropicExtractor() : new FakeExtractor() });
  writeFileSync(tokenFile, JSON.stringify(Object.fromEntries(demo.people.map((p) => [p.label, p.token])), null, 2));

  const server = createApp(demo.rt, { host: "127.0.0.1" }).listen(port, "127.0.0.1");
  await new Promise((resolve, reject) => server.once("listening", resolve).once("error", reject));

  console.log(`\nopsdesk demo running at ${url}/mcp (this computer only)`);
  console.log(
    useModel
      ? "Emails are read by Claude, using your ANTHROPIC_API_KEY."
      : "Emails are read by the keyword stand-in. Set ANTHROPIC_API_KEY to have Claude read them.",
  );
  console.log("\nOne-time setup: open a terminal per person, go to their folder, and run their line.");
  console.log("Then start Claude Code in that folder. Skip this on later runs: the lines stay valid.\n");
  for (const p of demo.people) {
    const folder = path.join(workspace, p.label);
    mkdirSync(folder, { recursive: true });
    console.log(`  ${p.name}`);
    console.log(`    folder: ${folder}`);
    console.log(`    ${connectCommand(url, p.token)}\n`);
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const shutdown = () => {
    rl.close();
    server.close(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);

  const prompt = () => {
    if (demo.remaining() === 0) {
      console.log("All demo emails delivered. Keep this running while you approve in Claude Code; press Ctrl+C to stop.");
      return;
    }
    const n = DEMO_EMAILS.length - demo.remaining();
    const upcoming = DEMO_EMAILS[n]!;
    process.stdout.write(`Press Enter to deliver email ${n + 1}/${DEMO_EMAILS.length}: ${upcoming.what} (${upcoming.tenant}). Or q to quit: `);
  };

  // Lines are read as a queue, so an Enter pressed while the previous email is
  // still being handled delivers the next one instead of being lost.
  prompt();
  for await (const line of rl) {
    if (line.trim().toLowerCase() === "q") return shutdown();
    const d = await demo.deliverNext();
    if (d) console.log(`\n  -> "${d.subject}" ${d.workflow ? `went to workflow ${d.workflow}` : "matched no workflow"}: ${d.outcome}\n`);
    prompt();
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(/EADDRINUSE/.test(message) ? `Port ${process.env.PORT ?? 3000} is in use. Stop the other server or set PORT.` : message);
  process.exit(1);
});
