-- M1: one contact per person per company, so a repeat customer is recognised
-- instead of duplicated, and a place to remember where each mailbox poll got to.

CREATE TABLE contacts (
  id          uuid PRIMARY KEY,
  tenant_id   text NOT NULL REFERENCES tenants(id),
  name        text,
  email       text CHECK (email = lower(email)),
  phone       text,
  company     text,
  crm_ref     text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX contacts_email ON contacts (tenant_id, email) WHERE email IS NOT NULL;
CREATE INDEX contacts_phone ON contacts (tenant_id, phone) WHERE phone IS NOT NULL;

ALTER TABLE leads ADD COLUMN contact_id uuid REFERENCES contacts(id);

-- Small key/value state per company, e.g. "mailbox.cursor" = last message time read.
CREATE TABLE sync_state (
  tenant_id   text NOT NULL REFERENCES tenants(id),
  key         text NOT NULL,
  value       text NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, key)
);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['contacts', 'sync_state'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (tenant_id = current_setting(''app.tenant_id'', true)) '
      'WITH CHECK (tenant_id = current_setting(''app.tenant_id'', true))', t);
  END LOOP;
END
$$;

GRANT SELECT, INSERT, UPDATE ON contacts, sync_state TO opsdesk_app;
