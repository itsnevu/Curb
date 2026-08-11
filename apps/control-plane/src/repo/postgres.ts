import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import type { Policy } from "@curb/shared";
import type {
  ApiKey,
  Approval,
  ApprovalStatus,
  DecideResult,
  EventRecord,
  Project,
  Repo,
  RunSummary,
} from "./types.js";

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "db", "migrations");

export class PostgresRepo implements Repo {
  private pool: Pool;

  constructor(connectionString: string) {
    this.pool = new Pool({ connectionString, max: 10 });
  }

  /** Run any migrations that haven't run yet. Idempotent and safe to call on every boot. */
  async init(): Promise<void> {
    await this.pool.query(
      `CREATE TABLE IF NOT EXISTS _curb_migrations (
         name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`,
    );
    const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort();
    for (const file of files) {
      const done = await this.pool.query("SELECT 1 FROM _curb_migrations WHERE name = $1", [file]);
      if ((done.rowCount ?? 0) > 0) continue;
      const sql = readFileSync(join(MIGRATIONS_DIR, file), "utf8");
      const client = await this.pool.connect();
      try {
        await client.query("BEGIN");
        await client.query(sql);
        await client.query("INSERT INTO _curb_migrations(name) VALUES ($1)", [file]);
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      } finally {
        client.release();
      }
    }
  }

  async close() {
    await this.pool.end();
  }

  async upsertProject(p: Project): Promise<Project> {
    await this.pool.query(
      "INSERT INTO orgs(id, name) VALUES ($1, $1) ON CONFLICT (id) DO NOTHING",
      [p.orgId],
    );
    await this.pool.query(
      `INSERT INTO projects(id, org_id, name, api_key_hash) VALUES ($1,$2,$3,$4)
       ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name,
         api_key_hash = COALESCE(EXCLUDED.api_key_hash, projects.api_key_hash)`,
      [p.id, p.orgId, p.name, p.apiKeyHash ?? null],
    );
    return p;
  }

  async getProject(orgId: string, id: string): Promise<Project | null> {
    const r = await this.pool.query("SELECT * FROM projects WHERE org_id = $1 AND id = $2", [orgId, id]);
    return r.rows[0] ? rowToProject(r.rows[0]) : null;
  }

  async projectById(id: string): Promise<Project | null> {
    const r = await this.pool.query("SELECT * FROM projects WHERE id = $1", [id]);
    return r.rows[0] ? rowToProject(r.rows[0]) : null;
  }

  async listProjects(orgId: string): Promise<Project[]> {
    const r = await this.pool.query("SELECT * FROM projects WHERE org_id = $1 ORDER BY id", [orgId]);
    return r.rows.map(rowToProject);
  }

  async apiKeyByHash(hash: string): Promise<ApiKey | null> {
    const r = await this.pool.query(
      "SELECT * FROM api_keys WHERE key_hash = $1 AND revoked_at IS NULL",
      [hash],
    );
    return r.rows[0] ? rowToApiKey(r.rows[0]) : null;
  }

  async createApiKey(key: ApiKey): Promise<ApiKey> {
    await this.pool.query(
      `INSERT INTO api_keys(id, org_id, project_id, name, key_hash, role, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [key.id, key.orgId, key.projectId ?? null, key.name, key.keyHash, key.role, new Date(key.createdAt)],
    );
    return key;
  }

  async listApiKeys(orgId: string): Promise<ApiKey[]> {
    const r = await this.pool.query(
      "SELECT * FROM api_keys WHERE org_id = $1 ORDER BY created_at DESC LIMIT 200",
      [orgId],
    );
    return r.rows.map(rowToApiKey);
  }

  async revokeApiKey(orgId: string, id: string, at: number): Promise<boolean> {
    const r = await this.pool.query(
      "UPDATE api_keys SET revoked_at = $3 WHERE org_id = $1 AND id = $2 AND revoked_at IS NULL",
      [orgId, id, new Date(at)],
    );
    return (r.rowCount ?? 0) > 0;
  }

  async listPolicies(projectId: string): Promise<Policy[]> {
    const r = await this.pool.query("SELECT * FROM policies WHERE project_id = $1 ORDER BY created_at", [projectId]);
    return r.rows.map(rowToPolicy);
  }

  async getPolicy(projectId: string, id: string): Promise<Policy | null> {
    const r = await this.pool.query("SELECT * FROM policies WHERE project_id = $1 AND id = $2", [projectId, id]);
    return r.rows[0] ? rowToPolicy(r.rows[0]) : null;
  }

  async putPolicy(projectId: string, p: Policy): Promise<Policy> {
    await this.pool.query(
      `INSERT INTO policies(id, project_id, name, type, scope_json, when_json, params_json, action, enabled)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (id) DO UPDATE SET
         name=EXCLUDED.name, type=EXCLUDED.type, scope_json=EXCLUDED.scope_json,
         when_json=EXCLUDED.when_json, params_json=EXCLUDED.params_json,
         action=EXCLUDED.action, enabled=EXCLUDED.enabled, updated_at=now()`,
      [p.id, projectId, p.name, p.type, p.scope, p.when ?? null, p.params, p.action, p.enabled],
    );
    return p;
  }

  async deletePolicy(projectId: string, id: string): Promise<boolean> {
    const r = await this.pool.query("DELETE FROM policies WHERE project_id = $1 AND id = $2", [projectId, id]);
    return (r.rowCount ?? 0) > 0;
  }

  async appendEvents(events: EventRecord[]): Promise<void> {
    if (events.length === 0) return;
    const values: unknown[] = [];
    const tuples = events.map((e, i) => {
      const o = i * 8;
      values.push(e.runId, e.projectId ?? null, new Date(e.ts), e.kind, e.effect,
        e.policyId ?? null, e.reason ?? null, e.context ?? {});
      return `($${o + 1},$${o + 2},$${o + 3},$${o + 4},$${o + 5},$${o + 6},$${o + 7},$${o + 8})`;
    });
    await this.pool.query(
      `INSERT INTO events(run_id, project_id, ts, kind, effect, policy_id, reason, context_json)
       VALUES ${tuples.join(",")}`,
      values,
    );
  }

  async listEvents(projectId: string, opts: { runId?: string; limit?: number } = {}): Promise<EventRecord[]> {
    const r = await this.pool.query(
      `SELECT * FROM events WHERE project_id = $1 AND ($2::text IS NULL OR run_id = $2)
       ORDER BY ts DESC, id DESC LIMIT $3`,
      [projectId, opts.runId ?? null, opts.limit ?? 100],
    );
    return r.rows.map((row) => ({
      id: Number(row.id),
      runId: row.run_id,
      projectId: row.project_id ?? undefined,
      ts: new Date(row.ts).getTime(),
      kind: row.kind,
      effect: row.effect,
      policyId: row.policy_id ?? undefined,
      reason: row.reason ?? undefined,
      context: row.context_json ?? {},
    }));
  }

  async createApproval(a: Approval): Promise<Approval> {
    await this.pool.query(
      `INSERT INTO approvals(id, run_id, project_id, tool_name, args_json, reason, policy_id, status, requested_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [a.id, a.runId, a.projectId ?? null, a.toolName, a.args ?? {}, a.reason ?? null,
       a.policyId ?? null, a.status, new Date(a.requestedAt)],
    );
    return a;
  }

  async getApproval(id: string): Promise<Approval | null> {
    const r = await this.pool.query("SELECT * FROM approvals WHERE id = $1", [id]);
    return r.rows[0] ? rowToApproval(r.rows[0]) : null;
  }

  async listApprovals(projectId: string, status?: ApprovalStatus): Promise<Approval[]> {
    const r = await this.pool.query(
      `SELECT * FROM approvals WHERE project_id = $1 AND ($2::text IS NULL OR status = $2)
       ORDER BY requested_at DESC LIMIT 200`,
      [projectId, status ?? null],
    );
    return r.rows.map(rowToApproval);
  }

  async decideApproval(id: string, status: ApprovalStatus, by: string, at: number): Promise<DecideResult> {
    // why: WHERE status='pending' makes the first decision win atomically, with no
    // explicit transaction, even if two people click at the same moment. The loser gets
    // changed:false, so it neither writes a duplicate audit event nor re-wakes waiters.
    const r = await this.pool.query(
      `UPDATE approvals SET status=$2, decided_by=$3, decided_at=$4
       WHERE id=$1 AND status='pending' RETURNING *`,
      [id, status, by, new Date(at)],
    );
    if (r.rows[0]) return { approval: rowToApproval(r.rows[0]), changed: true };
    return { approval: await this.getApproval(id), changed: false };
  }

  async expirePendingApprovals(before: number, at: number): Promise<Approval[]> {
    const r = await this.pool.query(
      `UPDATE approvals SET status='expired', decided_at=$2, decided_by='curb:expiry'
       WHERE status='pending' AND requested_at <= $1 RETURNING *`,
      [new Date(before), new Date(at)],
    );
    return r.rows.map(rowToApproval);
  }

  async upsertRun(run: RunSummary): Promise<void> {
    await this.pool.query(
      `INSERT INTO runs(id, project_id, started_at, ended_at, status, total_tokens, total_cost_usd, step_count, verdict)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (id) DO UPDATE SET
         ended_at=COALESCE(EXCLUDED.ended_at, runs.ended_at), status=EXCLUDED.status,
         total_tokens=GREATEST(runs.total_tokens, EXCLUDED.total_tokens),
         total_cost_usd=GREATEST(runs.total_cost_usd, EXCLUDED.total_cost_usd),
         step_count=GREATEST(runs.step_count, EXCLUDED.step_count),
         verdict=COALESCE(EXCLUDED.verdict, runs.verdict)`,
      [run.id, run.projectId, new Date(run.startedAt), run.endedAt ? new Date(run.endedAt) : null,
       run.status, run.totalTokens, run.totalCostUsd, run.stepCount, run.verdict ?? null],
    );
  }

  async listRuns(projectId: string, limit = 50): Promise<RunSummary[]> {
    const r = await this.pool.query(
      "SELECT * FROM runs WHERE project_id = $1 ORDER BY started_at DESC LIMIT $2",
      [projectId, limit],
    );
    return r.rows.map(rowToRun);
  }

  async getRun(projectId: string, id: string): Promise<RunSummary | null> {
    const r = await this.pool.query("SELECT * FROM runs WHERE project_id=$1 AND id=$2", [projectId, id]);
    return r.rows[0] ? rowToRun(r.rows[0]) : null;
  }
}

function rowToProject(row: Record<string, any>): Project {
  return { id: row.id, orgId: row.org_id, name: row.name, apiKeyHash: row.api_key_hash ?? undefined };
}

function rowToApiKey(row: Record<string, any>): ApiKey {
  return {
    id: row.id,
    orgId: row.org_id,
    projectId: row.project_id ?? undefined,
    name: row.name,
    keyHash: row.key_hash,
    role: row.role,
    createdAt: new Date(row.created_at).getTime(),
    revokedAt: row.revoked_at ? new Date(row.revoked_at).getTime() : undefined,
  };
}

function rowToPolicy(row: Record<string, any>): Policy {
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    scope: row.scope_json ?? {},
    when: row.when_json ?? undefined,
    params: row.params_json ?? {},
    action: row.action,
    enabled: row.enabled,
  };
}

function rowToApproval(row: Record<string, any>): Approval {
  return {
    id: row.id,
    runId: row.run_id,
    projectId: row.project_id ?? undefined,
    toolName: row.tool_name,
    args: row.args_json ?? {},
    reason: row.reason ?? undefined,
    policyId: row.policy_id ?? undefined,
    status: row.status,
    requestedAt: new Date(row.requested_at).getTime(),
    decidedAt: row.decided_at ? new Date(row.decided_at).getTime() : undefined,
    decidedBy: row.decided_by ?? undefined,
  };
}

function rowToRun(row: Record<string, any>): RunSummary {
  return {
    id: row.id,
    projectId: row.project_id,
    startedAt: new Date(row.started_at).getTime(),
    endedAt: row.ended_at ? new Date(row.ended_at).getTime() : undefined,
    status: row.status,
    totalTokens: Number(row.total_tokens),
    totalCostUsd: Number(row.total_cost_usd),
    stepCount: Number(row.step_count),
    verdict: row.verdict ?? undefined,
  };
}
