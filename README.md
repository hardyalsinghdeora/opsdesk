# opsdesk

A self-hosted MCP server that gives a service business's team safe AI tools inside Claude Code. Each company runs it on its own server, sets it up for its business in YAML, and connects each person's Claude Code with their own token. There is no web app: people work in Claude Code, administrators use the `aiops` command line on the server.

Every effect goes through one approval gateway, and every step lands in a tamper-evident audit log. What differs between companies (industry, currency, lead fields, price list, which tools and workflows are on, what needs a person) lives in a pack per company, not in code.

```
npm install
npm start           # in-memory store; prints a temporary connect command per demo company
npm test            # in-memory store; set DATABASE_URL to also run every suite and the RLS tests on Postgres
npm run aiops help  # the administrator's command line
npm run worker      # reads each company's mailbox on a timer (needs DATABASE_URL)
npm run demo        # the recorded walkthrough: three people, five emails, delivered on Enter
```

The demo runs entirely on this computer with fictional companies and stand-in mail and CRM. `docs/demo-script.md` has the setup and a timed two-minute script, and `test/demo.test.ts` runs every step of it in CI.

## How it works

```
 Claude Code (each person)                     the company's own server
 ─────────────────────────                     ───────────────────────────────────────────────────────────────
  "what's waiting for approval?"   ──MCP──►    POST /mcp ─► token → person, company, role (revoked = 401)
  "quote 3 AC services for Omar"               │
                                               ▼
                                     tool list built for THIS person, from THIS company's live config:
                                     whoami · list_tools · list_workflows · list_actions · get_action ·
                                     list_emails · verify_audit · list_review_queue · resolve_review (staff+) ·
                                     request_action (staff+; only enabled, not-"never" tools) ·
                                     approve_action · reject_action (approvers+)
                                               │
                                               ▼
                                     ActionGateway ── enabled? ── valid input? ── seen this key? ── policy
                                               │                                                  │
                                     auto → runs now   required → waits for a person   never → refused
                                               │
                                               ▼
                                     Postgres (row-level security per company) + audit_log (sha256 chain, insert-only)
```

**People and roles.** Each person gets a personal token from `aiops users add`, which prints the one line they paste into their terminal (`claude mcp add --transport http ...`). Only the token's SHA-256 is stored. Roles: `viewer` reads, `staff` can also ask for actions, `approver` can also approve, `owner` can also manage people. Removing someone stops their token on the next call.

**What the model can see is built from config.** The MCP tool list is rebuilt per request from the company's resolved config and the caller's role. A disabled tool, a tool set to `never`, or a permission the person lacks is simply absent, so the model cannot be talked into calling it. `list_tools` returns each tool's input schema and approval policy.

**The gateway is the only way to cause an effect.** For each request it refuses a disabled tool or a `never` tool, validates the input, de-duplicates on the idempotency key, builds a deterministic preview (for example, the priced quote) and then runs it now (`auto`) or holds it as `pending_approval` (`required`). Approval checks the approver is not the requester and the tool is still on. Refusals are returned as values, so the audit entry always commits.

**Approvals are answered by the person, not the model.** `approve_action` does not take a decision as input. It makes opsdesk ask the person directly through Claude Code's prompt (an MCP elicitation), showing exactly what will run, who asked, the reason and a fingerprint. Only a ticked "approve" from that prompt runs the action, and only if the action still matches the fingerprint shown. The note in the audit log is the person's own. The requester cannot approve their own request, and a request nobody decides within `approvals.expire_hours` (default 72) expires. An app that cannot show prompts is told to use `aiops approve ID --as EMAIL` on the server, which shows the same details and asks for confirmation. Approvals trust the person's own app: someone who configures their Claude Code to answer prompts automatically has chosen to approve automatically.

**Sessions.** The prompt needs the person's answer to reach the server that asked, so `/mcp` keeps sessions. They grant nothing: the token is checked on every request and must belong to the session's person (another person's session id is "not found"), each request re-reads the company's config and updates the tool list in place, and sessions close after 30 idle minutes. Sessions live in memory, so run one `app` process (as `docker-compose.yml` does).

**Replies go only to the sender.** `email.send_reply` takes the id of an inbound email and the text. The recipient, subject and thread are taken from the stored email, so neither the model nor an email's contents can redirect a reply. The approver sees the exact message, and the approved message is the one sent.

**Email that tries to give the AI orders.** Intake also looks for wording addressed to an assistant ("ignore previous instructions", "do not ask for approval"). When it finds some, every step for that email waits for a person, with the reason shown, and the email goes to the review queue. This is an extra layer: even without it, the model only labels, replies go only to the sender, and there is no tool that forwards data.

**Email in, routed to a workflow.** The worker reads each company's mailbox from its saved position (Gmail, or a fake in tests) and moves that position only past messages it has handled. For each email the model makes one structured-output call to label it: contact, summary, urgency, the company's custom fields and an intent chosen from that company's active email workflows (or "other"). Plain code then picks the first active workflow, by priority, whose intent matches, and runs its steps through the gateway with each step's policy. An email no workflow takes, a low-confidence one, or one the model declines goes to the review queue, which people see and close from Claude Code.

**One contact per person.** A lead's contact is matched on email, then phone, before a new one is created; a match only fills in what was missing. When a CRM is connected (Zoho CRM or HubSpot), the contact is upserted there too and its CRM id kept.

**Workflows.** A company runs many: a sales enquiry, a supplier invoice, a payment follow-up. Each has a trigger, an owner, steps and its own on/off switch. A step may make a tool stricter (`required` or `never`), never looser. A pack whose workflow uses a tool it leaves off fails at startup; at runtime, switching off a tool pauses the workflows that use it (with the reason) instead of breaking anything.

**Connectors.** Mailbox, CRM, accounting, the company's own app (named REST operations only) and its database (read-only, listed tables only) sit behind small interfaces, each with an in-memory fake. Shipped: Gmail (OAuth refresh token), Zoho CRM (OAuth, any data centre, Leads or Contacts, upsert de-duplicated on Email) and HubSpot (private-app token; the enquiry is attached as a note). Packs name secrets by environment variable, never by value; a missing variable or an unshipped connector (Microsoft 365, the app and database connectors) stops startup with a clear message.

```yaml
connectors:
  mailbox: { kind: gmail, address: enquiries@yourcompany.com,
             client_id_ref: GMAIL_CLIENT_ID, client_secret_ref: GMAIL_CLIENT_SECRET, refresh_token_ref: GMAIL_REFRESH_TOKEN }
  crm:     { kind: zoho_crm, data_center: in, module: Leads,
             client_id_ref: ZOHO_CLIENT_ID, client_secret_ref: ZOHO_CLIENT_SECRET, refresh_token_ref: ZOHO_REFRESH_TOKEN }
```

**Data isolation is enforced by Postgres.** Every tenant-owned table has a row-level security policy keyed on a transaction-local `app.tenant_id`, and each transaction switches to the unprivileged `opsdesk_app` role. Token lookup goes through one owner-run function that returns only the matching person's identity. `test/postgres-rls.test.ts` queries the database directly to prove each company sees only its rows, nothing is visible with no company set, cross-company writes fail, the audit log cannot be updated or deleted, and the app cannot rewrite anyone's role or token.

**The model only reads and labels.** Prices, totals, matching, routing and policy are plain code, and prices never reach the model. Email text is framed as data, and the intents it can choose from come only from the company's active workflows.

## Configuration

| Layer | Where | Changed by | Holds |
|---|---|---|---|
| 1. Platform defaults | `config/platform.defaults.yaml` | Release | Model, effort, default approval policy, confidence threshold |
| 2. Company pack | `companies/<id>/company.yaml` | Owner, reviewed, restart | Industry, currency, lead fields, tools and their settings, workflows, connectors |
| 3. Runtime overrides | `tenant_settings` table | Owner, audited | Tool on/off and policy, workflow on/off, channel on/off, thresholds |

Runtime overrides cannot touch prices, prompts, models or connectors. A typo in a pack stops startup instead of a customer's email; `aiops config validate` runs the same check.

Example pack excerpt:

```yaml
tools:
  crm.create_lead: { enabled: true, approval: auto }
  quote.issue: { enabled: true, approval: required, settings: { tax_rate: 0.05, price_list: [...] } }

workflows:
  sales_enquiry:
    enabled: true
    trigger: { channel: email, intent: quote }
    owner: sales@gulfcool.example
    steps: [{ tool: crm.create_lead }, { tool: quote.issue }]
  general_enquiry:
    enabled: true
    trigger: { channel: email }
    owner: ops@gulfcool.example
    steps: [{ tool: crm.create_lead, approval: required }]   # stricter than the tool's own "auto"

connectors:
  mailbox: { kind: fake }
  crm: { kind: fake }
```

Two fictional companies ship as examples: GulfCool (HVAC, UAE, AED with 5% VAT, quoting on) and Northwind Freight (freight, UK, USD, quoting off).

## Running it on a server

```
cp .env.example .env                                  # set OPSDESK_PUBLIC_URL and ANTHROPIC_API_KEY
docker compose up -d                                  # Postgres + migrations + the MCP server + the mail worker
docker compose run --rm aiops doctor                  # OK / FIX for every part, with what to do
docker compose run --rm aiops users add --email maya@yourcompany.com --name Maya --role owner
```

The last command prints Maya's connect line. In Claude Code she can then check it with `/mcp`.

| `aiops` command | Does |
|---|---|
| `doctor` | Checks settings, database, migrations, model key, web address and that each company has an owner |
| `migrate` | Updates the database to this release |
| `config validate` / `config show` | Checks every pack; prints one company's resolved settings, tools and workflows |
| `users add` / `list` / `remove` | Gives access (prints the connect command once), lists people, revokes at once |
| `mail poll` | Reads new mail once now; the worker does this every `OPSDESK_POLL_SECONDS` |
| `approvals` | Lists what is waiting for approval, with expiry and fingerprint |
| `approve ID --as EMAIL` / `reject ID --as EMAIL --note N` | Decides as a named approver or owner, for apps that cannot show prompts; `approve` shows what will run and asks, or takes `--yes` |

## Tests

```
npm test                                   # memory store
DATABASE_URL=postgres://... npm test        # every store-backed suite on Postgres too, plus RLS
npm run typecheck
```

| File | Covers |
|---|---|
| `mcp.test.ts` | Over HTTP with the official MCP client: tokens, roles, per-company tool lists, gateway routing, runtime switches, revocation, the review queue |
| `routing.test.ts` | Email to workflow by intent and priority, stricter steps, unrouted email, runtime switches, repeat customers, CRM sync, what intents the model sees |
| `connectors.test.ts` | Gmail, Zoho CRM and HubSpot request and response shapes against a stub, error handling, secrets by name only |
| `mail-poller.test.ts` | Oldest first, saved position, no double handling, retry after a refusal |
| `injection.test.ts` | Text aimed at the AI is spotted, ordinary wording is not; such an email causes no automatic action and sends nothing |
| `demo.test.ts` | The recorded walkthrough end to end over MCP |
| `approvals.test.ts` | The approval prompt end to end with the MCP client playing the person: confirm, decline, no prompt support, self-approval, roles, rejection, long-session tool updates, session hijack, revocation; server approvals; fingerprints; expiry; replies only to the sender |
| `staff.test.ts` | Tokens resolve to one person and company, hashes never leak, duplicates refused, revocation |
| `workflows.test.ts` | Many workflows per company, stricter-only steps, runtime pausing, the `never` policy, connectors |
| `config.test.ts` | Layering, what overrides may touch, bad packs fail loudly |
| `model-surface.test.ts` | Disabled tools and prices never reach the model |
| `gateway.test.ts` | Auto vs approval, previews, idempotency, self-approval, disabled-after-proposal |
| `email-intake.test.ts` | Happy path, duplicates, newsletters, refusals, low confidence, second industry, tenant separation |
| `pricing.test.ts`, `audit.test.ts` | Minor units and tax; audit edits and forgeries are detected |
| `postgres-rls.test.ts` | Isolation and append-only audit enforced by the database itself |

## Roadmap

Done: **M0** the foundation (MCP endpoint, people and roles, workflows, gateway, audit, RLS, `aiops`), **M1** inbox to record (Gmail, Zoho CRM, HubSpot, routing to workflows, contacts without duplicates, review queue, mail worker) and **M2** approvals (prompts in Claude Code, `aiops approve`, fingerprints, expiry, replies to the sender only). The connectors are tested against documented request shapes, not yet against live sandbox accounts. Next:

- **M1 follow-ups** A live sandbox run for each connector; Microsoft 365; an intake accuracy set of labelled emails with targets
- **M2 follow-ups** Two approvers above a value; per-tool approver lists; an outbox so a send that succeeds but fails to record can never repeat
- **M3** Record the demo (the runner and script are in place: `npm run demo`, `docs/demo-script.md`); real model and a sandbox CRM for the recording
- **M4–M6** Document answers with citations, invoice to purchase-order matching, phone, reporting over fixed read-only views
- **M7** Setup wizard and connector sign-in links
