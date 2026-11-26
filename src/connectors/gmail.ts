import type { InboundEmailInput } from "../core/types.ts";
import { RefreshingToken, requestJson, type Fetch } from "./http.ts";
import type { MailboxConnector } from "./types.ts";

const API = "https://gmail.googleapis.com/gmail/v1/users/me";

export interface GmailOptions {
  address: string;
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}

interface GmailPart {
  mimeType?: string;
  body?: { data?: string };
  parts?: GmailPart[];
}

interface GmailMessage {
  id: string;
  threadId: string;
  internalDate: string;
  payload: GmailPart & { headers: { name: string; value: string }[] };
}

const fromBase64Url = (data: string) => Buffer.from(data.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
const toBase64Url = (text: string) => Buffer.from(text, "utf8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/** The first text/plain part, else text/html with the tags stripped. */
export function plainText(part: GmailPart): string {
  const find = (p: GmailPart, type: string): string | null => {
    if (p.mimeType === type && p.body?.data) return fromBase64Url(p.body.data);
    for (const child of p.parts ?? []) {
      const hit = find(child, type);
      if (hit) return hit;
    }
    return null;
  };
  const text = find(part, "text/plain");
  if (text) return text;
  const html = find(part, "text/html");
  return html ? html.replace(/<style[\s\S]*?<\/style>/gi, "").replace(/<[^>]+>/g, " ").replace(/\s+\n/g, "\n").trim() : "";
}

/**
 * One Gmail or Google Workspace mailbox through OAuth (scopes gmail.readonly
 * and gmail.send). Reads the inbox newer than the saved position; replies are
 * sent only by the executor after approval.
 */
export class GmailMailbox implements MailboxConnector {
  readonly kind = "gmail";
  private readonly fetchFn: Fetch;
  private readonly token: RefreshingToken;
  private readonly address: string;

  constructor(options: GmailOptions, fetchFn: Fetch = fetch) {
    this.fetchFn = fetchFn;
    this.address = options.address;
    this.token = new RefreshingToken(
      fetchFn,
      "https://oauth2.googleapis.com/token",
      { client_id: options.clientId, client_secret: options.clientSecret, refresh_token: options.refreshToken },
      "Google",
    );
  }

  private async get<T>(path: string, what: string): Promise<T | null> {
    return requestJson<T>(this.fetchFn, `${API}${path}`, { headers: { authorization: `Bearer ${await this.token.get()}` } }, `Gmail ${what}`);
  }

  async fetchNew(since?: string): Promise<InboundEmailInput[]> {
    // Gmail's search works in whole seconds; anything seen twice is dropped later by Message-ID.
    const after = since ? Math.floor(Date.parse(since) / 1000) : Math.floor(Date.now() / 1000) - 86_400;
    const list = await this.get<{ messages?: { id: string }[] }>(
      `/messages?maxResults=50&q=${encodeURIComponent(`in:inbox after:${after}`)}`,
      "list",
    );
    const out: InboundEmailInput[] = [];
    for (const { id } of list?.messages ?? []) {
      const m = await this.get<GmailMessage>(`/messages/${id}?format=full`, "read");
      if (!m) continue;
      const header = (name: string) => m.payload.headers.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? "";
      out.push({
        messageId: header("Message-ID") || `<gmail-${m.id}@gmail.com>`,
        from: header("From"),
        to: header("To") || this.address,
        subject: header("Subject"),
        text: plainText(m.payload).slice(0, 100_000),
        receivedAt: new Date(Number(m.internalDate)).toISOString(),
      });
    }
    return out.sort((a, b) => Date.parse(a.receivedAt!) - Date.parse(b.receivedAt!));
  }

  async sendReply(reply: { inReplyTo: string; to: string; subject: string; text: string }): Promise<{ messageId: string }> {
    const subject = /^re:/i.test(reply.subject) ? reply.subject : `Re: ${reply.subject}`;
    const raw = [
      `From: ${this.address}`,
      `To: ${reply.to}`,
      `Subject: ${subject}`,
      `In-Reply-To: ${reply.inReplyTo}`,
      `References: ${reply.inReplyTo}`,
      "Content-Type: text/plain; charset=UTF-8",
      "",
      reply.text,
    ].join("\r\n");
    const sent = await requestJson<{ id: string }>(
      this.fetchFn,
      `${API}/messages/send`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${await this.token.get()}`, "content-type": "application/json" },
        body: JSON.stringify({ raw: toBase64Url(raw) }),
      },
      "Gmail send",
    );
    return { messageId: sent?.id ?? "" };
  }
}
