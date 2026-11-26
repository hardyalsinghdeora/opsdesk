-- M2: an approval that waits too long can no longer be acted on. Old
-- requests are marked expired instead of being approved against stale facts.
ALTER TABLE actions DROP CONSTRAINT actions_status_check;
ALTER TABLE actions ADD CONSTRAINT actions_status_check
  CHECK (status IN ('pending_approval', 'executed', 'rejected', 'failed', 'expired'));
