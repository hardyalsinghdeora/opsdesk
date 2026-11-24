# opsdesk

Multi-tenant operations platform: inbound email -> structured extraction -> actions (CRM lead, quote) through an approval gateway with a hash-chained audit log. Companies differ only by YAML packs in `companies/<id>/company.yaml`.

## Commands
- `npm test` - all tests on the in-memory store; set `DATABASE_URL` to also run every store-backed suite and the RLS tests on Postgres
- `npm run typecheck` - `tsc --noEmit` (TypeScript runs directly via Node's type stripping; there is no build step)
- `npm run demo` - narrated end-to-end run, no key or database needed

## Rules
- Node >= 22.18 runs `.ts` directly: import with `.ts` extensions, `import type` for types, no enums, namespaces or parameter properties (`erasableSyntaxOnly`).
- Every side effect goes through `ActionGateway`. Tools never get called directly from routes or pipelines.
- Gateway refusals are returned (`{ ok: false }`), not thrown, so the audit entry commits. Use `unwrap()` outside the transaction.
- The model only labels text. Prices, totals, matching and policy are plain code. Never put prices in a prompt.
- A disabled tool must not appear in the prompt or the output schema (`test/model-surface.test.ts`).
- New tenant-owned tables need `tenant_id`, the RLS policy in a migration, and grants for `opsdesk_app`. `audit_log` stays insert-only.
- Money is integer minor units.
- A company-specific need goes in its pack, or becomes a generic tool or setting. Never `if (tenant === ...)`.
