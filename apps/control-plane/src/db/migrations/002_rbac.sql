-- Per-org multi-tenancy and RBAC.
--
-- Before this migration an API key WAS a project: projects.api_key_hash held exactly one
-- key, it granted everything, and orgs existed in the schema without ever being consulted.
-- A key is now a row of its own, so one org can hold many projects, one project many keys,
-- and each key carries a role that decides what it may do.

CREATE TABLE IF NOT EXISTS api_keys (
  id          TEXT PRIMARY KEY,
  org_id      TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  -- NULL means org-wide: the key may act on every project in its org, and picks one
  -- per request. A non-NULL project_id pins the key to that project and nothing else.
  project_id  TEXT REFERENCES projects(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  key_hash    TEXT NOT NULL UNIQUE,
  role        TEXT NOT NULL CHECK (role IN ('admin', 'operator', 'agent', 'viewer')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at  TIMESTAMPTZ
);
-- Auth looks a key up on every request; revoked keys are excluded there, not here, so
-- that a revoked hash still cannot be re-minted for someone else.
CREATE INDEX IF NOT EXISTS api_keys_org_idx ON api_keys(org_id, project_id);

-- Existing keys keep working, with the access they already had: full control over the
-- one project they were attached to.
INSERT INTO api_keys (id, org_id, project_id, name, key_hash, role)
SELECT 'key_legacy_' || p.id, p.org_id, p.id, 'legacy key', p.api_key_hash, 'admin'
FROM projects p
WHERE p.api_key_hash IS NOT NULL
ON CONFLICT (key_hash) DO NOTHING;

-- Authentication now reads api_keys. The column stays for one release so a rollback to
-- 0.1.x still finds its key, but nothing reads it any more, and new projects leave it NULL.
ALTER TABLE projects ALTER COLUMN api_key_hash DROP NOT NULL;
