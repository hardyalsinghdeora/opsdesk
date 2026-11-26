import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { hashToken, newToken, type Role } from "../src/auth/principal.ts";
import { createApp } from "../src/http/app.ts";
import type { Runtime } from "../src/runtime.ts";
import { MemoryStore } from "../src/store/memory.ts";
import { handleInboundEmail } from "../src/pipelines/email-intake.ts";
import { fixture, runtimeWith } from "./helpers.ts";

/**
 * End to end over HTTP with the official MCP client, as Claude Code connects:
 * one token per person, and a tool list shaped by company config and role.
 */
describe("MCP endpoint", () => {
  let rt: Runtime;
  let server: Server;
  let base: string;
  const tokens: Record<string, string> = {};

  async function person(tenant: string, email: string, role: Role) {
    const token = newToken();
    await rt.store.withTenant(tenant, (tx) => tx.insertStaff({ email, name: email, role, tokenHash: hashToken(token) }));
    tokens[email] = token;
  }

  async function connect(token: string | undefined) {
    const client = new Client({ name: "opsdesk-test", version: "1.0.0" });
    const headers: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {};
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers } }));
    return client;
  }

  async function call(email: string, name: string, args: Record<string, unknown> = {}) {
    const client = await connect(tokens[email]);
    try {
      const res = (await client.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
      return { text: res.content[0]!.text, isError: res.isError === true };
    } finally {
      await client.close();
    }
  }

  async function toolNames(email: string) {
    const client = await connect(tokens[email]);
    try {
      return (await client.listTools()).tools;
    } finally {
      await client.close();
    }
  }

  before(async () => {
    rt = await runtimeWith(new MemoryStore());
    await person("gulfcool", "maya@gulfcool.example", "staff");
    await person("gulfcool", "viewer@gulfcool.example", "viewer");
    await person("northwind", "lee@northwind.example", "staff");
    server = createApp(rt).listen(0, "127.0.0.1");
    await new Promise((resolve) => server.once("listening", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  it("answers the health check without a token", async () => {
    const res = await fetch(`${base}/healthz`);
    assert.equal(res.status, 200);
  });

  it("refuses requests without a valid token", async () => {
    for (const auth of [undefined, "Bearer ods_not-a-real-token", "Bearer something-else"]) {
      const res = await fetch(`${base}/mcp`, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...(auth ? { authorization: auth } : {}) },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      });
      assert.equal(res.status, 401);
    }
  });

  it("tells each person who they are and which company they belong to", async () => {
    const me = JSON.parse((await call("lee@northwind.example", "whoami")).text);
    assert.deepEqual(me, { company: "Northwind Freight", email: "lee@northwind.example", role: "staff" });
  });

  it("never offers a disabled tool: quote.issue exists for GulfCool, not for Northwind", async () => {
    const gulf = (await toolNames("maya@gulfcool.example")).find((t) => t.name === "request_action")!;
    const north = (await toolNames("lee@northwind.example")).find((t) => t.name === "request_action")!;
    const options = (t: typeof gulf) => (t.inputSchema.properties!.tool as { enum: string[] }).enum;
    assert.deepEqual(options(gulf), ["crm.create_lead", "email.send_reply", "quote.issue"]);
    assert.deepEqual(options(north), ["crm.create_lead"]);
  });

  it("describes each tool's input so the model can fill it in", async () => {
    const tools = JSON.parse((await call("maya@gulfcool.example", "list_tools")).text);
    const quote = tools.find((t: { name: string }) => t.name === "quote.issue");
    assert.equal(quote.approval, "required");
    assert.ok(quote.input_schema.properties.items);
  });

  it("gives a viewer read tools only", async () => {
    const names = (await toolNames("viewer@gulfcool.example")).map((t) => t.name);
    assert.ok(names.includes("list_actions"));
    assert.ok(!names.includes("request_action"));
  });

  it("routes a request through the gateway: a quote waits for approval", async () => {
    const res = await call("maya@gulfcool.example", "request_action", {
      tool: "quote.issue",
      input: { customer: { name: "Omar", email: "omar@example.com" }, items: [{ code: "AC-SERVICE", quantity: 3 }], source_ref: null },
      reason: "Customer asked for a service quote on the phone",
      idempotency_key: "mcp-test-quote-0001",
    });
    assert.equal(res.isError, false, res.text);
    const action = JSON.parse(res.text);
    assert.equal(action.status, "pending_approval");
    assert.equal(action.tool, "quote.issue");
  });

  it("keeps companies apart: Northwind cannot see GulfCool's actions", async () => {
    const north = JSON.parse((await call("lee@northwind.example", "list_actions")).text);
    assert.equal(north.length, 0);
    const gulf = JSON.parse((await call("maya@gulfcool.example", "list_actions", { status: "pending_approval" })).text);
    assert.equal(gulf.length, 1);
  });

  it("follows a runtime switch on the very next call", async () => {
    await rt.store.withTenant("gulfcool", (tx) => tx.setOverrides({ tools: { "quote.issue": { enabled: false } } }));
    try {
      const tool = (await toolNames("maya@gulfcool.example")).find((t) => t.name === "request_action")!;
      assert.deepEqual((tool.inputSchema.properties!.tool as { enum: string[] }).enum, ["crm.create_lead", "email.send_reply"]);
      const wfs = JSON.parse((await call("maya@gulfcool.example", "list_workflows")).text);
      assert.equal(wfs.find((w: { id: string }) => w.id === "sales_enquiry").active, false);
    } finally {
      await rt.store.withTenant("gulfcool", (tx) => tx.setOverrides({}));
    }
  });

  it("locks out a removed person immediately", async () => {
    await rt.store.withTenant("gulfcool", (tx) => tx.revokeStaff("viewer@gulfcool.example"));
    await assert.rejects(connect(tokens["viewer@gulfcool.example"]));
  });

  it("verifies the audit log over MCP", async () => {
    const result = JSON.parse((await call("maya@gulfcool.example", "verify_audit")).text);
    assert.equal(result.ok, true);
  });

  it("shows emails waiting for a person, and lets staff (not viewers) close them", async () => {
    const parked = await handleInboundEmail(rt, "gulfcool", fixture("gulfcool-refusal"));
    await person("gulfcool", "reader@gulfcool.example", "viewer");

    const queue = JSON.parse((await call("reader@gulfcool.example", "list_review_queue")).text);
    const item = queue.find((q: { id: string }) => q.id === parked.inboundId);
    assert.ok(item, "the parked email is in the queue");
    assert.match(item.why, /refusal/);
    assert.ok(!(await toolNames("reader@gulfcool.example")).some((t) => t.name === "resolve_review"));

    const res = await call("maya@gulfcool.example", "resolve_review", { inbound_id: parked.inboundId, outcome: "handled", note: "Called the customer back" });
    assert.equal(res.isError, false, res.text);
    const after = JSON.parse((await call("maya@gulfcool.example", "list_review_queue")).text);
    assert.ok(!after.some((q: { id: string }) => q.id === parked.inboundId));
    const again = await call("maya@gulfcool.example", "resolve_review", { inbound_id: parked.inboundId, outcome: "handled", note: "twice" });
    assert.equal(again.isError, true);
    const audit = await rt.store.withTenant("gulfcool", (tx) => tx.listAudit());
    assert.equal(audit.at(-1)?.type, "email.review_resolved");
    assert.equal(audit.at(-1)?.actor, "maya@gulfcool.example");
  });

  it("keeps one company's review queue from another", async () => {
    const north = JSON.parse((await call("lee@northwind.example", "list_review_queue")).text);
    assert.equal(north.length, 0);
  });
});
