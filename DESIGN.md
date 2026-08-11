# Curb — Design Document

The architecture and reference document for this repository: what every component is, what
every exported function does, and — where it matters — why it works the way it does rather
than the obvious way. For installation and usage, see [README.md](README.md).

**Contents**

1. [The problem](#1-the-problem) · 2. [Design principles](#2-design-principles) ·
3. [Form factor](#3-form-factor-why-hybrid) · 4. [Components](#4-components) ·
5. [Request flows](#5-request-flows) · 6. [The policy model](#6-the-policy-model) ·
7. [Tenancy and RBAC](#7-tenancy-and-rbac) · 8. [Data model](#8-data-model) ·
9. [HTTP API](#9-http-api) · 10. [Module reference](#10-module-reference) ·
11. [Configuration](#11-configuration) · 12. [Security posture](#12-security-posture) ·
13. [Testing strategy](#13-testing-strategy) · 14. [Release and operations](#14-release-and-operations) ·
15. [Non-goals](#15-non-goals-for-now) · 16. [Tech stack](#16-tech-stack)

---

## 1. The problem

Anyone who has run an AI agent in production has hit at least one of these:

1. **Infinite loops.** The agent gets stuck, calling the LLM over and over with the same
   context, never finishing.
2. **Cost blowups.** A run that should cost $0.10 becomes $40 through retries, context
   growth, or the loop above. You find out on the invoice.
3. **Dangerous actions without permission.** The agent executes a destructive tool — delete
   a file, send an email, make a payment, write to a production database — with no approval
   gate in front of it.

All three are symptoms of the same illness: **the agent runs with no policy layer able to
stop it.** Today, teams patch this individually with `if step > 20: break` scattered through
the codebase — no observability, no audit trail, no central control.

**The core product insight:** a *circuit breaker* (cost/loop) and a *guardrail* (action
permission) are **not two products**. They are two kinds of **policy**, evaluated by the same
engine. Curb builds that engine; breakers and guardrails become policies on top of it.

---

## 2. Design principles

- **Fail-safe, not fail-open.** When in doubt, or when the policy engine is unreachable, the
  default is *stop*, not *continue*. Configurable per environment via `CURB_FAIL_MODE`.
- **Zero-to-low code to adopt.** The first layer (cost/loop breaker) must work without
  changing agent code at all.
- **One policy engine, many enforcement points.** The brain (policy evaluation) is central;
  the hands (enforcement) are distributed.
- **Language-agnostic core, idiomatic edges.** The core doesn't care about languages; thin
  SDKs make it comfortable in TypeScript and Python.
- **Observable by default.** Every decision (allow/deny/ask/throttle) is recorded: which run,
  which policy, what reason, how much it had cost so far.
- **Nothing the caller controls decides what they may do.** Project, run identity and role
  come from the key. Anything supplied in a header is a *choice within* what the key already
  grants, never an expansion of it.

---

## 3. Form factor: why hybrid

Neither a proxy nor an SDK alone is sufficient.

| Form factor | Strengths | Limits |
| :-- | :-- | :-- |
| **Proxy / gateway** (user points `base_url` at us) | **Zero-code** adoption, language-agnostic, sees **every** LLM call — perfect for metering cost and detecting loops. Kill switch is trivial: refuse the call. | **Cannot** hold a tool execution inside the user's runtime. It sees the model *requesting* a tool call, but the execution happens in user code. Guardrails are weak here. |
| **SDK / middleware** (user wraps the agent loop) | **Deep control**: sees every step and every tool call **before** execution — permission gates, ask-before-acting, blast-radius limits. | Per language (TypeScript *and* Python to maintain), and adoption requires code changes. |
| **CLI wrapper** (`curb run python agent.py`) | Easiest thing to try, one command. | Shallow observability, hard to get tool-level context, not production-grade. |

Curb ships **proxy + thin SDKs over one policy engine**:

```
                         ┌────────────────────────────┐
                         │       POLICY ENGINE        │   the brain
                         │  cost · loop · rate · time │   pure · synchronous · no I/O
                         │  steps · tool permission   │
                         └─────────────▲──────────────┘
                                       │ Decision (allow/deny/ask/throttle)
              ┌────────────────────────┼────────────────────────┐
     ┌────────┴────────┐      ┌────────┴────────┐      ┌────────┴────────┐
     │     GATEWAY     │      │     SDK-TS      │      │   SDK-PYTHON    │   the hands
     │     (proxy)     │      │   (middleware)  │      │   (middleware)  │
     └────────┬────────┘      └────────┬────────┘      └────────┬────────┘
     intercept LLM call        gate tool call           gate tool call
      (cost, loops)             (guardrail)              (guardrail)
```

- The **proxy is the universal safety net.** The moment a user points `base_url` at it, every
  LLM call is visible — cost and loops are caught with no code change. It is the easiest door
  to walk through.
- The **SDK is the deep guardrail layer.** Ask-before-acting requires intercepting the tool
  call inside the user's runtime, which only in-process code can do.
- **Both report to one policy engine.** A breaker is one policy, a guardrail is another. No
  duplicated logic.

Note the asymmetry in how the two reach the engine: the gateway **imports** it and evaluates
in-process (it is on the hot path of every LLM call and cannot afford a round trip), while the
SDKs call `POST /v1/decisions` over HTTP. Same function, two call sites.

---

## 4. Components

| Component | Package | Role |
| :-- | :-- | :-- |
| Policy engine | `packages/policy-engine` | `evaluate(ctx, policies, state) → Decision`. Pure, synchronous, no I/O. Imported by the gateway, reached over HTTP by the SDKs. |
| Shared types | `packages/shared` | `Policy`, `Decision`, `Context`, `RunState` + Zod schemas, redaction, signatures. |
| Gateway | `apps/gateway` | Enforcement point for **LLM calls**. OpenAI/Anthropic-compatible proxy. |
| Control plane | `apps/control-plane` | Decision API, policy CRUD, approvals, audit log, org/key admin, dashboard. |
| SDK (TS / Python) | `packages/sdk-ts`, `sdks/python` | Enforcement point for **tool calls**. |
| State | Redis | Ephemeral `RunState`: token/cost/step counters, loop signature windows, rate windows, cost buckets. |
| Persistence | Postgres | Orgs, projects, API keys, policies, audit events, approvals, run summaries. |

Both stores have in-memory implementations behind the same interface, so the whole system
runs — and is tested end to end — with no database at all.

---

## 5. Request flows

### Gateway request flow

1. Authenticate. The key resolves to a project; a caller-supplied `X-Curb-Project` is ignored.
2. Identify `run_id` (from `X-Curb-Run-Id`, or generate one).
3. Price the request **before** forwarding it, and load `RunState` plus the hour/day cost
   buckets.
4. Call `evaluate()` against state as it *would be* with this call included.
5. `ALLOW` → forward upstream, meter tokens/cost from the response, commit the counters.
   `DENY` → return `429`/`403` in the provider's own error shape; nothing is forwarded and no
   counters move. `THROTTLE` → wait, or return `429` with `Retry-After` if the wait exceeds
   `maxThrottleMs`.
6. Emit an audit event, fire-and-forget.

Step 3 is the part that is easy to get wrong. Pricing a call only *after* it returns is not a
cap: a single expensive request can overshoot any limit, and you find out once the money is
gone. Estimating first costs an approximation, but the approximation is on the safe side of a
number the user chose.

### SDK tool-call flow

1. `POST /v1/decisions` with the tool name, sensitivity, and redacted arguments.
2. `ALLOW` → run the tool. `DENY` → throw `PolicyViolation`; the tool never executes.
3. `ASK` → the control plane creates an approval; the SDK long-polls
   `GET /v1/approvals/:id?wait=…` and holds execution until a human decides or the budget
   expires (which then follows the fail mode).

---

## 6. The policy model

Every rule reduces to one uniform shape:

```ts
interface Policy {
  id: string
  name: string
  type: PolicyType            // 'cost_cap' | 'loop_detect' | 'rate_limit'
                              // | 'tool_permission' | 'step_limit' | 'time_limit'
  scope: PolicyScope          // { org?, project?, run?, tool? } — where it applies
  when?: Condition            // optional extra condition, e.g. env === 'prod'
  params: Record<string, unknown>
  action: Action              // 'allow' | 'deny' | 'ask' | 'throttle'
  enabled: boolean
}

function evaluate(ctx: Context, policies: Policy[], state: RunState): Decision
// Decision = { effect: 'ALLOW'|'DENY'|'ASK'|'THROTTLE', policyId?, reason?, retryAfterMs? }
```

`Context` is either an `llm_call` (seen by the gateway) or a `tool_call` / `step` (seen by the
SDK). The engine selects policies matching scope + type + `when`, evaluates each, and returns
the **strictest** decision: `DENY > ASK > THROTTLE > ALLOW`. Policy order never matters.

**Evaluators decide *whether* a rule broke; `action` decides *what happens*.** They are
separate on purpose: the same `cost_cap` at the same threshold can deny, ask a human, throttle,
or merely record — `action: 'allow'` makes a policy audit-only, which is how you roll one out
before enforcing it.

### Policy types

| Type | Params | How it works | Enforcement point |
| :-- | :-- | :-- | :-- |
| `cost_cap` | `maxUsd`, `window` (`run`\|`hour`\|`day`), `preflight` | Sum cost from `RunState` or the hour/day bucket; at or over the limit → trip. With `preflight` (default on) it also refuses a call whose *estimate* would cross it | Gateway |
| `loop_detect` | `signatureWindow`, `maxRepeats` | Hash messages / tool-call order; the same signal repeating > N → trip | Gateway + SDK |
| `step_limit` | `maxSteps` | Count steps per run; beyond the limit → trip | SDK |
| `rate_limit` | `maxCalls`, `perMs` | Sliding window per run | Gateway |
| `time_limit` | `maxWallClockMs` | Run older than the limit → trip | Gateway + SDK |
| `tool_permission` | `tools[]`, `sensitivity`, `mode` | Sensitive tool → ASK (human approval) or DENY | SDK |

Adding a capability means adding one policy file, not changing the architecture. That is why
"breaker first, full guardrails later" needed no rewrite.

Params are validated per type at **write** time, not read time (`PolicySchema` in
`packages/shared`), so a typo like `maxUSD` is rejected when the policy is saved rather than
silently matching nothing forever.

### Loop detection in detail

Two signals are combined:

1. **Semantic repeat** — a normalised hash of `messages` (timestamps and ids dropped). The
   same hash appearing ≥ `maxRepeats` times within the last `signatureWindow` calls is a loop.
2. **Tool-cycle repeat** — the same short tool sequence repeating (e.g. A→B→A→B→A→B).

On detection the breaker trips: the rest of the run is denied, an event is recorded, and a
webhook/Slack alert can fire.

### Boundary conventions

Two conventions matter when reading the evaluators, because they decide whether a limit means
"N allowed" or "N−1 allowed":

- `cost_cap` uses `>=`, because cost is only known **after** a call returns.
- `step_limit` and `rate_limit` use `>`, because the caller increments the counter **before**
  evaluating, so the current call is already included.

---

## 7. Tenancy and RBAC

An API key is not just a password. It names an **org**, a **project scope** and a **role**.

```
org ──┬── project ──┬── policies · runs · events · approvals
      │             └── keys pinned to this project
      └── project ── …
      keys scoped org-wide, choosing a project per request
```

**Project selection.** A key pinned to a project acts on that project and nothing else;
naming another is a `403` rather than a silent no-op, because ignoring the header would make
it look like it worked. An org-wide key (`api_keys.project_id IS NULL`) selects one per
request with `X-Curb-Project`, checked against the key's org *before* use. Naming a project
outside the org returns `404` — the same answer an invented id gets, since whether another
tenant's project exists is not information to hand out.

**Run state is keyed by project *and* run id.** Run ids come from clients, so two tenants can
pick the same one; without the project in the key they would share a cost counter, and either
could read or exhaust the other's budget.

**Roles are capability sets, not a ladder:**

| Role | Capabilities |
| :-- | :-- |
| `admin` | everything, including `org:admin` (projects and keys) |
| `operator` | `read`, `policies:read`, `approvals:read`, `approvals:decide` |
| `agent` | `policies:read`, `decisions:write`, `approvals:read` |
| `viewer` | `read`, `policies:read`, `approvals:read` |

The `agent` role is the point of the split. An agent must be able to ask for a decision, but
must never be able to edit the policy that judges it, or approve the call it just had held —
that is the entire reason the policy engine runs outside the agent. `operator` is the mirror
image: it can release a held tool call but cannot loosen the policy that held it.

Guards are applied **per route and per verb**, not per router, because reading a policy and
writing one are not the same permission.

**Key lifecycle.** Keys are minted with `generateApiKey()` (`curb_` + 24 random bytes,
base64url); the plaintext is returned exactly once and only its SHA-256 is stored. Revocation
sets `revoked_at` and is permanent — the hash stays so the same secret can never be re-issued.
Revoking the key you are authenticating with is refused: it locks you out mid-request and, on
the last admin key, for good.

---

## 8. Data model

### Postgres

```
orgs(id, name, created_at)
projects(id, org_id, name, api_key_hash, created_at)   -- api_key_hash is legacy; see api_keys
api_keys(id, org_id, project_id, name, key_hash, role, created_at, revoked_at)
policies(id, project_id, name, type, scope_json, when_json, params_json, action, enabled, …)
runs(id, project_id, started_at, ended_at, status, total_tokens, total_cost_usd, step_count, verdict)
events(id, run_id, project_id, ts, kind, effect, policy_id, reason, context_json, decision_json)
approvals(id, run_id, project_id, tool_name, args_json, reason, policy_id, status,
          requested_at, decided_at, decided_by)
```

`api_keys.project_id` is nullable — `NULL` means org-wide. `role` is constrained in the schema
to `admin | operator | agent | viewer`, so an invalid role cannot exist even if written
directly through SQL.

Migrations are plain `.sql` files under `apps/control-plane/src/db/migrations`, applied in
filename order inside a transaction each, tracked in `_curb_migrations`. `PostgresRepo.init()`
is idempotent and runs on every boot.

- `001_init.sql` — the schema above, minus `api_keys`.
- `002_rbac.sql` — adds `api_keys`, backfills one `admin` key per existing project from
  `projects.api_key_hash`, and drops that column's `NOT NULL`. This is what makes 0.1.x
  upgrades a no-op: every existing key keeps exactly the access it had.

Two concurrency details are load-bearing:

- **Run counters only ever grow.** Events arrive out of order (the gateway batches them), so
  the run upsert uses `GREATEST()`/`COALESCE()`; a late event carrying a smaller snapshot must
  not rewind a run's totals. `MemoryRepo` mirrors this exactly.
- **Approvals are decided with `UPDATE … WHERE status='pending'`**, which makes the first
  decision win atomically without an explicit transaction, even if two operators click at
  once. The loser gets `changed: false` and writes neither a duplicate audit event nor a
  second wake-up to waiters.

### Redis

`runKey(projectId, runId)` composes the logical id as `{project}|{runId}`, which
`RedisRunStateStore` stores under the `curb:run:` prefix (windows get a `:{window}` suffix,
cost buckets live under `curb:run:cost:`). State carries a 24-hour TTL:
`{ tokens, costUsd, stepCount, startedAt, sigWindow[], toolWindow[], callTimestamps[] }`.
Counters use `HINCRBY`/`HINCRBYFLOAT` so they stay atomic across gateway instances — a
read-modify-write here is exactly how a cost cap leaks under concurrency. Windows are bounded
(`WINDOW_CAPS`) so a long run cannot grow state without limit.

Cost buckets wider than one run (`hour`, `day`) are separate keys with their own TTLs, which
is what makes `cost_cap` with a `window` param meaningful across runs.

---

## 9. HTTP API

All endpoints require `x-curb-key` (or `Authorization: Bearer …`). `GET /health` and the
dashboard shell `GET /` are open.

| Method | Endpoint | Purpose | Needs |
| :-- | :-- | :-- | :-- |
| `POST` | `/v1/decisions` | Ask for a decision (used by the SDKs) | `decisions:write` |
| `GET` | `/v1/policies`, `/v1/policies/:id` | Read policies | `policies:read` |
| `POST` `PUT` `DELETE` | `/v1/policies`, `/v1/policies/:id` | Create / update / delete | `policies:write` |
| `GET` | `/v1/approvals?status=pending` | Approval queue | `approvals:read` |
| `GET` | `/v1/approvals/:id?wait=30000` | Read, or long-poll for a decision | `approvals:read` |
| `POST` | `/v1/approvals/:id/decide` | `{ "approve": true, "by": "alice" }` | `approvals:decide` |
| `POST` | `/v1/events` | Audit ingest (used by the gateway) | `decisions:write` |
| `GET` | `/v1/runs`, `/v1/runs/:id`, `/v1/events`, `/v1/stats` | Observability | `read` |
| `GET` | `/v1/me` | Org, role, capabilities of this key | any valid key |
| `GET` `POST` | `/v1/projects` | List / create projects in your org | `read` / `org:admin` |
| `GET` `POST` | `/v1/keys` | List / mint keys | `org:admin` |
| `DELETE` | `/v1/keys/:id` | Revoke a key | `org:admin` |

Error bodies are uniform: `{ error: { message, type, … } }`. Types worth handling:
`unauthorized`, `forbidden` (carries `requiredCapability`), `project_required` (carries the
list of projects to choose from), `conflict`, `curb_already_decided`, `self_revoke`.

The gateway speaks the **provider's** error shape instead, so a denial looks like a normal
OpenAI or Anthropic error to a client that has never heard of Curb.

---

## 10. Module reference

Exported surface of each package. Internal helpers are omitted.

### `packages/shared`

The vocabulary every other package speaks. No dependencies beyond Zod.

**`types.ts`** — `PolicyType`, `Effect`, `Action`, `PolicyScope`, `Condition`, `Policy`,
`ContextKind`, `Context`, `Decision`, `RunState`, `RunStateDelta`, `WindowKey`,
`CostWindowKey`, `RunStateStore`, plus `EFFECT_SEVERITY` (the strictness order that makes
policy order irrelevant) and `ACTION_EFFECT` (how a configured action becomes an effect).

`RunStateStore` is the storage contract both implementations satisfy:

| Method | Purpose |
| :-- | :-- |
| `get(runId)` | Load state; returns an empty state rather than null |
| `save(state)` | Overwrite wholesale (used by tests and resets) |
| `bump(runId, delta)` | **Atomically** increment counters; returns the new state |
| `pushWindow(runId, key, value, cap)` | Push onto a bounded window, return its contents |
| `reset(runId)` | Drop a run's state |
| `bumpCost(key, costUsd)` | Add to an hour/day cost bucket, return the new total |
| `getCost(bucket)` | Read a bucket; `0` when expired or absent |

**`schemas.ts`** — `PolicyScopeSchema`, `POLICY_PARAMS` (the per-type param schemas),
`PolicyTypeSchema`, `PolicySchema` (full validation including params-for-this-type),
`PolicyShapeSchema` (structure only, for partial input), `DecisionSchema`, `PolicyInput`.

**`redact.ts`**
- `digestArgs(args, depth?)` — redact tool arguments for storage: truncate long values, and
  replace anything whose key matches `password|secret|token|key|auth|credential|cookie|session`
  with `sha256:…`. A human reviewing an approval still sees enough context to decide.
- `fingerprint(value)` — stable short hash of any value.

**`signature.ts`**
- `signatureOf(messages)` — normalised hash of a message array for semantic loop detection.
- `hashOf(value)` — stable hash of anything.

### `packages/policy-engine`

Pure evaluation. No I/O, no clock of its own (time arrives in the context).

**`engine.ts`**
- `evaluate(ctx, policies, state) → Decision` — filter by scope/type/`when`, run each
  evaluator, return the strictest effect.

**`keys.ts`**
- `runKey(projectId, runId)` — namespaced state key; the reason two tenants cannot collide.
- `costWindowKeys(projectId, now)` — the hour/day bucket keys and their boundaries.

**`policies/`** — one evaluator per type, all of shape
`(ctx, policy, state) => Decision | null`: `costCap`, `loopDetect`, `stepLimit`, `rateLimit`,
`timeLimit`, `toolPermission`, indexed by `POLICY_EVALUATORS`. `nowOf(ctx, state)` resolves
the effective clock.

**`state.ts`**
- `WINDOW_CAPS` — per-window bounds.
- `emptyState(runId, now)` — the zero state.
- `InMemoryRunStateStore` — full `RunStateStore` for dev and tests.

**`redis-state.ts`**
- `RedisLike` — the narrow slice of ioredis actually used, so tests can fake it.
- `RedisRunStateStore` — the production store; atomic counters, TTLs, bounded windows.

### `packages/sdk-ts` (`@curb/sdk`)

**`Curb`** — the facade an agent uses:

| Member | Purpose |
| :-- | :-- |
| `run(fn, runId?)` | Run a function inside a run context (AsyncLocalStorage) |
| `runId()` | The current run id |
| `gatewayHeaders()` | Headers to pass to your LLM client so the gateway sees the same run |
| `step(meta?)` | Register a step; enforces `step_limit` and `loop_detect` |
| `wrapTool(fn, meta)` | Wrap one tool so it is gated before it executes |
| `wrapTools(tools)` | Wrap a whole map of tools at once |
| `decide(ctx)` | Escape hatch: ask for a decision directly |

**`CurbClient`** — the transport: `decide(ctx)`, `waitApproval(id, waitMs)`, `getApproval(id)`.

**Errors** — `PolicyViolation` (thrown on `DENY`), `ApprovalTimeout` (a held call nobody
decided in time). `currentRunId()` reads the ambient run id.

### `sdks/python` (`curb-sdk`)

Deliberately the same shape, in Python idiom: `Curb` with `run()` (a context manager),
`run_id()`, `gateway_headers()`, `step()`, `wrap_tool()`, `guard_tool()` (decorator form) and
`decide()`; `CurbClient` with `decide()`, `wait_approval()`, `get_approval()`, `close()`; the
same `PolicyViolation` / `ApprovalTimeout`; `current_run_id()` and `digest_args()`.

### `apps/gateway`

**`app.ts`** — `buildApp(deps: GatewayDeps)`. Dependencies are injected (`store`,
`loadPolicies`, `forward`, `audit`, `prices`, `failMode`, `maxThrottleMs`, `authenticate`,
`bodyLimit`, `now`, `logger`), which is what lets the whole proxy be tested against a fake
upstream with no network.

**`auth.ts`**
- `presentedKeys(header)` — a header can arrive twice (set by hand *and* by
  `gatewayHeaders()`); HTTP joins repeats with commas, so split and try each candidate.
- `secretsMatch(a, b)` — constant-time compare; hashes first so the comparison is fixed-width
  and the length of the real key cannot leak through a throw.
- `keyAuthenticator(keys)` — the project comes from the key. `ALLOW_ANONYMOUS` exists for dev
  and tests, and `index.ts` refuses to boot with it unless `CURB_ALLOW_ANONYMOUS=1`.

**`providers.ts`** — `detectProvider`, `upstreamFor`, `sanitizeHeaders` (strips `CURB_HEADERS`
so `x-curb-*` never reaches OpenAI or Anthropic), `extractUsage`, `messagesOf`, `isStreaming`,
`estimateTokens`, `estimateUsage`, and `StreamUsageAccumulator` (`push(chunk)` / `result()`)
which recovers usage from a streamed response.

**`pricing.ts`** — `DEFAULT_PRICING_PER_MTOK` and `PriceTable` (`priceFor`, `costUsd`, `has`),
overridable via `CURB_PRICING` / `CURB_PRICING_FILE`.

**`policy-source.ts`** — `PolicySource.load()` fetches policies from the control plane with a
TTL cache; `parsePolicies(body)` validates them. **`intercept.ts`** — `forwardUpstream(...)`.
**`errors.ts`** — `statusForDecision`, `errorBody` (the provider-shaped denial).
**`audit.ts`** — `AuditSink`, `NULL_SINK`, `HttpAuditSink` (batched, fire-and-forget, reports
what it had to drop).

### `apps/control-plane`

**`app.ts`** — `buildApp(deps: ControlPlaneDeps)`: mounts the dashboard, then one authenticated
scope carrying auth → rate limit → approval-expiry sweep → routes.

**`auth.ts`**
- `hashApiKey(key)` / `generateApiKey()` / `apiKeyOf(req)`.
- `Principal` — `{ orgId, role, keyId, keyName, scopedProjectId? }`.
- `makeAuth(repo)` — authenticate, resolve the principal, and select the project (§7).
- `requireCapability(cap)` — the per-route guard.
- `provisionProject(repo, opts)` — create a project and a key that can reach it, idempotent on
  the key; used by bootstrap, the demo and the tests.
- `ensureDevProject(repo, apiKey)` — bootstrap a default org/project/admin key from env.

**`rbac.ts`** — `ROLES`, `CAPABILITIES`, `GRANTS` (private), `capabilitiesOf(role)`,
`can(role, cap)`, `isRole(value)`. The one place the permission table lives; `/v1/me` serves it
to the dashboard so the UI never has to guess.

**`repo/`** — `Repo` is the only door to storage, with two implementations (`PostgresRepo`,
`MemoryRepo`) covering projects, API keys, policies, events, approvals and runs. Types:
`Project`, `ApiKey`, `EventRecord`, `Approval`, `ApprovalStatus`, `DecideResult`, `RunSummary`.

**`routes/`** — `registerDecisions`, `registerPolicies`, `registerApprovals`,
`registerObservability`, `registerOrg`.

**`approval-hub.ts`** — `ApprovalHub`: `publish(approval)`, `wait(id, timeoutMs)`,
`pendingWaiters(id)`. The long-poll rendezvous between a waiting SDK and a human clicking
Approve.

**`expiry.ts`** — `expireApprovals(...)` and `throttledExpiry(...)`: undecided approvals must
not sit in the queue looking live, but sweeping is a background chore, not part of serving a
request.

**`notify.ts`** — `Notifier`, `NULL_NOTIFIER`, `HttpNotifier`, `notifierFromEnv()`. Webhook and
Slack alerts, deduped per run+policy.

**`rate-limit.ts`** — `rateLimiter({ perMinute, now })`, per API key.

**`public/dashboard.html`** — one dependency-free file, no build step. It holds no credential:
`GET /` is unauthenticated by necessity, so the browser prompts for a key, validates it against
`/v1/me`, and keeps it in `sessionStorage` for that tab. It renders from the capabilities that
call returns — hiding controls the role lacks, and not requesting endpoints it would only be
refused.

---

## 11. Configuration

| Variable | Default | Purpose |
| :-- | :-- | :-- |
| `CURB_API_KEY` | — | Bootstrap admin key: provisions the default org, project and key on first boot |
| `CURB_ORG_ID` / `CURB_PROJECT_ID` | `default` | Identity of that bootstrap org/project |
| `CURB_FAIL_MODE` | `closed` | `closed` = deny when the engine is unreachable, `open` = allow |
| `CURB_ALLOW_ANONYMOUS` | unset | Let the gateway start with no key. Local dev only |
| `CURB_RATE_LIMIT_PER_MINUTE` | `600` | Per-key ceiling on the control plane; `0` disables |
| `CURB_APPROVAL_TTL_MS` | `3600000` | How long an undecided approval stays actionable |
| `CURB_BODY_LIMIT_BYTES` | 8 MB / 32 MB | Max request body (control plane / gateway) |
| `DATABASE_URL` | — | Postgres. Unset → in-memory |
| `REDIS_URL` | — | Redis run state. Unset → in-memory |
| `GATEWAY_PORT` / `CONTROL_PLANE_PORT` | `8080` / `8090` | Ports |
| `CONTROL_PLANE_URL` | — | Where the gateway fetches policies and sends audit |
| `OPENAI_UPSTREAM` / `ANTHROPIC_UPSTREAM` | the real APIs | Upstream override |
| `CURB_PRICING` / `CURB_PRICING_FILE` | built-in table | Price override, USD per 1M tokens |
| `CURB_WEBHOOK_URL` / `CURB_SLACK_WEBHOOK_URL` | — | Alerts |

---

## 12. Security posture

- **API keys** are stored as SHA-256 hashes; the raw key never touches the database. The
  provider key passes through the gateway to the upstream and is never persisted.
- **Authority comes from the key, never from a header.** The gateway used to trust
  `X-Curb-Project`, which was a policy bypass by design: an agent could escape any
  project-scoped policy by inventing a project id.
- **Curb headers are stripped** before forwarding upstream, so `x-curb-*` never leaks to
  OpenAI or Anthropic.
- **Prompts are never logged.** Audit events carry summaries and a signature hash, not content.
- **Tool arguments are redacted twice** — by the SDK before sending, and again on arrival,
  because a third-party client might not redact and raw secrets must never reach storage.
- **Auth is required everywhere** except `/health` and the dashboard shell — including the
  Decision API, since an unauthenticated decision endpoint would let anyone read another
  project's policies or forge runs.
- **Cross-tenant reads answer `404`, not `403`**, so the API does not confirm the existence of
  another org's projects or keys.
- **The dashboard shell carries no credential**, sends `no-store`, a restrictive CSP, and
  `frame-ancestors 'none'`. A `401` from any call signs the tab out.

---

## 13. Testing strategy

282 tests: 261 TypeScript (Vitest) and 21 Python (pytest).

- **Hermetic by default.** `MemoryRepo` and `InMemoryRunStateStore` let the entire HTTP API be
  exercised end to end with no database, which is what keeps the suite fast.
- **Integration tests are opt-in**, skipped when `DATABASE_URL` / `REDIS_URL` are absent, and
  always run in CI: 8 Postgres repo tests (including migrations and key revocation) and 6
  Redis atomicity tests.
- **The fake upstream is faithful**, so the gateway's streaming, usage extraction, pricing and
  error shapes are all covered without spending money.
- **`scripts/verify-examples.ts`** runs the README's own integration snippets against that
  upstream in CI, so the documented wiring cannot silently rot.
- **CI also boots the Docker Compose stack** and smoke-tests it, and every release boots the
  images it just pushed before the tag is considered good.

---

## 14. Release and operations

Releasing is one action: push a tag. `release.yml` runs the full suite, refuses to publish if
the tag disagrees with `packages/sdk-ts`, `packages/shared` and `sdks/python/pyproject.toml`,
then publishes the GHCR images, the npm packages and the PyPI wheel, and finally boots the
images it just pushed and smoke-tests them.

Deployment is two stateless services plus Postgres and Redis. The gateway is on the hot path
of every LLM call and evaluates in-process, so it scales horizontally without coordination —
which is exactly why the Redis counters must be atomic.

---

## 15. Non-goals (for now)

- Not a general APM / observability product — the focus is security decisions, not full tracing.
- Not an LLM router or load balancer, although the proxy could grow in that direction.
- No multi-region or HA story yet.
- No "memory passport" or multi-agent traffic control yet.
- No user accounts, passwords or sessions. Identity is the API key; RBAC hangs off that. A
  login system is a real product decision, not a missing feature.

Two honest caveats: the gateway has never been pointed at a real OpenAI or Anthropic endpoint
(only a faithful fake upstream), and nothing here is multi-region or HA.

---

## 16. Tech stack

- **Languages:** TypeScript (Node 20+, ESM, strict) for the engine, gateway, control plane,
  dashboard and TS SDK. Python 3.11+ for the Python SDK.
- **Web:** Fastify for the gateway and API. The dashboard is a single dependency-free HTML
  file served by Fastify — no build step, no CDN.
- **Data:** Postgres (raw SQL through `pg`, with a small idempotent migrator), Redis (ioredis).
- **Validation:** Zod (TypeScript), plain dicts with explicit checks (Python).
- **Monorepo:** pnpm workspaces. **Tests:** Vitest (TS), pytest (Python).
- **Dev:** docker compose (postgres + redis + gateway + control-plane).

### Deviation from the original spec

The spec suggested Prisma or Drizzle. The implementation uses raw SQL behind a `Repo`
interface with two implementations (Postgres and in-memory) instead. The reason: it removes a
codegen step, and — more importantly — it lets the entire HTTP API be tested end-to-end
without a live database, which is what makes the control-plane test suite fast and hermetic.
