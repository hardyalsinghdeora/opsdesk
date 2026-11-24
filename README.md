# opsdesk

An operations agent platform for service businesses. Inbound email becomes CRM leads and priced quotes, every action goes through an approval gateway, and every step lands in a tamper-evident audit log.

One codebase serves many companies. What differs between them (industry, currency, lead fields, price list, which tools are on, what needs a human) lives in a YAML pack per company, not in code.

```
npm install
npm run demo        # narrated run over HTTP, no API key or database needed
npm test            # 50 tests on the in-memory store
```

## What the demo shows

Two fictional companies run on the same code:

| | GulfCool Technical Services | Northwind Freight |
|---|---|---|
| Industry | HVAC servicing, UAE | Freight forwarding, UK |
| Currency | AED, 5% VAT | USD |
| Lead fields | property type, emirate | origin, destination, cargo type, mode |
| `crm.create_lead` | on, runs automatically | on, needs approval |
| `quote.issue` | on, needs approval | off |

The demo walks through seven steps:

1. A GulfCool quote request creates a lead straight away and a priced quote that waits for approval.
2. An operator approves, and the quote is issued.
3. **Failure case:** the same email arrives twice. Nothing happens twice.
4. A Northwind rate request produces a lead with freight fields, and no quote. The quote tool is off, so it was never offered to the model.
5. **Failure case:** code calls the disabled quote tool directly. The gateway refuses it, and the refusal is audited.
6. **Failure case:** the model declines an email. The email is parked for a person, with no actions.
7. **Failure case:** someone edits an audit row in storage. Verification reports the sequence number where the chain breaks.

## How it works

```
 inbound email ──► record (idempotent on Message-ID) ──► model: extract fields ──► pipeline ──► ActionGateway ──► tool
                                                         (structured output,       (plain code)   │ enabled?
                                                          no tools, no prices)                    │ valid input?
                                                                                                  │ seen this key?
                                                                                                  │ approval policy
                                                                                                  ▼
                                                                                   executed now / pending approval / refused
                                                                                                  │
                                                                         every step ──► audit_log (sha256 hash chain, insert-only)
```

**The model only reads and labels.** It returns a structured extraction: contact, summary, urgency, the company's custom fields and catalogue codes. It never sees prices and never calls tools. Pricing, totals, matching and the decision about what to do next are plain code, so the same input always gives the same quote.

**What the model sees is built from config.** The prompt and output schema are generated per company from its pack. A disabled tool adds nothing to either. `test/model-surface.test.ts` checks this.

**The gateway is the only way to cause an effect.** Pipelines, scripts and people all call `ActionGateway.request()`. For each request it:

- refuses a tool the company hasn't enabled
- validates the input against the tool's schema
- returns the existing action if it has seen the idempotency key before
- builds a deterministic preview (for example, the priced quote) for the approver
- runs the tool now if its policy is `auto`, or holds it as `pending_approval`

Approval also checks that the approver is not the requester, and that the tool is still enabled. Low model confidence forces approval even for `auto` tools.

**Refusals are recorded, not lost.** The gateway returns refusals as values instead of throwing, so the transaction commits and the `action.refused` audit entry survives.

**Data isolation is enforced by Postgres.** Every tenant-owned table has a row-level security policy keyed on a transaction-local `app.tenant_id`. Each transaction switches to the unprivileged `opsdesk_app` role, so the policy applies even if the pool connects as an owner. `test/postgres-rls.test.ts` bypasses the application and queries the database directly to prove:

- each tenant sees only its own rows
- a transaction with no tenant set sees nothing
- writing a row for another tenant fails
- the audit log cannot be updated or deleted

**The model call is never inside a database transaction.** Intake records the email in one short transaction, calls the model, then acts in a second one.

## Configuration

Three layers are merged in order and validated with zod:

| Layer | Where | Who changes it | What it holds |
|---|---|---|---|
| 1. Platform defaults | `config/platform.defaults.yaml` | Platform owner | Model, effort, default approval policy, confidence threshold |
| 2. Company pack | `companies/<id>/company.yaml` | Reviewed change, redeploy | Industry, currency, lead fields, tools, their settings and price lists |
| 3. Runtime overrides | `tenant_settings` table, `PUT /t/:id/settings` | Company admin, audited | Tool on/off, approval policy, channel on/off, confidence threshold |

Runtime overrides are deliberately narrow. Switches and thresholds can change at runtime. Prices, prompts and models cannot. Every pack and every override is fully resolved and validated, including each enabled tool's settings, before it takes effect, so a typo stops startup rather than a customer's email.

### Add a company

Create `companies/<id>/company.yaml` (copy one of the examples) and restart. No code changes. Example:

```yaml
id: brightclean
name: BrightClean
industry: commercial cleaning contracts for offices in Abu Dhabi
currency: AED
timezone: Asia/Dubai
channels:
  email: { enabled: true }
lead_fields:
  - { key: sqft, label: Floor area, description: office floor area in square feet }
tools:
  crm.create_lead: { enabled: true, approval: auto }
  quote.issue:
    enabled: true
    settings:
      tax_rate: 0.05
      price_list:
        - { code: DEEP-CLEAN, name: Deep clean, unit: visit, unit_price: 900, aliases: [deep clean] }
```

### Add a tool

A tool is one module implementing `ToolDefinition` (`src/tools/types.ts`) with:

- a name
- a summary
- `read` or `write`
- a zod input schema
- a zod settings schema
- an optional deterministic `preview`
- `execute`

Register it in `BUILTIN_TOOLS` (`src/tools/registry.ts`). Companies then switch it on in their packs.

## API

Every route except `/healthz` is under `/t/:tenant` and needs `Authorization: Bearer <key>`. Each key belongs to one company and one role. A key for another company gets `404`, so tenants cannot discover each other.

| Method | Path | Role | |
|---|---|---|---|
| POST | `/inbound/email` | ingest, admin | `{messageId, from, to, subject, text, receivedAt?}`. Idempotent on `messageId` |
| GET | `/actions?status=pending_approval` | operator, admin | |
| GET | `/actions/:id` | operator, admin | |
| POST | `/actions/:id/approve` | operator, admin | `{note?}`. Not by the requester |
| POST | `/actions/:id/reject` | operator, admin | `{note}` |
| GET | `/leads`, `/quotes` | operator, admin | |
| GET | `/audit`, `/audit/verify` | operator, admin | |
| GET | `/tools` | operator, admin | Enabled tools and their approval policy |
| GET/PUT | `/settings` | admin | Runtime overrides |

Errors look like `{ "error": { "code": "tool_disabled", "message": "..." } }`.

## Running it

**Locally.** `npm start` runs on the in-memory store with the fake extractor and prints development API keys. Set `DATABASE_URL` for Postgres (run `npm run db:migrate` first) and `ANTHROPIC_API_KEY` for the real model. See `.env.example`.

**Docker.** `docker compose up --build` starts Postgres, runs the migrations and starts the app. Production mode refuses to start without `DATABASE_URL`, `OPSDESK_API_KEYS` and a real model.

**Inside an existing Express app.** The routes are one router:

```ts
import { createRuntime, createOpsdeskRouter, ApiKeys } from "opsdesk/src/app.ts";

const rt = await createRuntime({ store: new PostgresStore(process.env.DATABASE_URL!) });
app.use("/ops", createOpsdeskRouter(rt, ApiKeys.fromJson(process.env.OPSDESK_API_KEYS!)));
```

So the same code can be hosted by you, self-hosted by a company, or mounted inside a company's own Express app.

## Model

Extraction is one structured-output call per email to `claude-opus-5-5` (configurable per company) through the official Anthropic SDK:

- output parsed and validated against the company's zod schema
- system prompt cached per company
- server-side refusal fallback turned on

A refusal, a truncated response or output that doesn't match the schema parks the email as `needs_review` with no actions. `FakeExtractor` is a keyword-rule stand-in that uses the same request, for tests and the demo. Production mode refuses to use it.

## Tests

```
npm test                                              # 50 tests on the in-memory store
DATABASE_URL=postgres://... npm test                  # 74 tests: every store-backed suite also on Postgres, plus RLS
npm run typecheck
```

| File | Covers |
|---|---|
| `config.test.ts` | Layering, what overrides may touch, bad packs fail loudly |
| `model-surface.test.ts` | Disabled tools never reach the model, prices never reach the model |
| `gateway.test.ts` | Auto vs approval, previews, idempotency, self-approval, disabled-after-proposal, rollback on tool failure |
| `email-intake.test.ts` | Happy path, duplicates, newsletters, model refusal, low confidence, second industry, tenant separation |
| `pricing.test.ts` | Minor units, tax rounding, fractional quantities |
| `audit.test.ts` | Edits, deletions and re-sealed forgeries are detected |
| `http.test.ts` | Auth, tenant hiding, roles, full approve flow, runtime settings |
| `postgres-rls.test.ts` | Isolation enforced by the database itself |

## Roadmap

These are built the same way: a tool or pipeline module, switched on per company, with every effect going through the gateway.

- **Inbound email connectors:** Gmail and Microsoft 365 webhooks feeding `/inbound/email`
- **CRM adapters:** HubSpot, Zoho and Odoo behind `crm.create_lead`, chosen per company in settings
- **Document Q&A:** answers grounded in the company's own documents, with citations
- **Invoice to purchase-order matching:** the model extracts line items, the match itself is deterministic, and exceptions go to approval
- **Reporting:** fixed SQL views with read-only tools; no model-written SQL against live data
- **Phone:** call transcription feeding the same intake pipeline
- **Operator UI:** an approval queue on top of the existing API
