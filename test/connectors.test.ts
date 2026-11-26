import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { loadConfigSource, resolveCompanyConfig } from "../src/config/loader.ts";
import { createConnectors } from "../src/connectors/factory.ts";
import { GmailMailbox } from "../src/connectors/gmail.ts";
import type { Fetch } from "../src/connectors/http.ts";
import { HubspotCrm } from "../src/connectors/hubspot.ts";
import { ZohoCrm } from "../src/connectors/zoho-crm.ts";
import { ConfigError } from "../src/core/errors.ts";
import { PROJECT_ROOT } from "../src/runtime.ts";

/**
 * These replay each vendor's documented request and response shapes against a
 * stub. They prove what we send and how we read the answer; they do not prove
 * a live account accepts it, which needs a sandbox run before the first client.
 */
interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | undefined;
}

function stub(routes: [RegExp, (call: Call) => { status?: number; json?: unknown }][]) {
  const calls: Call[] = [];
  const fetchFn: Fetch = async (url, init = {}) => {
    const call: Call = {
      url,
      method: init.method ?? "GET",
      headers: Object.fromEntries(Object.entries((init.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v])),
      body: typeof init.body === "string" ? init.body : undefined,
    };
    calls.push(call);
    const route = routes.find(([pattern]) => pattern.test(`${call.method} ${url}`));
    if (!route) throw new Error(`unexpected request ${call.method} ${url}`);
    const { status = 200, json } = route[1](call);
    return new Response(json === undefined ? null : JSON.stringify(json), { status });
  };
  return { fetchFn, calls };
}

const b64url = (text: string) => Buffer.from(text).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

describe("HubSpot", () => {
  it("creates a contact with split names and attaches the enquiry as a note", async () => {
    const { fetchFn, calls } = stub([
      [/POST .*\/contacts\/search$/, () => ({ json: { results: [] } })],
      [/POST .*\/objects\/contacts$/, () => ({ status: 201, json: { id: "101", properties: {} } })],
      [/POST .*\/objects\/notes$/, () => ({ status: 201, json: { id: "n1" } })],
    ]);
    const crm = new HubspotCrm("pat-test", fetchFn);
    const out = await crm.upsertLead({ name: "Sara Al Khan", email: "Sara@Villa.example", phone: "+971501234567", summary: "AC service", fields: { emirate: "Dubai" } });

    assert.deepEqual(out, { externalId: "101", created: true });
    assert.equal(calls[0]!.headers.authorization, "Bearer pat-test");
    assert.deepEqual(JSON.parse(calls[1]!.body!).properties, { email: "sara@villa.example", phone: "+971501234567", firstname: "Sara Al", lastname: "Khan" });
    const note = JSON.parse(calls[2]!.body!);
    assert.match(note.properties.hs_note_body, /AC service[\s\S]*emirate: Dubai/);
    assert.equal(note.associations[0].to.id, "101");
    assert.equal(note.associations[0].types[0].associationTypeId, 202);
  });

  it("never overwrites details a person already has in HubSpot", async () => {
    const { fetchFn, calls } = stub([
      [/POST .*\/contacts\/search$/, () => ({ json: { results: [{ id: "7", properties: { email: "a@x.example", firstname: "Ann", lastname: "Lee", phone: "+1 555" } }] } })],
      [/POST .*\/objects\/notes$/, () => ({ status: 201, json: { id: "n2" } })],
    ]);
    const out = await new HubspotCrm("pat", fetchFn).upsertLead({ name: "Annie L", email: "a@x.example", phone: "+1 999", summary: "s", fields: {} });
    assert.deepEqual(out, { externalId: "7", created: false });
    assert.ok(!calls.some((c) => c.method === "PATCH"));
  });

  it("reports an API error with its status, and no token in the message", async () => {
    const { fetchFn } = stub([[/search$/, () => ({ status: 401, json: { message: "expired" } })]]);
    await assert.rejects(new HubspotCrm("pat-secret-value", fetchFn).findContact({ email: "a@x.example" }), (error: Error) => {
      assert.match(error.message, /HTTP 401/);
      assert.doesNotMatch(error.message, /pat-secret-value/);
      return true;
    });
  });
});

describe("Zoho CRM", () => {
  const options = { dataCenter: "in", module: "Leads" as const, clientId: "cid", clientSecret: "csecret", refreshToken: "rtoken" };

  it("signs in once, then upserts into the right data centre, de-duplicated on Email", async () => {
    const { fetchFn, calls } = stub([
      [/POST https:\/\/accounts\.zoho\.in\/oauth\/v2\/token$/, () => ({ json: { access_token: "at-1", expires_in: 3600 } })],
      [/POST https:\/\/www\.zohoapis\.in\/crm\/v8\/Leads\/upsert$/, () => ({ json: { data: [{ code: "SUCCESS", action: "insert", details: { id: "z-1" } }] } })],
    ]);
    const crm = new ZohoCrm(options, fetchFn);
    const first = await crm.upsertLead({ name: "Tom Reyes", email: "tom@acme.example", phone: null, summary: "2x40ft", fields: { mode: "sea" } });
    await crm.upsertLead({ name: null, email: "x@acme.example", phone: null, summary: "s", fields: {} });

    assert.deepEqual(first, { externalId: "z-1", created: true });
    assert.equal(calls.filter((c) => c.url.includes("oauth")).length, 1, "the token is cached");
    assert.match(calls[0]!.body!, /grant_type=refresh_token/);
    const upsert = calls[1]!;
    assert.equal(upsert.headers.authorization, "Zoho-oauthtoken at-1");
    const body = JSON.parse(upsert.body!);
    assert.deepEqual(body.duplicate_check_fields, ["Email"]);
    const { Description, ...rest } = body.data[0];
    assert.deepEqual(rest, { First_Name: "Tom", Last_Name: "Reyes", Email: "tom@acme.example", Company: "Unknown" });
    assert.match(Description, /2x40ft[\s\S]*mode: sea/);
    assert.equal(JSON.parse(calls[2]!.body!).data[0].Last_Name, "x", "Zoho needs a Last_Name even with no name");
  });

  it("treats 'no content' from search as no match", async () => {
    const { fetchFn } = stub([
      [/oauth/, () => ({ json: { access_token: "at", expires_in: 3600 } })],
      [/GET .*Leads\/search/, () => ({ status: 204 })],
    ]);
    assert.equal(await new ZohoCrm(options, fetchFn).findContact({ email: "none@x.example" }), null);
  });

  it("refuses an upsert Zoho did not accept, and asks to reconnect on a failed sign-in", async () => {
    const rejected = stub([
      [/oauth/, () => ({ json: { access_token: "at", expires_in: 3600 } })],
      [/upsert/, () => ({ json: { data: [{ code: "MANDATORY_NOT_FOUND", message: "required field not found" }] } })],
    ]);
    await assert.rejects(
      new ZohoCrm(options, rejected.fetchFn).upsertLead({ name: "A B", email: "a@b.example", phone: null, summary: "s", fields: {} }),
      /MANDATORY_NOT_FOUND/,
    );
    const signIn = stub([[/oauth/, () => ({ status: 400, json: { error: "invalid_code" } })]]);
    await assert.rejects(new ZohoCrm(options, signIn.fetchFn).findContact({ email: "a@b.example" }), /Reconnect the account/);
  });
});

describe("Gmail", () => {
  const options = { address: "enquiries@gulfcool.example", clientId: "c", clientSecret: "s", refreshToken: "r" };

  it("reads new inbox messages, oldest first, with headers and plain text", async () => {
    const message = (id: string, ms: number, subject: string, part: object) => ({
      id,
      threadId: "t",
      internalDate: String(ms),
      payload: {
        headers: [
          { name: "Message-ID", value: `<${id}@mail.example>` },
          { name: "From", value: "Sara <sara@villa.example>" },
          { name: "Subject", value: subject },
        ],
        ...part,
      },
    });
    const { fetchFn, calls } = stub([
      [/oauth2\.googleapis\.com\/token/, () => ({ json: { access_token: "g-at", expires_in: 3600 } })],
      [/GET .*\/messages\?/, () => ({ json: { messages: [{ id: "m2" }, { id: "m1" }] } })],
      [
        /GET .*\/messages\/m1\?/,
        () => ({
          json: message("m1", 1_700_000_000_000, "First", {
            mimeType: "multipart/alternative",
            parts: [{ mimeType: "text/plain", body: { data: b64url("Hello\nthree units please") } }],
          }),
        }),
      ],
      [/GET .*\/messages\/m2\?/, () => ({ json: message("m2", 1_700_000_100_000, "Second", { mimeType: "text/html", body: { data: b64url("<p>Need a <b>quote</b></p>") } }) })],
    ]);
    const mail = await new GmailMailbox(options, fetchFn).fetchNew("2023-11-14T00:00:00.000Z");

    assert.match(decodeURIComponent(calls[1]!.url), /in:inbox after:1699920000/);
    assert.deepEqual(mail.map((m) => m.messageId), ["<m1@mail.example>", "<m2@mail.example>"]);
    assert.equal(mail[0]!.text, "Hello\nthree units please");
    assert.match(mail[1]!.text, /Need a\s+quote/);
    assert.equal(mail[0]!.to, "enquiries@gulfcool.example");
  });

  it("sends a reply in the same thread", async () => {
    const { fetchFn, calls } = stub([
      [/token/, () => ({ json: { access_token: "g-at", expires_in: 3600 } })],
      [/POST .*\/messages\/send$/, () => ({ json: { id: "sent-1" } })],
    ]);
    const out = await new GmailMailbox(options, fetchFn).sendReply({ inReplyTo: "<m1@mail.example>", to: "sara@villa.example", subject: "Quote", text: "Attached." });
    assert.equal(out.messageId, "sent-1");
    const raw = Buffer.from(JSON.parse(calls[1]!.body!).raw.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
    assert.match(raw, /Subject: Re: Quote/);
    assert.match(raw, /In-Reply-To: <m1@mail\.example>/);
  });
});

describe("connector secrets", () => {
  it("names the missing environment variable at startup, never a value", () => {
    const source = loadConfigSource(PROJECT_ROOT);
    const pack = {
      ...source.packs.get("gulfcool")!,
      connectors: {
        crm: { kind: "zoho_crm", data_center: "in", client_id_ref: "ZOHO_ID", client_secret_ref: "ZOHO_SECRET", refresh_token_ref: "ZOHO_REFRESH" },
      },
    };
    const config = resolveCompanyConfig({ defaults: source.defaults, packs: new Map([["gulfcool", pack]]) }, "gulfcool");
    assert.throws(
      () => createConnectors(config, { env: { ZOHO_ID: "id-value-1", ZOHO_SECRET: "secret-value-2" } }),
      (error: Error) => {
        assert.ok(error instanceof ConfigError);
        assert.match(error.message, /ZOHO_REFRESH/);
        assert.doesNotMatch(error.message, /id-value-1|secret-value-2/);
        return true;
      },
    );
    assert.equal(createConnectors(config, { env: { ZOHO_ID: "x", ZOHO_SECRET: "y", ZOHO_REFRESH: "z" } }).crm?.kind, "zoho_crm");
  });
});
