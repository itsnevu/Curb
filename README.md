<div align="center">

<img src="asset/curb-mark.png" alt="Curb" width="104" height="104" />

# Curb

**Guardrails and circuit breakers for AI agents.**

Stop runaway agents before they cost you money: infinite loops, cost blowups,
and destructive tool calls — enforced by one policy engine, at every point where
your agent touches the outside world.

[![CI](https://github.com/itsnevu/Curb/actions/workflows/ci.yml/badge.svg)](https://github.com/itsnevu/Curb/actions/workflows/ci.yml)
[![Release](https://github.com/itsnevu/Curb/actions/workflows/release.yml/badge.svg)](https://github.com/itsnevu/Curb/actions/workflows/release.yml)
[![tests](https://img.shields.io/badge/tests-282%20passing-2f6f4e)](#development)
[![license](https://img.shields.io/badge/license-MIT-6b6862)](LICENSE)

[![npm](https://img.shields.io/npm/v/@curb/sdk?label=%40curb%2Fsdk&color=cb3837&logo=npm)](https://www.npmjs.com/package/@curb/sdk)
[![PyPI](https://img.shields.io/pypi/v/curb-sdk?label=curb-sdk&color=3775a9&logo=pypi&logoColor=white)](https://pypi.org/project/curb-sdk/)
[![images](https://img.shields.io/badge/ghcr.io-curb--gateway%20%C2%B7%20curb--control--plane-2496ed?logo=docker&logoColor=white)](https://github.com/itsnevu?tab=packages&repo_name=Curb)

[Quickstart](#quickstart-60-seconds) · [Install](#install) · [How it works](#how-it-works) · [Policies](#policy-reference) · [SDKs](#sdk-reference) · [API](#http-api) · [FAQ](#faq)

</div>

---

## The problem

Anyone who has run an AI agent in production has hit at least one of these:

| | What happens | What it costs you |
| :-- | :-- | :-- |
| 🔁 **Infinite loop** | Agent gets stuck, calls the LLM with the same context forever | Never finishes, burns tokens silently |
| 💸 **Cost blowup** | A `$0.10` run becomes `$40` from retries and context growth | You find out on the invoice |
| 💥 **Destructive action** | Agent runs `delete_file`, sends an email, writes to prod DB | No undo, no approval gate |

Today most teams patch this with `if step > 20: break` scattered across the codebase —
no observability, no audit trail, no central control.

**The insight behind Curb:** a cost/loop *circuit breaker* and an action *guardrail*
are not two products. They are two kinds of **policy**, evaluated by one engine.
Curb builds that engine, then makes breakers and guardrails policies on top of it.

---

## Quickstart (60 seconds)

No API key. No Docker. The demo runs a fake LLM provider so nothing costs money:

```bash
git clone https://github.com/itsnevu/Curb.git
cd Curb
pnpm install
./scripts/demo.sh
```

You'll see all three protections fire:

```
A. Cost blowup — agent halted after passing $0.03
  ✓ call 1 passed — cumulative cost $0.012500
  ✓ call 2 passed — cumulative cost $0.025000
  ✓ call 3 passed — cumulative cost $0.037500
  ⛔ call 4 BLOCKED — Curb policy: cost_cap: run reached $0.0375 (limit $0.03)

B. Infinite loop — identical repeated messages detected
  ⛔ call 3 BLOCKED — Curb policy: loop_detect: identical message repeated 3x (limit 3)

B2. One call too expensive to risk — refused before any money is spent
  ⛔ call 1 BLOCKED — Curb policy: cost_cap: this call is estimated at $1.0000
     and would take the run to $1.0000 (limit $0.005)
  the request never reached the provider, so nothing was billed

C. Dangerous action — held until a human decides
  ✋ agent requests permission to run 'delete_file' — execution HELD
  ✓ approved by operator → deleted: /data/production.db
  ⛔ denied by operator → approval denied by operator-demo
```

The live dashboard is at the URL the demo prints (default <http://localhost:8090>).

---

## Install

Everything below is published. Nothing here needs a clone.

### 1. Run the servers

```bash
curl -O https://raw.githubusercontent.com/itsnevu/Curb/main/docker-compose.release.yml
CURB_API_KEY=pick-your-own docker compose -f docker-compose.release.yml up -d
```

Then open <http://localhost:8090> and sign in with that key.

| Service | URL | Role |
| :-- | :-- | :-- |
| **Gateway** | <http://localhost:8080> | OpenAI/Anthropic-compatible proxy — cost, loop, rate, time |
| **Control plane + dashboard** | <http://localhost:8090> | policies, Decision API, audit log, approval queue |

Images are published for `linux/amd64` and `linux/arm64`:

| Image | Tags |
| :-- | :-- |
| `ghcr.io/itsnevu/curb-gateway` | `0.2.0`, `0.2`, `latest` |
| `ghcr.io/itsnevu/curb-control-plane` | `0.2.0`, `0.2`, `latest` |

Pin a release with `CURB_VERSION=0.2.0`; the default tracks `latest`. **Pin it in
production** — `latest` moving under you is exactly the kind of surprise Curb exists to
prevent.

### 2. Add an SDK (optional)

The gateway alone gives you cost and loop protection with no code changes. Add an SDK
when you want *ask-before-acting* on tool calls:

```bash
npm i @curb/sdk        # TypeScript — https://www.npmjs.com/package/@curb/sdk
pip install curb-sdk   # Python 3.11+ — https://pypi.org/project/curb-sdk/
```

### Build from source instead

```bash
git clone https://github.com/itsnevu/Curb.git && cd Curb
cp .env.example .env
docker compose up          # postgres + redis + gateway + control-plane + dashboard
```

---

## How it works

Two enforcement points, one brain. The gateway sees every **LLM call**; the SDK sees every
**tool call**. Both ask the same policy engine.

```
                         ┌────────────────────────────┐
                         │       POLICY ENGINE        │   pure · synchronous · no I/O
                         │  cost · loop · rate · time │   strictest effect wins:
                         │  steps · tool permission   │   DENY > ASK > THROTTLE > ALLOW
                         └─────────────▲──────────────┘
                                       │ Decision
              ┌────────────────────────┼────────────────────────┐
              │                        │                        │
     ┌────────┴────────┐      ┌────────┴────────┐      ┌────────┴────────┐
     │     GATEWAY     │      │     SDK-TS      │      │   SDK-PYTHON    │
     │  (LLM proxy)    │      │   (middleware)  │      │   (middleware)  │
     └────────┬────────┘      └────────┬────────┘      └────────┬────────┘
              │                        │                        │
     intercepts LLM calls      gates tool calls         gates tool calls
     cost · loops · rate       ask-before-acting        ask-before-acting
              │                        │                        │
              └────────────────────────┴────────────────────────┘
                                       ↓
                    audit log · live dashboard · approval queue
```

**Why both?** A proxy gives you zero-code cost and loop protection the moment you change
`base_url` — but it *cannot* stop a tool from executing, because that happens inside your
process. That's what the SDK is for. Same engine, two hands.

### Decision flow

| Effect | Gateway (LLM call) | SDK (tool call) |
| :-- | :-- | :-- |
| `ALLOW` | forward to provider, meter usage | run the tool |
| `DENY` | `429`/`403` in the provider's own error shape | throw `PolicyViolation` — tool never runs |
| `ASK` | — | **hold execution** until a human approves |
| `THROTTLE` | wait, or `429` + `Retry-After` | wait `retryAfterMs`, then run |

---

## Usage

### 1. Zero-code protection (cost + loops)

Point your LLM client at the gateway. That is the only change.

```python
from openai import OpenAI

client = OpenAI(
    base_url="http://localhost:8080/v1",           # ← the only change
    default_headers={
        "X-Curb-Run-Id": run_id,                   # ties calls into one run (one budget)
        "X-Curb-Key": os.environ["CURB_API_KEY"],  # authenticates, and picks the project
    },
)
```

```ts
import { createOpenAI } from "@ai-sdk/openai";

const model = createOpenAI({
  baseURL: "http://localhost:8080/v1",
  headers: { "X-Curb-Run-Id": runId, "X-Curb-Key": process.env.CURB_API_KEY! },
})("gpt-4o");
```

Both SDKs build these for you: `curb.gatewayHeaders()` / `curb.gateway_headers()`.

The gateway refuses to start without `CURB_API_KEY` — an unauthenticated proxy is not
only open to the world, it also has to take the caller's word for which project a request
belongs to, which is the same as having no project-scoped policies at all. For local
experiments set `CURB_ALLOW_ANONYMOUS=1` and it will run without auth (and say so).

When a cost cap or loop breaker trips, the gateway returns `429` shaped exactly like the
provider's own error — so your existing SDK surfaces it as a normal error and the agent
stops on its own. Response headers carry `x-curb-run-id`, `x-curb-cost-usd`, `x-curb-policy`.

Streaming works: SSE is passed through untouched while usage is accumulated from the final
chunk, and breakers are still evaluated **before** the stream opens.

### 2. Guardrails (human approval before dangerous actions)

```bash
npm i @curb/sdk        # TypeScript
pip install curb-sdk   # Python
```

**TypeScript**

```ts
import { Curb, PolicyViolation } from "@curb/sdk";

const curb = new Curb({
  baseUrl: "http://localhost:8090",
  apiKey: process.env.CURB_API_KEY,
});

const deleteFile = curb.wrapTool(rmFile, { name: "delete_file", sensitivity: "high" });

await curb.run(async () => {
  await curb.step();                        // enforces step_limit / time_limit
  try {
    await deleteFile("/data/production.db"); // held until someone clicks Approve
  } catch (err) {
    if (err instanceof PolicyViolation) console.log("blocked:", err.policyId);
  }
});
```

**Python**

```python
from curb import Curb, PolicyViolation

curb = Curb(base_url="http://localhost:8090")

@curb.guard_tool(name="delete_file", sensitivity="high")
def delete_file(path: str) -> None:
    os.remove(path)

with curb.run() as run_id:
    curb.step()
    try:
        delete_file("/data/production.db")   # held until approved
    except PolicyViolation as e:
        print("blocked:", e.policy_id)
```

`run_id` propagates automatically — `AsyncLocalStorage` in TypeScript, `contextvars` in
Python — so nested tools never need it passed explicitly.

### 3. Define policies

Via the dashboard, or the API:

```bash
curl -X POST localhost:8090/v1/policies \
  -H "x-curb-key: $CURB_API_KEY" -H 'content-type: application/json' -d '{
    "name": "cost cap $2/run",
    "type": "cost_cap",
    "params": { "maxUsd": 2 },
    "action": "deny",
    "scope": {},
    "enabled": true
  }'
```

---

## Framework integrations

Wiring is ~20 lines each. Full examples in [`examples/`](examples/):

| Framework | Example |
| :-- | :-- |
| Vercel AI SDK | [`examples/vercel-ai-sdk.ts`](examples/vercel-ai-sdk.ts) |
| LangChain JS / LangGraph | [`examples/langchain-js.ts`](examples/langchain-js.ts) |
| LangChain Python | [`examples/langchain-python.py`](examples/langchain-python.py) |
| OpenAI SDK (zero-code) | [`examples/openai-sdk.py`](examples/openai-sdk.py) |

---

## Policy reference

Every rule reduces to the same shape, so adding a capability never changes the architecture:

```ts
interface Policy {
  id: string
  name: string
  type: "cost_cap" | "loop_detect" | "rate_limit" | "step_limit" | "time_limit" | "tool_permission"
  scope: { org?: string; project?: string; run?: string; tool?: string }
  when?: Record<string, unknown>      // e.g. { env: "prod" }
  params: Record<string, unknown>
  action: "allow" | "deny" | "ask" | "throttle"
  enabled: boolean
}
```

| Type | Params | Trips when | Enforced at |
| :-- | :-- | :-- | :-- |
| `cost_cap` | `maxUsd`, `window` (`run`/`hour`/`day`), `preflight` | Cost spent in the window reaches `maxUsd`, **or** the estimated cost of the call about to be made would pass it | Gateway |
| `loop_detect` | `maxRepeats`, `signatureWindow` | Identical message signature repeated, or a repeating tool cycle (`A→B→A→B→A→B`) | Gateway + SDK |
| `rate_limit` | `maxCalls`, `perMs` | More than `maxCalls` inside a sliding window | Gateway |
| `time_limit` | `maxWallClockMs` | Run older than the limit | Gateway + SDK |
| `step_limit` | `maxSteps` | Steps beyond the limit | SDK |
| `tool_permission` | `tools[]`, `sensitivity`, `mode` (optional override) | A tool matches by name or sensitivity | SDK |

### Narrowing a policy: `scope` vs `when`

These two are easy to mix up, and picking the wrong one is the difference between a
prod-only rule and a rule that fires everywhere.

| | Accepts | Matches on |
| :-- | :-- | :-- |
| `scope` | **only** `org`, `project`, `run`, `tool` | identity — *which* run, tool, or project |
| `when` | any key | context — `env`, plus anything you pass in `meta` |

```jsonc
{
  "scope": { "tool": "delete_file" },   // this tool
  "when":  { "env": "prod" }            // and only in prod
}
```

**`scope` rejects keys it does not recognise.** `{"scope": {"env": "prod"}}` returns `400
Unrecognized key(s) in object: 'env'` rather than quietly dropping it — a discarded scope key
silently widens a policy you thought you had narrowed, which is worse than no policy at all.
The same strictness applies to `params`, so a typo like `maxUSD` fails at write time instead
of at 3am.

**`action` decides what happens when a policy trips** — `deny`, `ask`, `throttle`, or `allow`
(which turns the rule into a no-op you can keep around). The evaluator decides *whether* the
rule is broken; the action decides the consequence. So the same `cost_cap` can hard-stop one
project and merely throttle another, with no code change. `tool_permission.mode` remains as
an explicit per-policy override of `action`.

**Cost caps hold the call before it happens.** `preflight` (on by default) prices the pending
request from its prompt size and `max_tokens` and refuses it if that would break the cap —
without it, a cap can only notice an overshoot after the money is gone. Windows wider than a
run (`hour`, `day`) are counted per project in Redis.

When several policies match, the **strictest effect wins**: `DENY > ASK > THROTTLE > ALLOW`.
Policy order never changes the outcome.

**Adding a new policy type** = one file in
[`packages/policy-engine/src/policies/`](packages/policy-engine/src/policies/) + one registry
entry + tests. No changes to the gateway or the SDKs.

---

## Design principles

These are enforced by tests, not just documented.

- **Fail-safe, not fail-open.** If the engine or control plane is unreachable, the default is
  to **deny** — in the gateway, in the Decision API, and in both SDKs. Override with
  `CURB_FAIL_MODE=open` when availability matters more than protection.
- **The engine stays pure.** `evaluate(ctx, policies, state)` is synchronous, does no I/O, and
  never calls `Date.now()` — time is injected via `ctx.now`. That is exactly why the same
  logic can run inside the gateway *and* behind the Decision API with no duplicated code.
- **Atomic counters.** Cost and steps increment through `HINCRBYFLOAT`/`HINCRBY`, so multiple
  gateway instances can't overwrite each other and leak past a cost cap.
- **No raw prompts in logs.** Audit events store summaries only. Tool arguments whose keys look
  like secrets (`password`, `token`, `api_key`, …) become `sha256:…` before they ever reach the
  approval queue — a human still sees enough context to decide.
- **First decision wins.** Approve/Deny is atomic and cannot be reversed, even if two operators
  click at the same moment; the loser gets a `409`, never a silent overwrite.
- **A cap you cannot overshoot.** `cost_cap` prices the call *before* forwarding it, so one
  expensive request cannot blow past the limit and be discovered after the money is gone.
- **Tenants cannot collide.** Run ids come from the client, so run state is keyed by project
  *and* run id — two projects using the same run id keep separate counters.
- **The project comes from the key.** The gateway derives it from the authenticated API key,
  never from a caller-supplied header, so an agent cannot escape a project-scoped policy by
  inventing a project id.
- **Nothing waits forever.** Undecided approvals expire (default 1 hour) instead of sitting in
  the queue looking actionable long after the agent gave up.
- **Long-poll, not naive polling.** Waiting SDKs hold one connection and are released the
  instant a human decides.

---

## HTTP API

All endpoints require `x-curb-key` (or `Authorization: Bearer …`). `GET /health` is open.

| Method | Endpoint | Purpose | Needs |
| :-- | :-- | :-- | :-- |
| `POST` | `/v1/decisions` | Ask for a decision (used by the SDKs) | `agent` |
| `GET` | `/v1/policies`, `/v1/policies/:id` | Read policies | `viewer` |
| `POST` `PUT` `DELETE` | `/v1/policies`, `/v1/policies/:id` | Create / update / delete | `admin` |
| `GET` | `/v1/approvals?status=pending` | Approval queue | `viewer` |
| `GET` | `/v1/approvals/:id?wait=30000` | Read, or **long-poll** for a decision | `viewer` |
| `POST` | `/v1/approvals/:id/decide` | `{ "approve": true, "by": "alice" }` | `operator` |
| `POST` | `/v1/events` | Audit ingest (used by the gateway) | `agent` |
| `GET` | `/v1/runs`, `/v1/runs/:id`, `/v1/events`, `/v1/stats` | Observability | `viewer` |
| `GET` | `/v1/me` | Who this key is: org, role, capabilities | any key |
| `GET` `POST` | `/v1/projects` | List / create projects in your org | `viewer` / `admin` |
| `GET` `POST` `DELETE` | `/v1/keys`, `/v1/keys/:id` | Mint, list and revoke API keys | `admin` |

"Needs" is the least-privileged role that suffices; `admin` can do everything.

---

## Orgs, projects and roles

An API key is not just a password — it names an **org**, a **project scope** and a **role**.

```
org ──┬── project ──┬── policies, runs, events, approvals
      │             └── keys pinned to this project
      └── project ── …
      keys scoped org-wide, choosing a project per request
```

**Tenancy.** Everything is stored per project, and a key can only ever reach projects in
its own org. A key pinned to one project cannot name another (`403`); an org-wide key
picks one per request with the `X-Curb-Project` header, and naming a project outside its
org is a `404` — the same answer a made-up id gets, because whether another tenant's
project exists is not yours to learn. Run ids come from clients, so run state is keyed by
project *and* run id: two tenants can pick the same run id without sharing a cost counter.

**Roles.** Capability sets, not a ladder:

| Role | Can | Cannot |
| :-- | :-- | :-- |
| `admin` | everything, including projects and keys | — |
| `operator` | read everything, approve/deny held calls | edit policies, manage keys |
| `agent` | submit decisions and audit events, read policies, poll its own approvals | edit policies, read the audit log |
| `viewer` | read policies, runs, events, approvals | change anything |

The `agent` role is the point of the split: an agent must be able to ask for a decision
but must never be able to edit the policy that judges it, or approve its own held call.
Give your gateway and SDKs an `agent` key, your on-call an `operator` key, and keep
`admin` for humans who administer the org.

**Minting a key.** The plaintext is returned once and never again — only its SHA-256 hash
is stored:

```bash
curl -X POST http://localhost:8090/v1/keys \
  -H "x-curb-key: $CURB_ADMIN_KEY" -H 'content-type: application/json' \
  -d '{"name":"prod gateway","role":"agent","projectId":"prod"}'
# => {"id":"key_1a2b3c4d","role":"agent","key":"curb_XZ…"}   <- copy it now

curl -X DELETE http://localhost:8090/v1/keys/key_1a2b3c4d -H "x-curb-key: $CURB_ADMIN_KEY"
```

Revocation is permanent and takes effect on the next request. You cannot revoke the key
you are authenticating with — that would lock the org out mid-request.

**Upgrading from 0.1.x.** Nothing to do. The migration turns each existing project key
into an `admin` key pinned to that project, so every key keeps exactly the access it had.
`CURB_API_KEY` still bootstraps a default org, project and admin key on first boot.

---

## SDK reference

### TypeScript SDK

```ts
new Curb({ baseUrl, apiKey, runId?, approvalTimeoutMs?, failMode?, onDecision? })
```

| Method | Description |
| :-- | :-- |
| `run(fn, runId?)` | Runs `fn` inside a run context; generates and propagates `runId` |
| `wrapTool(fn, { name, sensitivity, approvalTimeoutMs })` | Returns a guarded version of `fn` |
| `wrapTools({ a, b }, meta)` | Guards a whole tool map at once |
| `step(meta?)` | Reports one agent step (enforces `step_limit`, `time_limit`) |
| `decide(ctx)` | Raw decision, no wrapping |
| `gatewayHeaders()` | `{ "X-Curb-Run-Id": … }` to attach to your LLM client |
| `currentRunId()` | The active run id, anywhere in the async tree |

Throws `PolicyViolation` (carries `.decision`, `.policyId`, `.toolName`) and `ApprovalTimeout`.

### Python SDK

```python
Curb(base_url, api_key, run_id=None, approval_timeout_s=300, fail_mode="closed", on_decision=None)
```

| Method | Description |
| :-- | :-- |
| `with curb.run() as run_id:` | Run context manager |
| `curb.wrap_tool(fn, name=…, sensitivity=…)` | Guarded callable |
| `@curb.guard_tool(name=…, sensitivity=…)` | Decorator form |
| `curb.step(**meta)` | Reports one agent step |
| `curb.gateway_headers()` | Headers for your LLM client |

Raises `PolicyViolation` (with `.policy_id`, `.tool_name`) and `ApprovalTimeout`.

---

## Configuration

| Variable | Default | Purpose |
| :-- | :-- | :-- |
| `CURB_API_KEY` | — | Bootstrap admin key: provisions the default org, project and key on first boot |
| `CURB_FAIL_MODE` | `closed` | `closed` = deny when unreachable, `open` = allow |
| `CURB_ALLOW_ANONYMOUS` | unset | Let the gateway start with no API key. Local dev only — it refuses to boot otherwise |
| `CURB_PROJECT_ID` | `default` | Project the bootstrap key belongs to |
| `CURB_ORG_ID` | `default` | Org the bootstrap project belongs to |
| `CURB_RATE_LIMIT_PER_MINUTE` | `600` | Per-project request ceiling on the control plane; `0` disables |
| `CURB_APPROVAL_TTL_MS` | `3600000` | How long an undecided approval stays actionable |
| `DATABASE_URL` | — | Postgres. Unset → in-memory (fine for trying it out) |
| `REDIS_URL` | — | Redis run state. Unset → in-memory |
| `GATEWAY_PORT` | `8080` | Gateway port |
| `CONTROL_PLANE_PORT` | `8090` | Control plane + dashboard port |
| `CONTROL_PLANE_URL` | — | Where the gateway fetches policies and sends audit |
| `OPENAI_UPSTREAM` | `https://api.openai.com` | Upstream provider |
| `ANTHROPIC_UPSTREAM` | `https://api.anthropic.com` | Upstream provider |
| `CURB_PRICING` / `CURB_PRICING_FILE` | built-in table | Price override, JSON, USD per 1M tokens |
| `CURB_WEBHOOK_URL` | — | Webhook alert on trip / approval request |
| `CURB_SLACK_WEBHOOK_URL` | — | Slack alert (deduped per run+policy) |

---

## Project structure

```
packages/shared          shared types + Zod schemas          → npm @curb/shared
packages/policy-engine   ★ pure engine, 6 policies, state stores (memory + Redis)
packages/sdk-ts          TypeScript SDK (guardrails)         → npm @curb/sdk
sdks/python              Python SDK (guardrails)             → PyPI curb-sdk
apps/gateway             OpenAI/Anthropic proxy              → ghcr.io curb-gateway
apps/control-plane       API + Postgres + dashboard          → ghcr.io curb-control-plane
examples/                framework wiring examples
scripts/demo.ts          60-second end-to-end demo
```

`packages/policy-engine` is deliberately unpublished: the servers that use it ship as images,
and agents talk to Curb over HTTP, so publishing it would commit the project to an API surface
nobody needs yet.

**Tech:** TypeScript (Node 20+, ESM, strict) · Python 3.11+ · Fastify · Postgres · Redis ·
Zod / Pydantic · Vitest / pytest · pnpm workspaces.

---

## Development

```bash
pnpm install
pnpm test          # 247 TypeScript tests (261 with Postgres + Redis running)
pnpm typecheck     # build + tsc --noEmit across every package
pnpm demo          # end-to-end demo in a single process

# Python SDK
cd sdks/python && python -m venv .venv && .venv/bin/pip install -e ".[dev]"
.venv/bin/python -m pytest -q        # 21 tests
```

Integration tests against real databases are opt-in — skipped when the env var is absent.
CI always runs them, plus a job that builds the Docker images, boots the whole stack and
smoke-tests it, so nothing below is left unverified:

```bash
docker compose up -d postgres redis
DATABASE_URL=postgresql://curb:curb@localhost:5432/curb pnpm --filter @curb/control-plane test
REDIS_URL=redis://localhost:6379 pnpm --filter @curb/policy-engine test
```

### Cutting a release

Releasing is one action: push a tag. [`release.yml`](.github/workflows/release.yml) runs the
full suite first, then publishes the GHCR images, npm packages, and the PyPI wheel, and finally
boots the images it just pushed and smoke-tests them.

```bash
# 1. bump the version in packages/sdk-ts, packages/shared, sdks/python/pyproject.toml
# 2. tag it — the workflow refuses to publish if the tag and those three disagree
git tag v0.2.0 && git push origin v0.2.0
```

One-time setup, already done for this repo: an `NPM_TOKEN` repository secret, and a PyPI
trusted publisher pointing at `itsnevu/Curb` + `release.yml`. GHCR needs nothing — it
authenticates with the built-in `GITHUB_TOKEN`.

---

## FAQ

**Do I have to use both the gateway and the SDK?**
No. The gateway alone gives you cost and loop protection with zero code changes. Add the SDK
when you want approval gates on tool calls — a proxy fundamentally cannot do that, because tool
execution happens inside your process.

**What happens if Curb goes down?**
By default your agents **stop** (`CURB_FAIL_MODE=closed`). That is deliberate: if we can't tell
whether an action is safe, halting is safer than acting blind. Set `CURB_FAIL_MODE=open` to
invert it. The gateway also caches the last known good policy set, so a brief control-plane
restart doesn't halt anything.

**Does the proxy add latency?**
One local hop plus a synchronous, in-process policy evaluation — no database call on the hot
path. Audit is fire-and-forget and never blocks the request.

**Does the gateway need a key too?**
Yes. It refuses to start without `CURB_API_KEY` unless you explicitly set
`CURB_ALLOW_ANONYMOUS=1` for local development. An unauthenticated gateway is both an open
proxy and a policy bypass, because the project would then come from a header the caller writes.

**How is the dashboard protected?**
The page itself is public (you need it to sign in), but it contains no credential. You enter a
project API key, the browser validates it and keeps it in `sessionStorage` for that tab only,
and every request carries it explicitly. There is no shared session cookie and no key baked
into the HTML. For anything beyond a trusted network, put it behind your own SSO proxy.

**Are my prompts and API keys stored?**
Your provider API key is forwarded upstream and never persisted. Prompts are never written to
the audit log — only a hash used for loop detection. Tool arguments are redacted before storage.

**Which providers are supported?**
OpenAI and Anthropic message APIs, including streaming. Any OpenAI-compatible endpoint works by
pointing `OPENAI_UPSTREAM` at it.

**Do cost caps work if I only use the SDK?**
Partly, and this is worth knowing. `cost_cap` accumulates real spend at the **gateway**, which
is the component that sees token usage. Through the SDK alone, a cap still refuses any single
call whose estimate would break the limit, but cumulative run spend is only tracked for traffic
routed through the gateway. Point your LLM client at the gateway to get the full cap.

**Is it production-ready?**
The engine, gateway, SDKs, and approval flow are covered by 282 tests (261 TypeScript — 14 of
them needing live Postgres/Redis — plus 21 Python) including end-to-end runs, and CI exercises
Postgres, Redis, and the full Docker Compose stack on every push. Every release additionally
boots the published images and smoke-tests them before the tag is considered good.

Two honest caveats: it has never been pointed at a real OpenAI or Anthropic endpoint (only a
faithful fake upstream), and it is not multi-region or HA.

---

## Roadmap

- [x] Policy engine with 6 policy types
- [x] Gateway: OpenAI + Anthropic, streaming, real pricing
- [x] Control plane: Postgres, audit log, dashboard
- [x] SDKs: TypeScript + Python with ask-before-acting
- [x] Webhook / Slack alerts, Docker Compose, demo
- [x] CI: build, typecheck, tests against real Postgres + Redis, and a Docker Compose smoke test
- [x] Release automation: one tag publishes GHCR images, npm, and PyPI ([release.yml](.github/workflows/release.yml))
- [x] **v0.1.0 published** — `ghcr.io/itsnevu/curb-*`, [`@curb/sdk`](https://www.npmjs.com/package/@curb/sdk), [`curb-sdk`](https://pypi.org/project/curb-sdk/)
- [x] **v0.2.0** — per-org multi-tenancy and RBAC
- [ ] npm trusted publishing (OIDC), before 2FA-bypass tokens are cut off in Jan 2027
- [x] Per-org multi-tenancy and RBAC — org-scoped keys with `admin`/`operator`/`agent`/`viewer` roles
- [ ] More providers (Gemini, Bedrock, OpenAI-compatible gateways)
- [ ] Multi-agent traffic control

Full product spec: [DESIGN.md](DESIGN.md).

---

## Keywords

AI agent guardrails · LLM cost control · agent circuit breaker · LLM proxy · AI agent security ·
human-in-the-loop approval · tool call permissions · agent observability · LLM spend limits ·
infinite loop detection · policy engine for LLM agents · LangChain guardrails · Vercel AI SDK
guardrails · OpenAI proxy cost cap · Anthropic proxy · AI agent runaway protection

## License

MIT — see [LICENSE](LICENSE).
