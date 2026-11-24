-- opsdesk schema. Every tenant-owned table carries tenant_id and is guarded by
-- row-level security keyed on the transaction-local setting app.tenant_id.
-- The application switches to the opsdesk_app role inside each transaction
-- (SET LOCAL ROLE), so RLS applies even when the pool connects as an owner.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opsdesk_app') THEN
    CREATE ROLE opsdesk_app NOLOGIN;
  END IF;
END
$$;

GRANT opsdesk_app TO CURRENT_USER;
-- Explicit, so a hardened or recreated schema still works for the app role.
GRANT USAGE ON SCHEMA public TO opsdesk_app;

CREATE TABLE tenants (
  id          text PRIMARY KEY,
  name        text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE inbound_emails (
  id           uuid PRIMARY KEY,
  tenant_id    text NOT NULL REFERENCES tenants(id),
  message_id   text NOT NULL,
  from_addr    text NOT NULL,
  to_addr      text NOT NULL,
  subject      text NOT NULL,
  body         text NOT NULL,
  received_at  timestamptz NOT NULL,
  status       text NOT NULL CHECK (status IN ('received', 'processed', 'ignored', 'needs_review')),
  extraction   jsonb,
  error        text,
  UNIQUE (tenant_id, message_id)
);

CREATE TABLE leads (
  id             uuid PRIMARY KEY,
  tenant_id      text NOT NULL REFERENCES tenants(id),
  contact        jsonb NOT NULL,
  summary        text NOT NULL,
  stage          text NOT NULL,
  owner          text,
  urgency        text NOT NULL,
  custom_fields  jsonb NOT NULL DEFAULT '{}',
  source         text NOT NULL,
  source_ref     text,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE quotes (
  id             uuid PRIMARY KEY,
  tenant_id      text NOT NULL REFERENCES tenants(id),
  number         text NOT NULL,
  customer       jsonb NOT NULL,
  currency       char(3) NOT NULL,
  lines          jsonb NOT NULL,
  subtotal_minor bigint NOT NULL,
  tax_minor      bigint NOT NULL,
  total_minor    bigint NOT NULL,
  tax_rate       numeric(6,4) NOT NULL,
  valid_until    date NOT NULL,
  status         text NOT NULL,
  source_ref     text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, number)
);

CREATE TABLE actions (
  id               uuid PRIMARY KEY,
  tenant_id        text NOT NULL REFERENCES tenants(id),
  tool             text NOT NULL,
  input            jsonb NOT NULL,
  preview          jsonb,
  status           text NOT NULL CHECK (status IN ('pending_approval', 'executed', 'rejected', 'failed')),
  idempotency_key  text NOT NULL,
  reason           text,
  requested_by     text NOT NULL,
  requested_at     timestamptz NOT NULL,
  decided_by       text,
  decided_at       timestamptz,
  decision_note    text,
  result           jsonb,
  error            text,
  UNIQUE (tenant_id, idempotency_key)
);
CREATE INDEX actions_pending ON actions (tenant_id, status) WHERE status = 'pending_approval';

CREATE TABLE audit_log (
  tenant_id  text NOT NULL REFERENCES tenants(id),
  seq        bigint NOT NULL,
  id         uuid NOT NULL UNIQUE,
  at         timestamptz NOT NULL,
  actor      text NOT NULL,
  type       text NOT NULL,
  subject    text,
  data       jsonb NOT NULL,
  prev_hash  char(64) NOT NULL,
  hash       char(64) NOT NULL,
  PRIMARY KEY (tenant_id, seq)
);

CREATE TABLE tenant_settings (
  tenant_id   text PRIMARY KEY REFERENCES tenants(id),
  overrides   jsonb NOT NULL DEFAULT '{}',
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- Row-level security: one policy per table, forced so owners are bound too.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['inbound_emails', 'leads', 'quotes', 'actions', 'audit_log', 'tenant_settings'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (tenant_id = current_setting(''app.tenant_id'', true)) '
      'WITH CHECK (tenant_id = current_setting(''app.tenant_id'', true))', t);
  END LOOP;
END
$$;

GRANT SELECT ON tenants TO opsdesk_app;
GRANT SELECT, INSERT, UPDATE ON inbound_emails, leads, quotes, actions, tenant_settings TO opsdesk_app;
-- The audit log is append-only for the application.
GRANT SELECT, INSERT ON audit_log TO opsdesk_app;
