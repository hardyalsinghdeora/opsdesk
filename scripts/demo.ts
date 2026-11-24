/**
 * A narrated run through the platform, over real HTTP, with no API key or
 * database needed. `npm run demo`
 *
 *   1. GulfCool (HVAC, AED): quote request -> lead created, quote held for approval
 *   2. An operator approves -> quote issued
 *   3. Failure: the same email arrives again -> nothing happens twice
 *   4. Northwind (freight, USD): same code, different pack -> no quote tool, lead needs approval
 *   5. Failure: someone calls a disabled tool directly -> refused and audited
 *   6. Failure: the model declines -> email parked for a person, no actions
 *   7. Failure: someone edits the audit log -> verification catches it
 */
import type { AddressInfo } from "node:net";
import { createApp } from "../src/app.ts";
import { ApiKeys } from "../src/http/auth.ts";
import { createRuntime, scopeFor } from "../src/runtime.ts";
import { MemoryStore } from "../src/store/memory.ts";
import { fixture } from "../test/helpers.ts";

const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;

const store = new MemoryStore();
const rt = await createRuntime({ store });
const keys = new ApiKeys();
const K = {
  gIngest: "demo-gulfcool-ingest-key",
  gOps: "demo-gulfcool-operator-key",
  nIngest: "demo-northwind-ingest-key",
  nOps: "demo-northwind-operator-key",
};
keys.add(K.gIngest, { tenantId: "gulfcool", actor: "mailhook@gulfcool", role: "ingest" });
keys.add(K.gOps, { tenantId: "gulfcool", actor: "maya@gulfcool", role: "operator" });
keys.add(K.nIngest, { tenantId: "northwind", actor: "mailhook@northwind", role: "ingest" });
keys.add(K.nOps, { tenantId: "northwind", actor: "lee@northwind", role: "operator" });

const server = createApp(rt, keys).listen(0);
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

async function call(method: string, path: string, key: string, body?: unknown) {
  const res = await fetch(base + path, {
    method,
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as any };
}

function step(n: number, title: string) {
  console.log(`\n${bold(`${n}. ${title}`)}`);
}

function showActions(actions: any[]) {
  for (const a of actions) {
    const state = a.status === "executed" ? green(a.status) : a.status === "pending_approval" ? bold(a.status) : red(a.status);
    console.log(`   ${a.tool.padEnd(16)} ${state}${a.reason ? dim(`  (${a.reason})`) : ""}`);
    if (a.tool === "quote.issue" && a.preview) {
      for (const l of a.preview.lines) console.log(dim(`      ${l.quantity} x ${l.name} @ ${l.unit_price} = ${l.line_total}`));
      console.log(dim(`      subtotal ${a.preview.subtotal}, VAT ${a.preview.tax}, total ${a.preview.total}`));
    }
  }
}

try {
  step(1, "GulfCool receives a quote request");
  const e1 = fixture("gulfcool-quote");
  console.log(dim(`   "${e1.subject}" from ${e1.from}`));
  const r1 = await call("POST", "/t/gulfcool/inbound/email", K.gIngest, e1);
  console.log(`   extracted: ${JSON.stringify(r1.body.extraction.custom_fields)}, confidence ${r1.body.extraction.confidence}`);
  showActions(r1.body.actions);

  step(2, "An operator approves the quote");
  const quote = r1.body.actions.find((a: any) => a.tool === "quote.issue");
  const r2 = await call("POST", `/t/gulfcool/actions/${quote.id}/approve`, K.gOps, { note: "matches site survey" });
  const [issued] = (await call("GET", "/t/gulfcool/quotes", K.gOps)).body;
  console.log(`   ${green(r2.body.status)} by ${r2.body.decidedBy}: quote ${issued.number}, ${issued.currency} ${(issued.totalMinor / 100).toFixed(2)}`);

  step(3, "Failure case: the mail server delivers the same email again");
  const r3 = await call("POST", "/t/gulfcool/inbound/email", K.gIngest, e1);
  const leads = (await call("GET", "/t/gulfcool/leads", K.gOps)).body;
  console.log(`   status ${r3.body.status}; leads in CRM: ${leads.length}; quotes: 1`);

  step(4, "Northwind, a freight company: same code, its own config pack");
  const e4 = fixture("northwind-quote");
  console.log(dim(`   "${e4.subject}"`));
  const r4 = await call("POST", "/t/northwind/inbound/email", K.nIngest, e4);
  console.log(`   extracted: ${JSON.stringify(r4.body.extraction.custom_fields)}`);
  showActions(r4.body.actions);
  const tools = (await call("GET", "/t/northwind/tools", K.nOps)).body.tools.map((t: any) => `${t.name} (${t.approval})`);
  console.log(dim(`   tools enabled for Northwind: ${tools.join(", ")}; quote.issue is off, so it was never offered to the model`));

  step(5, "Failure case: code tries to issue a quote for Northwind anyway");
  const outcome = await rt.store.withTenant("northwind", async (tx) =>
    rt.gateway.request(await scopeFor(rt, tx), {
      tool: "quote.issue",
      actor: "script:rogue",
      idempotencyKey: "rogue-1",
      input: { customer: { name: null, email: null }, items: [{ code: "X", quantity: 1, note: null }] },
    }),
  );
  console.log(`   ${red(outcome.ok ? "allowed?!" : `refused: ${outcome.error.message}`)}`);
  const lastNorth = (await call("GET", "/t/northwind/audit", K.nOps)).body.at(-1);
  console.log(dim(`   audit #${lastNorth.seq}: ${lastNorth.type} by ${lastNorth.actor} (${lastNorth.data.reason})`));

  step(6, "Failure case: the model declines to process an email");
  const r6 = await call("POST", "/t/gulfcool/inbound/email", K.gIngest, fixture("gulfcool-refusal"));
  console.log(`   status ${bold(r6.body.status)}, actions proposed: ${r6.body.actions.length}`);

  step(7, "Failure case: someone edits an audit entry directly in storage");
  console.log(`   before: ${JSON.stringify((await call("GET", "/t/gulfcool/audit/verify", K.gOps)).body)}`);
  const row = store.unsafeAuditRows("gulfcool").find((e) => e.type === "action.approved")!;
  row.actor = "someone-else@gulfcool";
  const after = (await call("GET", "/t/gulfcool/audit/verify", K.gOps)).body;
  console.log(`   after:  ${red(JSON.stringify(after))}`);

  console.log(`\n${bold("GulfCool audit trail")}`);
  for (const e of (await call("GET", "/t/gulfcool/audit", K.gOps)).body) {
    console.log(dim(`   #${String(e.seq).padStart(2)} ${e.type.padEnd(24)} ${e.actor}`));
  }
} finally {
  server.close();
}
