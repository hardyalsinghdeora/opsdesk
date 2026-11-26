import { readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import pg from "pg";
import { migrate } from "../../scripts/migrate.ts";
import { hashToken, newToken, Role } from "../auth/principal.ts";
import { loadConfigSource, resolveCompanyConfig } from "../config/loader.ts";
import { checkConnectors } from "../connectors/factory.ts";
import { OpsdeskError } from "../core/errors.ts";
import { createRuntime, PROJECT_ROOT, scopeFor } from "../runtime.ts";
import { PostgresStore } from "../store/postgres.ts";
import { ToolRegistry } from "../tools/registry.ts";
import { resolveWorkflows } from "../workflows/workflows.ts";
import { pollMailbox } from "../worker/mail-poller.ts";
import { AnthropicExtractor } from "../llm/anthropic.ts";
import { FakeExtractor } from "../llm/fake.ts";
import { connectCommand, publicUrl } from "./connect.ts";
import { createInterface } from "node:readline/promises";
import { approveFromCli, describeForApproval, pendingApprovals, prepareDecision, rejectFromCli } from "./approvals.ts";

const HELP = `aiops: run and look after opsdesk on this server

  aiops doctor                               check everything and say what to fix
  aiops migrate                              update the database to this release
  aiops config validate                      check every company's settings
  aiops config show [--company ID]           print a company's settings, with runtime changes
  aiops users add --email E --name N --role R [--company ID]
                                             give someone access; prints their connect command
  aiops users list [--company ID]
  aiops users remove --email E [--company ID]
                                             revoke someone's access at once
  aiops mail poll [--company ID]             read new mail once now (the worker does this on a timer)
  aiops approvals [--company ID]             list actions waiting for approval
  aiops approve ID --as EMAIL [--note N] [--yes] [--company ID]
                                             approve one action as that approver, after showing exactly what runs
  aiops reject ID --as EMAIL --note N [--company ID]

Roles: viewer (read), staff (read, ask for actions), approver (also approve), owner (also manage people).
--company can be left out when this server runs one company.`;

class UsageError extends Error {}

function databaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) throw new UsageError("DATABASE_URL is not set. Add it to the .env file next to docker-compose.yml.");
  return url;
}

function pickCompany(ids: string[], requested: string | undefined): string {
  if (requested) {
    if (!ids.includes(requested)) throw new UsageError(`No company "${requested}". This server has: ${ids.join(", ")}`);
    return requested;
  }
  if (ids.length === 1) return ids[0]!;
  throw new UsageError(`This server runs ${ids.length} companies (${ids.join(", ")}). Add --company ID.`);
}

async function withRuntime<T>(fn: (rt: Awaited<ReturnType<typeof createRuntime>>) => Promise<T>): Promise<T> {
  const store = new PostgresStore(databaseUrl());
  const useModel = (process.env.OPSDESK_EXTRACTOR ?? (process.env.ANTHROPIC_API_KEY ? "anthropic" : "fake")) === "anthropic";
  try {
    return await fn(await createRuntime({ store, extractor: useModel ? new AnthropicExtractor() : new FakeExtractor() }));
  } finally {
    await store.close();
  }
}

function validateAll(): string[] {
  const source = loadConfigSource(PROJECT_ROOT);
  const registry = new ToolRegistry();
  const lines: string[] = [];
  for (const id of source.packs.keys()) {
    const config = resolveCompanyConfig(source, id);
    const workflows = resolveWorkflows(config, registry.forCompany(config), { strict: true });
    checkConnectors(config);
    lines.push(`${id}: ${registry.forCompany(config).names().length} tools, ${workflows.length} workflows on`);
  }
  return lines;
}

async function doctor(): Promise<boolean> {
  let healthy = true;
  const report = (good: boolean, label: string, fix?: string) => {
    console.log(good ? `OK   ${label}` : `FIX  ${label}: ${fix}`);
    if (!good) healthy = false;
  };

  try {
    const lines = validateAll();
    report(true, `Company settings (${lines.join("; ")})`);
  } catch (error) {
    report(false, "Company settings", (error as Error).message);
  }

  const url = process.env.DATABASE_URL;
  if (!url) {
    report(false, "Database", "DATABASE_URL is not set in .env");
    return false;
  }
  const client = new pg.Client({ connectionString: url });
  try {
    await client.connect();
    report(true, "Database reachable");
    const files = readdirSync(path.join(PROJECT_ROOT, "db", "migrations")).filter((f) => f.endsWith(".sql"));
    const done = await client
      .query("SELECT name FROM schema_migrations")
      .then((r) => new Set(r.rows.map((row) => row.name as string)))
      .catch(() => new Set<string>());
    const pending = files.filter((f) => !done.has(f));
    report(pending.length === 0, "Database up to date", `run "aiops migrate" (${pending.length} pending)`);
  } catch (error) {
    report(false, "Database reachable", `cannot connect: ${(error as Error).message}`);
    return false;
  } finally {
    await client.end().catch(() => undefined);
  }

  const model = process.env.OPSDESK_EXTRACTOR ?? (process.env.ANTHROPIC_API_KEY ? "anthropic" : "fake");
  report(model === "anthropic" && !!process.env.ANTHROPIC_API_KEY, "AI model key", "set ANTHROPIC_API_KEY in .env");

  const address = process.env.OPSDESK_PUBLIC_URL;
  const local = address ? ["localhost", "127.0.0.1"].includes(new URL(address).hostname) : true;
  report(
    !!address && (address.startsWith("https://") || local),
    "Web address",
    address ? "use an https:// address so tokens are never sent in the clear" : "set OPSDESK_PUBLIC_URL in .env",
  );

  try {
    await withRuntime(async (rt) => {
      for (const id of rt.source.packs.keys()) {
        const owners = await rt.store.withTenant(id, async (tx) =>
          (await tx.listStaff()).filter((p) => p.role === "owner" && p.revokedAt === null),
        );
        report(owners.length > 0, `${id}: has an owner`, `run "aiops users add --role owner ..."`);
      }
    });
  } catch (error) {
    report(false, "People", (error as Error).message);
  }
  return healthy;
}

export async function run(argv: string[]): Promise<number> {
  const [command, sub, ...rest] = argv;
  const flags = (args: string[]) =>
    parseArgs({
      args,
      options: {
        company: { type: "string" },
        email: { type: "string" },
        name: { type: "string" },
        role: { type: "string" },
        as: { type: "string" },
        note: { type: "string" },
        yes: { type: "boolean" },
      },
      strict: true,
    }).values;

  if (!command || command === "help" || command === "--help") {
    console.log(HELP);
    return 0;
  }
  if (command === "doctor") return (await doctor()) ? 0 : 1;
  if (command === "migrate") {
    await migrate(databaseUrl());
    return 0;
  }
  if (command === "config" && sub === "validate") {
    for (const line of validateAll()) console.log(`OK   ${line}`);
    return 0;
  }
  if (command === "config" && sub === "show") {
    const { company } = flags(rest);
    return withRuntime(async (rt) => {
      const id = pickCompany([...rt.source.packs.keys()], company);
      const scope = await rt.store.withTenant(id, (tx) => scopeFor(rt, tx));
      console.log(JSON.stringify({ ...scope.config, tools: scope.toolset.describe(), workflows: scope.workflows }, null, 2));
      return 0;
    });
  }
  if (command === "users") {
    const { company, email, name, role } = flags(rest);
    return withRuntime(async (rt) => {
      const id = pickCompany([...rt.source.packs.keys()], company);
      if (sub === "add") {
        if (!email || !name || !role) throw new UsageError("users add needs --email, --name and --role");
        const parsedRole = Role.safeParse(role);
        if (!parsedRole.success) throw new UsageError(`--role must be one of: ${Role.options.join(", ")}`);
        const token = newToken();
        const person = await rt.store.withTenant(id, async (tx) => {
          const added = await tx.insertStaff({ email, name, role: parsedRole.data, tokenHash: hashToken(token) });
          await tx.appendAudit({ actor: "cli:aiops", type: "staff.added", subject: added.email, data: { role: added.role, name: added.name } });
          return added;
        });
        console.log(`Added ${person.name} <${person.email}> as ${person.role} for ${id}.`);
        console.log("Send them this line privately. It is shown once and works until you remove them:\n");
        console.log(connectCommand(publicUrl(), token));
        return 0;
      }
      if (sub === "list") {
        const people = await rt.store.withTenant(id, (tx) => tx.listStaff());
        for (const p of people) {
          console.log(`${p.revokedAt ? "removed " : "active  "} ${p.role.padEnd(8)} ${p.email.padEnd(32)} ${p.name}`);
        }
        return 0;
      }
      if (sub === "remove") {
        if (!email) throw new UsageError("users remove needs --email");
        const removed = await rt.store.withTenant(id, async (tx) => {
          const done = await tx.revokeStaff(email);
          if (done) await tx.appendAudit({ actor: "cli:aiops", type: "staff.removed", subject: email.toLowerCase(), data: {} });
          return done;
        });
        console.log(removed ? `Removed ${email}. Their token stops working now.` : `No active person ${email} at ${id}.`);
        return removed ? 0 : 1;
      }
      throw new UsageError(`Unknown "users ${sub ?? ""}". Try: aiops help`);
    });
  }
  if (command === "approvals") {
    const { company } = flags([sub, ...rest].filter((a): a is string => a !== undefined));
    return withRuntime(async (rt) => {
      const id = pickCompany([...rt.source.packs.keys()], company);
      const pending = await pendingApprovals(rt, id);
      if (pending.length === 0) console.log(`${id}: nothing is waiting for approval.`);
      for (const p of pending) {
        console.log(`${p.id}  ${p.tool.padEnd(18)} by ${p.requested_by}  expires ${p.expires_at}${p.reason ? `\n    ${p.reason}` : ""}`);
      }
      return 0;
    });
  }
  if (command === "approve" || command === "reject") {
    const actionId = sub;
    const { company, as, note, yes } = flags(rest);
    if (!actionId || actionId.startsWith("--")) throw new UsageError(`aiops ${command} needs the action id first. See: aiops approvals`);
    if (!as) throw new UsageError(`aiops ${command} needs --as EMAIL: the approver making this decision`);
    if (command === "reject" && !note) throw new UsageError("aiops reject needs --note with the reason");
    return withRuntime(async (rt) => {
      const id = pickCompany([...rt.source.packs.keys()], company);
      const { action, fingerprint, approver } = await prepareDecision(rt, id, actionId, as);
      if (command === "reject") {
        const rejected = await rejectFromCli(rt, id, actionId, approver, note!);
        console.log(`Rejected ${rejected.id}. It will not run.`);
        return 0;
      }
      console.log(describeForApproval(action, fingerprint));
      if (!yes) {
        if (!process.stdin.isTTY) throw new UsageError("Not an interactive terminal: read the action above, then run again with --yes to approve it.");
        const rl = createInterface({ input: process.stdin, output: process.stdout });
        const answer = (await rl.question(`\nApprove and run this now as ${approver}? Type yes: `)).trim().toLowerCase();
        rl.close();
        if (answer !== "yes") {
          console.log("Not approved. It is still waiting.");
          return 1;
        }
      }
      const outcome = await approveFromCli(rt, id, actionId, approver, fingerprint, note);
      if (!outcome.ok) throw outcome.error;
      const a = outcome.action;
      console.log(a.status === "executed" ? `Approved and done: ${JSON.stringify(a.result)}` : `Approved, but it ${a.status}: ${a.error ?? ""}`);
      return a.status === "executed" ? 0 : 1;
    });
  }
  if (command === "mail" && sub === "poll") {
    const { company } = flags(rest);
    return withRuntime(async (rt) => {
      const ids = company ? [pickCompany([...rt.source.packs.keys()], company)] : [...rt.source.packs.keys()];
      let failed = false;
      for (const id of ids) {
        if (!rt.connectors.get(id)?.mailbox) {
          console.log(`${id}: no mailbox connected`);
          continue;
        }
        const r = await pollMailbox(rt, id);
        console.log(`${id}: ${r.fetched} new, ${r.handled} handled${r.stoppedAt ? `; stopped at ${r.stoppedAt.messageId}: ${r.stoppedAt.reason}` : ""}`);
        if (r.stoppedAt) failed = true;
      }
      return failed ? 1 : 0;
    });
  }
  throw new UsageError(`Unknown command "${argv.join(" ")}". Try: aiops help`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  run(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((error: unknown) => {
      if (error instanceof UsageError || error instanceof OpsdeskError) console.error(error.message);
      else console.error(error);
      process.exit(1);
    });
}
