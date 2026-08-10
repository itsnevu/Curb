-- Curb schema, following DESIGN.md §6.

CREATE TABLE IF NOT EXISTS orgs (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS projects (
  id            TEXT PRIMARY KEY,
  org_id        TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  api_key_hash  TEXT NOT NULL UNIQUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS policies (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  type        TEXT NOT NULL,
  scope_json  JSONB NOT NULL DEFAULT '{}'::jsonb,
  when_json   JSONB,
  params_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  action      TEXT NOT NULL,
  enabled     BOOLEAN NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS policies_project_enabled_idx ON policies(project_id, enabled);

CREATE TABLE IF NOT EXISTS runs (
  id              TEXT PRIMARY KEY,
  project_id      TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  started_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  ended_at        TIMESTAMPTZ,
  status          TEXT NOT NULL DEFAULT 'running',
  total_tokens    BIGINT NOT NULL DEFAULT 0,
  total_cost_usd  NUMERIC(14,6) NOT NULL DEFAULT 0,
  step_count      INTEGER NOT NULL DEFAULT 0,
  verdict         TEXT
);
CREATE INDEX IF NOT EXISTS runs_project_started_idx ON runs(project_id, started_at DESC);

CREATE TABLE IF NOT EXISTS events (
  id            BIGSERIAL PRIMARY KEY,
  run_id        TEXT NOT NULL,
  project_id    TEXT,
  ts            TIMESTAMPTZ NOT NULL DEFAULT now(),
  kind          TEXT NOT NULL,
  effect        TEXT NOT NULL,
  policy_id     TEXT,
  reason        TEXT,
  -- context is summarised by the sender; raw prompts are NEVER stored
  context_json  JSONB NOT NULL DEFAULT '{}'::jsonb,
  decision_json JSONB NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS events_run_idx ON events(run_id, ts DESC);
CREATE INDEX IF NOT EXISTS events_project_ts_idx ON events(project_id, ts DESC);

CREATE TABLE IF NOT EXISTS approvals (
  id            TEXT PRIMARY KEY,
  run_id        TEXT NOT NULL,
  project_id    TEXT,
  tool_name     TEXT NOT NULL,
  -- arguments are redacted by the SDK before they are sent, and again on arrival
  args_json     JSONB NOT NULL DEFAULT '{}'::jsonb,
  reason        TEXT,
  policy_id     TEXT,
  status        TEXT NOT NULL DEFAULT 'pending',
  requested_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  decided_at    TIMESTAMPTZ,
  decided_by    TEXT
);
CREATE INDEX IF NOT EXISTS approvals_status_idx ON approvals(status, requested_at DESC);
