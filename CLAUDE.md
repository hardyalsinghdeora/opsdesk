# opsdesk

Self-hosted MCP server for service businesses. People use it from Claude Code with personal tokens; administrators use the `aiops` CLI. Email -> structured extraction -> actions (CRM lead, quote) through an approval gateway with a hash-chained audit log. Companies differ only by YAML packs in `companies/<id>/company.yaml` (tools, workflows, connectors).

## Commands
- `npm test` - all tests on the in-memory store; set `DATABASE_URL` to also run every store-backed suite and the RLS tests on Postgres
- `npm run typecheck` - `tsc --noEmit` (TypeScript runs directly via Node's type stripping; there is no build step)
- `npm start` - MCP server on :3000; with no `DATABASE_URL` it prints a temporary connect command per company
- `npm run aiops -- <command>` - the admin CLI (`doctor`, `migrate`, `config validate|show`, `users add|list|remove`, `mail poll`, `approvals`, `approve`, `reject`)
- `npm run worker` - polls each company's mailbox and runs intake (needs `DATABASE_URL`)

## Rules
- Node >= 22.18 runs `.ts` directly: import with `.ts` extensions, `import type` for types, no enums, namespaces or parameter properties (`erasableSyntaxOnly`).
- The HTTP surface is `/healthz` and `/mcp` only. No REST API, no web UI: new capabilities are MCP tools (people) or `aiops` commands (administrators).
- Every side effect goes through `ActionGateway`. Tools never get called directly from MCP handlers, routes or pipelines.
- Gateway refusals are returned (`{ ok: false }`), not thrown, so the audit entry commits. Use `unwrap()` outside the transaction.
- The MCP tool list is built per request from the caller's role and the company's resolved config. A disabled tool, a `never` tool or a missing permission must be absent, not merely refused.
- The model only labels text. Prices, totals, matching and policy are plain code. Never put prices in a prompt.
- A disabled tool must not appear in the prompt or the output schema (`test/model-surface.test.ts`).
- Workflow steps may only tighten a tool's policy. `resolveWorkflows(..., { strict: true })` for packs; runtime switches pause workflows, never throw.
- Secrets are never in packs: connectors name environment variables (`*_ref`). Connectors take an injectable `fetch`; test them against stubs (`test/connectors.test.ts`), never live accounts in CI.
- Email reaches tools only through workflows: intent comes from the company's active email workflows, routing and step inputs are plain code (`src/pipelines/email-intake.ts`).
- Contacts are matched before they are created, and a match only fills in missing fields.
- An approval decision never comes from tool input. It comes from the person: an MCP elicitation (sent with `relatedRequestId` on the call's own stream) or `aiops approve --as`. Approve with the fingerprint that was shown.
- `/mcp` sessions are in memory and grant nothing: re-authenticate every request, match the session to its person, call `refresh()` before handling. Run a single app process.
- A tool's preview and execute build the effect from the same function and stored data (see `email-send-reply.ts`), so what is approved is what runs.
- New tenant-owned tables need `tenant_id`, the RLS policy in a migration, and grants for `opsdesk_app`. `audit_log` stays insert-only. Tokens are stored only as SHA-256.
- Money is integer minor units.
- A company-specific need goes in its pack, or becomes a generic tool or setting. Never `if (tenant === ...)`.
