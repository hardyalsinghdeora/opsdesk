import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { FakeMailbox } from "../src/connectors/fakes.ts";
import { createDemo, DEMO_EMAILS, type Delivered, type Demo } from "../src/demo/demo.ts";
import { createApp } from "../src/http/app.ts";

/**
 * The recording, as a test: every step of the demo script, through the real
 * MCP endpoint, with clients playing Maya, Omar and Lee.
 */
describe("the demo walkthrough", () => {
  let demo: Demo;
  let server: Server;
  let base: string;
  const delivered: Delivered[] = [];

  async function as(label: string, approve?: boolean) {
    const token = demo.people.find((p) => p.label === label)!.token;
    const client = new Client({ name: label, version: "1.0.0" }, { capabilities: approve === undefined ? {} : { elicitation: {} } });
    if (approve !== undefined) {
      client.setRequestHandler(ElicitRequestSchema, async () => ({ action: "accept", content: { approve, note: "Looks right" } }));
    }
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
    const call = async (name: string, args: Record<string, unknown> = {}) => {
      const res = (await client.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
      return { text: res.content[0]!.text, isError: res.isError === true };
    };
    return { client, call };
  }

  before(async () => {
    demo = await createDemo({ tokens: { maya: "ods_demo-maya-0000000000000000000000000000", omar: "ods_demo-omar-00000000000000000000000000000" } });
    server = createApp(demo.rt).listen(0, "127.0.0.1");
    await new Promise((resolve) => server.once("listening", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    for (let d = await demo.deliverNext(); d; d = await demo.deliverNext()) delivered.push(d);
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  it("keeps the tokens it was given, so a person's Claude Code setup survives restarts", () => {
    assert.equal(demo.people.find((p) => p.label === "maya")!.token, "ods_demo-maya-0000000000000000000000000000");
    assert.match(demo.people.find((p) => p.label === "lee")!.token, /^ods_/);
  });

  it("delivers each email once, in order, with an outcome a viewer can follow", () => {
    assert.equal(delivered.length, DEMO_EMAILS.length);
    assert.equal(demo.remaining(), 0);
    const [quote, service, injection, repeat, freight] = delivered;
    assert.match(quote!.outcome, /lead done, quote waiting for approval \(AED 1,617\.00\)/);
    assert.equal(service!.workflow, "general_enquiry");
    assert.match(service!.outcome, /lead waiting for approval/);
    assert.match(injection!.outcome, /parked for a person to review/);
    assert.doesNotMatch(injection!.outcome, /done/);
    assert.match(repeat!.outcome, /quote waiting for approval/);
    assert.equal(freight!.tenant, "northwind");
  });

  it("recognises the returning customer: one contact, two leads", async () => {
    const contacts = await demo.rt.store.withTenant("gulfcool", (tx) => tx.listContacts());
    assert.equal(contacts.filter((c) => c.email === "sara.khan@villa.example").length, 1);
  });

  it("runs the recorded flow: Maya asks for a reply, Omar approves it, it is sent and logged", async () => {
    const maya = await as("maya");
    const emails = JSON.parse((await maya.call("list_emails")).text) as { id: string; subject: string }[];
    const sara = emails.find((e) => e.subject === "Quote for AC servicing before summer")!;
    const asked = await maya.call("request_action", {
      tool: "email.send_reply",
      input: { inbound_id: sara.id, text: "Thank you, Sara. Your quote is AED 1,617.00 including VAT." },
      reason: "Reply to Sara's quote request",
    });
    await maya.client.close();
    assert.equal(asked.isError, false, asked.text);
    const action = JSON.parse(asked.text);
    assert.equal(action.status, "pending_approval");

    const omar = await as("omar", true);
    const approved = await omar.call("approve_action", { id: action.id });
    await omar.client.close();
    assert.equal(JSON.parse(approved.text).status, "executed", approved.text);
    const sent = (demo.rt.connectors.get("gulfcool")!.mailbox as FakeMailbox).sent;
    assert.deepEqual(sent.map((m) => m.to), ["sara.khan@villa.example"]);
  });

  it("refuses the failure cases from the script", async () => {
    const maya = await as("maya");
    const pending = JSON.parse((await maya.call("list_actions", { status: "pending_approval" })).text) as { id: string }[];
    const tools = (await maya.client.listTools()).tools.map((t) => t.name);
    await maya.client.close();
    assert.ok(pending.length > 0);
    assert.ok(!tools.includes("approve_action"), "staff cannot approve anything");

    const lee = await as("lee");
    const theirs = JSON.parse((await lee.call("list_actions")).text) as { tool: string }[];
    const leeEmails = JSON.parse((await lee.call("list_emails")).text) as { from: string }[];
    await lee.client.close();
    assert.ok(theirs.length > 0);
    assert.ok(leeEmails.every((e) => !/villa\.example|billing-update/.test(e.from)), "Northwind sees none of GulfCool's mail");
  });
});
