# Curb — Design Document

This is the architecture document. For usage and getting started, see [README.md](README.md).

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
                         │  cost · loop · rate · time │
                         │  steps · tool permission   │
                         └─────────────▲──────────────┘
                                       │ Decision API (allow/deny/ask/throttle)
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

---

## 4. Components

| Component | Package | Role |
| :-- | :-- | :-- |
| Policy engine | `packages/policy-engine` | `evaluate(ctx, policies, state) → Decision`. Pure, synchronous, no I/O. Imported directly by the gateway, and reached over HTTP by the SDKs. |
| Shared types | `packages/shared` | `Policy`, `Decision`, `Context`, `RunState` + Zod schemas. |
| Gateway | `apps/gateway` | Policy enforcement point for **LLM calls**. OpenAI/Anthropic-compatible endpoint. |
| Control plane | `apps/control-plane` | Decision API, policy CRUD, approvals, audit log, dashboard. |
| SDK (TS / Python) | `packages/sdk-ts`, `sdks/python` | Policy enforcement point for **tool calls**. |
| State | Redis | Ephemeral `RunState`: token/cost/step counters, loop signature windows, rate windows. |
| Persistence | Postgres | Policies, audit events, approvals, run summaries. |

### Gateway request flow

1. Identify `run_id` (from `X-Curb-Run-Id`, or generate one).
2. Push the message signature and call timestamp onto the run's windows.
3. Load `RunState` and call `evaluate()`.
4. `ALLOW` → forward upstream, then meter tokens/cost from the response and increment counters.
   `DENY` → return `429`/`403` in the provider's own error shape.
   `THROTTLE` → wait, or return `429` with `Retry-After` if the wait is too long.
5. Emit an audit event, fire-and-forget.

### SDK tool-call flow

1. `POST /v1/decisions` with the tool name, sensitivity, and redacted arguments.
2. `ALLOW` → run the tool. `DENY` → throw `PolicyViolation`; the tool never executes.
3. `ASK` → the control plane creates an approval; the SDK long-polls
   `GET /v1/approvals/:id?wait=…` and holds execution until a human decides or the budget
   expires (which then follows the fail mode).

---

## 5. The policy model

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

### MVP policy types

| Type | Params | How it works | Enforcement point |
| :-- | :-- | :-- | :-- |
| `cost_cap` | `maxUsd` | Sum cost from `RunState`; over the limit → DENY | Gateway |
| `loop_detect` | `signatureWindow`, `maxRepeats` | Hash messages / tool-call order; the same signal repeating > N → DENY | Gateway + SDK |
| `step_limit` | `maxSteps` | Count steps per run; beyond the limit → DENY | SDK |
| `rate_limit` | `maxCalls`, `perMs` | Sliding window per run | Gateway |
| `time_limit` | `maxWallClockMs` | Run older than the limit → DENY | Gateway + SDK |
| `tool_permission` | `tools[]`, `sensitivity`, `mode` | Sensitive tool → ASK (human approval) or DENY | SDK |

Adding a capability means adding one policy file, not changing the architecture. That is why
"breaker first, full guardrails later" needed no rewrite.

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

## 6. Data model (Postgres)

```
orgs(id, name, created_at)
projects(id, org_id, name, api_key_hash, created_at)
policies(id, project_id, name, type, scope_json, when_json, params_json, action, enabled, …)
runs(id, project_id, started_at, ended_at, status, total_tokens, total_cost_usd, step_count, verdict)
events(id, run_id, project_id, ts, kind, effect, policy_id, reason, context_json, decision_json)
approvals(id, run_id, project_id, tool_name, args_json, reason, policy_id, status,
          requested_at, decided_at, decided_by)
```

`RunState` lives in Redis under `curb:run:{id}` with a 24-hour TTL: `{ tokens, costUsd,
stepCount, startedAt, sigWindow[], toolWindow[], callTimestamps[] }`. Counters use
`HINCRBY`/`HINCRBYFLOAT` so they stay atomic across gateway instances — a read-modify-write
here is exactly how a cost cap leaks under concurrency.

Approvals are decided with `UPDATE … WHERE status='pending'`, which makes the first decision
win atomically without an explicit transaction, even if two operators click at once.

---

## 7. End-to-end scenarios

**A — Cost cap (zero code, via the proxy).**
User sets `OPENAI_BASE_URL=https://gw.curb.dev/v1` plus `X-Curb-Key`. Policy: `cost_cap
{ maxUsd: 2.00 }`. The gateway updates cost after each call; once cumulative cost passes $2,
the next call gets `429 { reason: "cost_cap: run reached $2.00 (limit $2.00)" }`. The agent
stops, the event is recorded, the dashboard shows the tripped run.

**B — Loop breaker.**
The agent gets stuck sending identical messages. The gateway computes signatures and, on
repeat number `maxRepeats`, denies and marks the run's verdict.

**C — Ask-before-acting (via the SDK).**
`delete_file` is wrapped with `wrapTool(deleteFile, { name: 'delete_file', sensitivity: 'high' })`.
Policy: `tool_permission { tools: ['delete_file'], mode: 'ask' }`. When the agent tries to
call it, the SDK gets `ASK`, an approval is created, and **execution is held**. A human sees it
on the dashboard (or in Slack), clicks Approve or Deny, and the SDK either proceeds or throws
`PolicyViolation`.

---

## 8. Security posture

- **API keys** are stored as SHA-256 hashes; the raw key never touches the database. The
  provider key passes through the gateway to the upstream and is never persisted.
- **Curb headers are stripped** before forwarding upstream, so `x-curb-*` never leaks to
  OpenAI or Anthropic.
- **Prompts are never logged.** Audit events carry summaries and a signature hash, not content.
- **Tool arguments are redacted** before storage: long values are truncated, and keys matching
  `password|secret|token|key|auth|credential|cookie|session` become `sha256:…`. A human
  reviewing an approval still sees enough context to decide.
- **Auth is required everywhere** except `/health` and the dashboard shell — including the
  Decision API, since an unauthenticated decision endpoint would let anyone read another
  project's policies or forge runs.

---

## 9. Non-goals (for now)

- Not a general APM / observability product — the focus is security decisions, not full tracing.
- Not an LLM router or load balancer, although the proxy could grow in that direction.
- No multi-region or HA story yet.
- No "memory passport" or multi-agent traffic control yet.

---

## 10. Tech stack

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
The schema itself is exactly as specified in §6.
