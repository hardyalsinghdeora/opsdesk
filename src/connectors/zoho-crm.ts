import { ConnectorError, RefreshingToken, requestJson, type Fetch } from "./http.ts";
import type { CrmConnector, CrmContact } from "./types.ts";

export interface ZohoCrmOptions {
  dataCenter: string;
  module: "Leads" | "Contacts";
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}

type ZohoRecord = Record<string, string | null> & { id: string };

function splitName(name: string | null, email: string | null): { First_Name?: string; Last_Name: string } {
  const parts = (name ?? "").trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { Last_Name: email?.split("@")[0] ?? "Unknown" }; // Zoho requires Last_Name
  if (parts.length === 1) return { Last_Name: parts[0]! };
  return { First_Name: parts.slice(0, -1).join(" "), Last_Name: parts.at(-1)! };
}

/**
 * Zoho CRM through OAuth (a self-client refresh token with the scope
 * ZohoCRM.modules.ALL). Writes go through Zoho's upsert, de-duplicated on
 * Email, into the Leads or Contacts module the pack chooses.
 */
export class ZohoCrm implements CrmConnector {
  readonly kind = "zoho_crm";
  private readonly fetchFn: Fetch;
  private readonly api: string;
  private readonly module: string;
  private readonly token: RefreshingToken;

  constructor(options: ZohoCrmOptions, fetchFn: Fetch = fetch) {
    this.fetchFn = fetchFn;
    this.api = `https://www.zohoapis.${options.dataCenter}/crm/v8`;
    this.module = options.module;
    this.token = new RefreshingToken(
      fetchFn,
      `https://accounts.zoho.${options.dataCenter}/oauth/v2/token`,
      { client_id: options.clientId, client_secret: options.clientSecret, refresh_token: options.refreshToken },
      "Zoho",
    );
  }

  private async call<T>(method: string, path: string, body: unknown, what: string): Promise<T | null> {
    return requestJson<T>(
      this.fetchFn,
      `${this.api}${path}`,
      {
        method,
        headers: { authorization: `Zoho-oauthtoken ${await this.token.get()}`, "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      },
      `Zoho CRM ${what}`,
    );
  }

  async findContact(query: { email?: string; phone?: string }): Promise<CrmContact | null> {
    const param = query.email ? `email=${encodeURIComponent(query.email.toLowerCase())}` : query.phone ? `phone=${encodeURIComponent(query.phone)}` : null;
    if (!param) return null;
    // 204 No Content means no match.
    const res = await this.call<{ data: ZohoRecord[] }>("GET", `/${this.module}/search?${param}`, undefined, "search");
    const r = res?.data?.[0];
    if (!r) return null;
    const name = [r.First_Name, r.Last_Name].filter(Boolean).join(" ") || null;
    return { externalId: r.id, name, email: r.Email ?? null, phone: r.Phone ?? null, company: r.Company ?? r.Account_Name ?? null };
  }

  async upsertLead(lead: Parameters<CrmConnector["upsertLead"]>[0]): Promise<{ externalId: string; created: boolean }> {
    const fields = Object.entries(lead.fields)
      .filter(([, v]) => v)
      .map(([k, v]) => `${k}: ${v}`)
      .join("\n");
    const record: Record<string, string> = {
      ...splitName(lead.name, lead.email),
      Description: [lead.summary, fields].filter(Boolean).join("\n\n"),
    };
    if (lead.email) record.Email = lead.email.toLowerCase();
    if (lead.phone) record.Phone = lead.phone;
    if (this.module === "Leads") record.Company = "Unknown"; // required on Leads; a person corrects it in Zoho

    const res = await this.call<{ data: { code: string; action?: string; message?: string; details?: { id?: string } }[] }>(
      "POST",
      `/${this.module}/upsert`,
      { data: [record], duplicate_check_fields: ["Email"] },
      "upsert",
    );
    const row = res?.data?.[0];
    if (!row || row.code !== "SUCCESS" || !row.details?.id) {
      throw new ConnectorError(`Zoho CRM upsert was not accepted: ${row?.code ?? "no response"} ${row?.message ?? ""}`.trim());
    }
    return { externalId: row.details.id, created: row.action === "insert" };
  }
}
