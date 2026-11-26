-- People who use opsdesk through Claude Code. Each has one personal token
-- (stored only as a SHA-256 hash) and one role. Revoking sets revoked_at;
-- rows are never deleted, so the audit log's actors always resolve.

CREATE TABLE staff (
  id          uuid PRIMARY KEY,
  tenant_id   text NOT NULL REFERENCES tenants(id),
  email       text NOT NULL CHECK (email = lower(email)),
  name        text NOT NULL,
  role        text NOT NULL CHECK (role IN ('viewer', 'staff', 'approver', 'owner')),
  token_hash  char(64) NOT NULL UNIQUE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  revoked_at  timestamptz
);
-- One active account per email per company; a revoked one can be re-added.
CREATE UNIQUE INDEX staff_active_email ON staff (tenant_id, email) WHERE revoked_at IS NULL;

-- Enabled but deliberately NOT forced: the application role is bound by the
-- policy, and the owner-run lookup function below can match a token before
-- the tenant is known. The application never connects as the owner.
ALTER TABLE staff ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON staff
  USING (tenant_id = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));

GRANT SELECT, INSERT, UPDATE (revoked_at) ON staff TO opsdesk_app;

-- Token -> person, for authentication. Returns only the matching active row's
-- identity, never the hash or anyone else's data.
CREATE FUNCTION opsdesk_resolve_token(p_hash text)
RETURNS TABLE (tenant_id text, staff_id uuid, email text, role text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT s.tenant_id, s.id, s.email, s.role
  FROM staff s
  WHERE s.token_hash = p_hash AND s.revoked_at IS NULL
$$;
REVOKE ALL ON FUNCTION opsdesk_resolve_token(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION opsdesk_resolve_token(text) TO opsdesk_app;
