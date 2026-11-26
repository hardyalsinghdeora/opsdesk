import { requestJson, type Fetch } from "./http.ts";
import type { CrmConnector, CrmContact } from "./types.ts";

const API = "https://api.hubapi.com";
const PROPERTIES = ["email", "firstname", "lastname", "phone", "company"];

interface HubspotObject {
  id: string;
  properties: Record<string, string | null>;
}

function splitName(name: string | null): { firstname?: string; lastname?: string } {
  if (!name) return {};
  const parts = name.trim().split(/\s+/);
  return parts.length === 1 ? { firstname: parts[0] } : { firstname: parts.slice(0, -1).join(" "), lastname: parts.at(-1) };
}

function toContact(o: HubspotObject): CrmContact {
  const p = o.properties;
  const name = [p.firstname, p.lastname].filter(Boolean).join(" ") || null;
  return { externalId: o.id, name, email: p.email ?? null, phone: p.phone ?? null, company: p.company ?? null };
}

/**
 * HubSpot contacts through a private-app token (CRM v3 API). The enquiry
 * itself is attached to the contact as a note. Needs the scopes
 * crm.objects.contacts.read and crm.objects.contacts.write.
 */
export class HubspotCrm implements CrmConnector {
  readonly kind = "hubspot";
  private readonly fetchFn: Fetch;
  private readonly token: string;

  constructor(token: string, fetchFn: Fetch = fetch) {
    this.token = token;
    this.fetchFn = fetchFn;
  }

  private call<T>(method: string, path: string, body: unknown, what: string): Promise<T | null> {
    return requestJson<T>(
      this.fetchFn,
      `${API}${path}`,
      {
        method,
        headers: { authorization: `Bearer ${this.token}`, "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      },
      `HubSpot ${what}`,
    );
  }

  async findContact(query: { email?: string; phone?: string }): Promise<CrmContact | null> {
    const filters = query.email
      ? [{ propertyName: "email", operator: "EQ", value: query.email.toLowerCase() }]
      : query.phone
        ? [{ propertyName: "phone", operator: "EQ", value: query.phone }]
        : null;
    if (!filters) return null;
    const res = await this.call<{ results: HubspotObject[] }>(
      "POST",
      "/crm/v3/objects/contacts/search",
      { filterGroups: [{ filters }], properties: PROPERTIES, limit: 1 },
      "contact search",
    );
    const hit = res?.results[0];
    return hit ? toContact(hit) : null;
  }

  async upsertLead(lead: Parameters<CrmConnector["upsertLead"]>[0]): Promise<{ externalId: string; created: boolean }> {
    const existing = await this.findContact({ email: lead.email ?? undefined, phone: lead.phone ?? undefined });
    const properties: Record<string, string> = {};
    for (const [k, v] of Object.entries({ email: lead.email?.toLowerCase(), phone: lead.phone, ...splitName(lead.name) })) {
      if (v) properties[k] = v;
    }

    let id: string;
    if (existing) {
      // Only fill what HubSpot does not have yet; never overwrite a person's own edits.
      const fill: Record<string, string> = {};
      if (!existing.email && properties.email) fill.email = properties.email;
      if (!existing.phone && properties.phone) fill.phone = properties.phone;
      if (!existing.name) {
        if (properties.firstname) fill.firstname = properties.firstname;
        if (properties.lastname) fill.lastname = properties.lastname;
      }
      if (Object.keys(fill).length > 0) await this.call("PATCH", `/crm/v3/objects/contacts/${existing.externalId}`, { properties: fill }, "contact update");
      id = existing.externalId;
    } else {
      const created = await this.call<HubspotObject>("POST", "/crm/v3/objects/contacts", { properties }, "contact create");
      id = created!.id;
    }

    const fields = Object.entries(lead.fields)
      .filter(([, v]) => v)
      .map(([k, v]) => `${k}: ${v}`)
      .join("\n");
    await this.call(
      "POST",
      "/crm/v3/objects/notes",
      {
        properties: { hs_timestamp: new Date().toISOString(), hs_note_body: [lead.summary, fields].filter(Boolean).join("\n\n") },
        // 202 = note to contact, HubSpot's built-in association type.
        associations: [{ to: { id }, types: [{ associationCategory: "HUBSPOT_DEFINED", associationTypeId: 202 }] }],
      },
      "note create",
    );
    return { externalId: id, created: !existing };
  }
}
