import type { CompanyConfig } from "../config/schema.ts";
import { ConfigError } from "../core/errors.ts";
import { FakeAccounting, FakeCrm, FakeMailbox } from "./fakes.ts";
import { GmailMailbox } from "./gmail.ts";
import { ConnectorError, secret, type Fetch } from "./http.ts";
import { HubspotCrm } from "./hubspot.ts";
import type { Connectors } from "./types.ts";
import { ZohoCrm } from "./zoho-crm.ts";

/** Connector kinds that have an implementation in this release. */
const AVAILABLE: Record<string, readonly string[]> = {
  mailbox: ["fake", "gmail"],
  crm: ["fake", "zoho_crm", "hubspot"],
  accounting: ["fake"],
  app: [],
  database: [],
};

/**
 * Checks every configured connector has an implementation in this release,
 * so a pack that names one we have not shipped yet stops startup with a
 * clear message instead of failing on the first email.
 */
export function checkConnectors(config: CompanyConfig): void {
  for (const [role, entry] of Object.entries(config.connectors)) {
    if (!entry) continue;
    if (!AVAILABLE[role]?.includes(entry.kind)) {
      throw new ConfigError(
        `Company "${config.id}" connector "${role}" uses "${entry.kind}", which is not available in this release ` +
          `(available: ${AVAILABLE[role]?.join(", ") || "none yet"})`,
      );
    }
  }
}

export interface ConnectorEnv {
  env?: Record<string, string | undefined>;
  fetch?: Fetch;
}

/**
 * Builds the company's connectors once, at startup. Secrets come from the
 * environment variables the pack names; a missing one stops startup with
 * its name, never its value.
 */
export function createConnectors(config: CompanyConfig, { env = process.env, fetch: fetchFn = fetch }: ConnectorEnv = {}): Connectors {
  checkConnectors(config);
  const c = config.connectors;
  const what = (role: string) => `Company "${config.id}" ${role}`;
  try {
    const out: Connectors = {};
    if (c.mailbox?.kind === "fake") out.mailbox = new FakeMailbox();
    if (c.mailbox?.kind === "gmail") {
      out.mailbox = new GmailMailbox(
        {
          address: c.mailbox.address,
          clientId: secret(env, c.mailbox.client_id_ref, what("Gmail")),
          clientSecret: secret(env, c.mailbox.client_secret_ref, what("Gmail")),
          refreshToken: secret(env, c.mailbox.refresh_token_ref, what("Gmail")),
        },
        fetchFn,
      );
    }
    if (c.crm?.kind === "fake") out.crm = new FakeCrm();
    if (c.crm?.kind === "hubspot") out.crm = new HubspotCrm(secret(env, c.crm.token_ref, what("HubSpot")), fetchFn);
    if (c.crm?.kind === "zoho_crm") {
      out.crm = new ZohoCrm(
        {
          dataCenter: c.crm.data_center,
          module: c.crm.module,
          clientId: secret(env, c.crm.client_id_ref, what("Zoho CRM")),
          clientSecret: secret(env, c.crm.client_secret_ref, what("Zoho CRM")),
          refreshToken: secret(env, c.crm.refresh_token_ref, what("Zoho CRM")),
        },
        fetchFn,
      );
    }
    if (c.accounting?.kind === "fake") out.accounting = new FakeAccounting();
    return out;
  } catch (error) {
    if (error instanceof ConnectorError) throw new ConfigError(error.message);
    throw error;
  }
}
