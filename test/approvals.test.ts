import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, describe, it } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ElicitRequestSchema, type ElicitResult } from "@modelcontextprotocol/sdk/types.js";
import { hashToken, newToken, type Role } from "../src/auth/principal.ts";
import { approveFromCli, pendingApprovals, prepareDecision, rejectFromCli } from "../src/cli/approvals.ts";
import type { FakeMailbox } from "../src/connectors/fakes.ts";
import { actionFingerprint, unwrap } from "../src/gateway/gateway.ts";
import { createApp } from "../src/http/app.ts";
import { handleInboundEmail } from "../src/pipelines/email-intake.ts";
import { createRuntime, type Runtime } from "../src/runtime.ts";
import { MemoryStore } from "../src/store/memory.ts";
import { fixture, inScope, runtimeWith, storeFactories } from "./helpers.ts";

type Answer = ElicitResult | ((message: string) => ElicitResult);

/**
 * Approvals end to end: Claude Code is played by the official MCP client,
 * and the person answering the approval prompt by an elicitation handler.
 */
describe("approvals over MCP", () => {
  let rt: Runtime;
  let server: Server;
  let base: string;
  const tokens: Record<string, string> = {};

  async function person(email: string, role: Role, tenant = "gulfcool") {
    const token = newToken();
    await rt.store.withTenant(tenant, (tx) => tx.insertStaff({ email, name: email, role, tokenHash: hashToken(token) }));
    tokens[email] = token;
  }

  /** A connected client; `answer` decides how the "person" responds to approval prompts (omit = app without prompts). */
  async function connect(email: string, answer?: Answer) {
    const client = new Client({ name: "approvals-test", version: "1.0.0" }, { capabilities: answer ? { elicitation: {} } : {} });
    const prompts: string[] = [];
    if (answer) {
      client.setRequestHandler(ElicitRequestSchema, async (req) => {
        const message = String(req.params.message);
        prompts.push(message);
        return typeof answer === "function" ? answer(message) : answer;
      });
    }
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${tokens[email]}` } } }));
    const call = async (name: string, args: Record<string, unknown> = {}) => {
      const res = (await client.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
      return { text: res.content[0]!.text, isError: res.isError === true, json: () => JSON.parse(res.content[0]!.text) };
    };
    return { client, call, prompts };
  }

  async function quoteRequestedBy(email: string, key: string) {
    const { client, call } = await connect(email);
    const res = await call("request_action", {
      tool: "quote.issue",
      input: { customer: { name: "Omar", email: "omar@example.com" }, items: [{ code: "AC-SERVICE", quantity: 2 }] },
      reason: "Phone request",
      idempotency_key: key,
    });
    await client.close();
    assert.equal(res.isError, false, res.text);
    return res.json().id as string;
  }

  before(async () => {
    rt = await runtimeWith(new MemoryStore());
    await person("maya@gulfcool.example", "staff");
    await person("omar@gulfcool.example", "approver");
    await person("lee@northwind.example", "approver", "northwind");
    server = createApp(rt).listen(0, "127.0.0.1");
    await new Promise((resolve) => server.once("listening", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  it("shows the person exactly what will run, and runs it only after they confirm", async () => {
    const id = await quoteRequestedBy("maya@gulfcool.example", "appr-0001");
    const omar = await connect("omar@gulfcool.example", { action: "accept", content: { approve: true, note: "Checked with the site survey" } });
    const res = await omar.call("approve_action", { id });
    await omar.client.close();

    assert.equal(res.isError, false, res.text);
    assert.deepEqual([res.json().approved, res.json().status], [true, "executed"]);
    assert.equal(omar.prompts.length, 1);
    assert.match(omar.prompts[0]!, /quote\.issue[\s\S]*maya@gulfcool\.example[\s\S]*AED 378\.00/);

    const audit = await rt.store.withTenant("gulfcool", (tx) => tx.listAudit());
    const approved = audit.find((e) => e.type === "action.approved" && e.subject === id)!;
    assert.equal(approved.actor, "omar@gulfcool.example");
    assert.deepEqual([(approved.data as any).via, (approved.data as any).note], ["claude-code-prompt", "Checked with the site survey"]);
  });

  it("leaves the action waiting when the person declines or does not tick approve", async () => {
    for (const [n, answer] of [
      [1, { action: "decline" }],
      [2, { action: "accept", content: { approve: false } }],
      [3, { action: "cancel" }],
    ] as const) {
      const id = await quoteRequestedBy("maya@gulfcool.example", `appr-decl-${n}`);
      const omar = await connect("omar@gulfcool.example", answer as ElicitResult);
      const res = await omar.call("approve_action", { id });
      await omar.client.close();
      assert.equal(res.json().approved, false);
      const action = await rt.store.withTenant("gulfcool", (tx) => tx.getAction(id));
      assert.equal(action?.status, "pending_approval");
    }
  });

  it("gives the model no way to supply the decision or the note", async () => {
    const omar = await connect("omar@gulfcool.example", { action: "decline" });
    const tool = (await omar.client.listTools()).tools.find((t) => t.name === "approve_action")!;
    await omar.client.close();
    assert.deepEqual(Object.keys(tool.inputSchema.properties ?? {}), ["id"]);
  });

  it("points to the server command when the app cannot show a prompt", async () => {
    const id = await quoteRequestedBy("maya@gulfcool.example", "appr-noprompt");
    const omar = await connect("omar@gulfcool.example");
    const res = await omar.call("approve_action", { id });
    await omar.client.close();
    assert.equal(res.isError, true);
    assert.match(res.text, new RegExp(`aiops approve ${id} --as omar@gulfcool\\.example`));
  });

  it("does not let a person approve their own request, or staff approve at all", async () => {
    await person("rita@gulfcool.example", "approver");
    const id = await quoteRequestedBy("rita@gulfcool.example", "appr-self");
    const rita = await connect("rita@gulfcool.example", { action: "accept", content: { approve: true } });
    const res = await rita.call("approve_action", { id });
    await rita.client.close();
    assert.equal(res.isError, true);
    assert.match(res.text, /someone else must approve/);
    assert.equal(rita.prompts.length, 0, "no prompt is shown for an approval that cannot succeed");

    const maya = await connect("maya@gulfcool.example", { action: "accept", content: { approve: true } });
    const names = (await maya.client.listTools()).tools.map((t) => t.name);
    await maya.client.close();
    assert.ok(!names.includes("approve_action") && !names.includes("reject_action"));
  });

  it("rejects with a reason under the approver's name", async () => {
    const id = await quoteRequestedBy("maya@gulfcool.example", "appr-rej");
    const omar = await connect("omar@gulfcool.example");
    const res = await omar.call("reject_action", { id, note: "Price agreed by phone" });
    await omar.client.close();
    assert.equal(res.json().status, "rejected");
  });

  it("keeps the tool list current inside one long session", async () => {
    const maya = await connect("maya@gulfcool.example");
    const before = (await maya.client.listTools()).tools.find((t) => t.name === "request_action")!;
    await rt.store.withTenant("gulfcool", (tx) => tx.setOverrides({ tools: { "quote.issue": { enabled: false } } }));
    try {
      const after = (await maya.client.listTools()).tools.find((t) => t.name === "request_action")!;
      const options = (t: typeof before) => (t.inputSchema.properties!.tool as { enum: string[] }).enum;
      assert.ok(options(before).includes("quote.issue"));
      assert.ok(!options(after).includes("quote.issue"));
    } finally {
      await rt.store.withTenant("gulfcool", (tx) => tx.setOverrides({}));
      await maya.client.close();
    }
  });

  it("treats another person's session as unknown, and stops a revoked token mid-session", async () => {
    const maya = await connect("maya@gulfcool.example");
    const sessionId = (maya.client.transport as StreamableHTTPClientTransport).sessionId!;
    const hijack = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${tokens["lee@northwind.example"]}`,
        "mcp-session-id": sessionId,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 9, method: "tools/list" }),
    });
    assert.equal(hijack.status, 404);

    await rt.store.withTenant("gulfcool", (tx) => tx.revokeStaff("maya@gulfcool.example"));
    await assert.rejects(maya.client.listTools());
    await maya.client.close().catch(() => undefined);
  });
});

for (const factory of storeFactories()) {
  describe(`approvals on the server and replies (${factory.name})`, () => {
    let rt: Runtime;
    beforeEach(async () => {
      rt = await runtimeWith(await factory.make());
      await rt.store.withTenant("gulfcool", async (tx) => {
        await tx.insertStaff({ email: "omar@gulfcool.example", name: "Omar", role: "approver", tokenHash: hashToken(newToken()) });
        await tx.insertStaff({ email: "maya@gulfcool.example", name: "Maya", role: "staff", tokenHash: hashToken(newToken()) });
      });
    });

    const quote = async () =>
      unwrap(
        await inScope(rt, "gulfcool", (s) =>
          rt.gateway.request(s, {
            tool: "quote.issue",
            input: { customer: { name: "Ana", email: "ana@example.com" }, items: [{ code: "DUCT-CLEAN", quantity: 1, note: null }], source_ref: null },
            actor: "maya@gulfcool.example",
            idempotencyKey: `cli-${Math.random()}`,
          }),
        ),
      ).action;

    it("lists what is waiting, and approves from the server as a named approver", async () => {
      const action = await quote();
      const pending = await pendingApprovals(rt, "gulfcool");
      assert.deepEqual(pending.map((p) => p.id), [action.id]);

      const { fingerprint, approver } = await prepareDecision(rt, "gulfcool", action.id, "Omar@GulfCool.example");
      const outcome = await approveFromCli(rt, "gulfcool", action.id, approver, fingerprint, "ok");
      assert.equal(unwrap(outcome).action.status, "executed");
      const audit = await rt.store.withTenant("gulfcool", (tx) => tx.listAudit());
      assert.equal((audit.find((e) => e.type === "action.approved")!.data as any).via, "cli");
    });

    it("only lets active approvers decide", async () => {
      const action = await quote();
      await assert.rejects(prepareDecision(rt, "gulfcool", action.id, "maya@gulfcool.example"), /only approvers and owners/);
      await assert.rejects(prepareDecision(rt, "gulfcool", action.id, "stranger@example.com"), /not an active person/);
      const rejected = await rejectFromCli(rt, "gulfcool", action.id, "omar@gulfcool.example", "duplicate");
      assert.equal(rejected.status, "rejected");
    });

    it("refuses to approve an action that differs from the one shown", async () => {
      const action = await quote();
      const outcome = await approveFromCli(rt, "gulfcool", action.id, "omar@gulfcool.example", "0000000000000000");
      assert.equal(outcome.ok, false);
      assert.ok(!outcome.ok && outcome.error.code === "action_changed");
      assert.equal(actionFingerprint(action).length, 16);
    });

    it("sends a reply only to the original sender, in the same thread, after approval", async () => {
      const intake = await handleInboundEmail(rt, "gulfcool", fixture("gulfcool-quote"));
      const requested = unwrap(
        await inScope(rt, "gulfcool", (s) =>
          rt.gateway.request(s, {
            tool: "email.send_reply",
            input: { inbound_id: intake.inboundId, text: "Thank you, your quote is attached." },
            actor: "maya@gulfcool.example",
            idempotencyKey: "reply-1",
          }),
        ),
      ).action;
      assert.equal(requested.status, "pending_approval");
      assert.deepEqual((requested.preview as any).to, "sara.khan@villa.example");
      assert.match((requested.preview as any).subject, /^Re: Quote for AC servicing/);
      assert.match((requested.preview as any).text, /GulfCool Technical Services/);

      const mailbox = rt.connectors.get("gulfcool")!.mailbox as FakeMailbox;
      assert.equal(mailbox.sent.length, 0, "nothing is sent before approval");
      unwrap(await approveFromCli(rt, "gulfcool", requested.id, "omar@gulfcool.example", actionFingerprint(requested)));
      assert.equal(mailbox.sent.length, 1);
      assert.deepEqual([mailbox.sent[0]!.to, mailbox.sent[0]!.inReplyTo], ["sara.khan@villa.example", "<7f3a91@mail.villa.example>"]);
      assert.equal(mailbox.sent[0]!.text, (requested.preview as any).text, "what was approved is what was sent");
    });

    it("never accepts a recipient from the caller, and refuses a reply to an unknown email", async () => {
      const intake = await handleInboundEmail(rt, "gulfcool", fixture("gulfcool-quote"));
      const redirected = await inScope(rt, "gulfcool", (s) =>
        rt.gateway.request(s, {
          tool: "email.send_reply",
          input: { inbound_id: intake.inboundId, text: "hi", to: "attacker@evil.example" },
          actor: "maya@gulfcool.example",
          idempotencyKey: "reply-2",
        }),
      );
      assert.equal(redirected.ok, false);
      const unknown = await inScope(rt, "gulfcool", (s) =>
        rt.gateway.request(s, {
          tool: "email.send_reply",
          input: { inbound_id: "00000000-0000-4000-8000-000000000000", text: "hi" },
          actor: "maya@gulfcool.example",
          idempotencyKey: "reply-3",
        }),
      );
      assert.equal(unknown.ok, false);
    });
  });
}

describe("approval expiry", () => {
  it("expires a request nobody decided in time, so it can no longer run", async () => {
    let now = Date.parse("2026-11-26T09:00:00Z");
    const clock = () => new Date(now);
    const rt = await createRuntime({ store: new MemoryStore(clock), clock });
    const action = unwrap(
      await inScope(rt, "gulfcool", (s) =>
        rt.gateway.request(s, {
          tool: "quote.issue",
          input: { customer: { name: "A", email: "a@example.com" }, items: [{ code: "CALLOUT", quantity: 1, note: null }], source_ref: null },
          actor: "maya@gulfcool.example",
          idempotencyKey: "exp-1",
        }),
      ),
    ).action;

    now += 73 * 3_600_000; // default window is 72 hours
    const outcome = await inScope(rt, "gulfcool", (s) => rt.gateway.approve(s, action.id, "omar@gulfcool.example"));
    assert.equal(outcome.ok, false);
    assert.ok(!outcome.ok && outcome.error.code === "action_expired");
    assert.equal((await rt.store.withTenant("gulfcool", (tx) => tx.getAction(action.id)))?.status, "expired");
  });
});
