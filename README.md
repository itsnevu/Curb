<div align="center">

# Curb

**Guardrails and circuit breakers for AI agents.**

Stop runaway agents before they cost you money: infinite loops, cost blowups,
and destructive tool calls — enforced by one policy engine, at every point where
your agent touches the outside world.

[![tests](https://img.shields.io/badge/tests-175%20passing-2f6f4e)](#development)
[![typescript](https://img.shields.io/badge/TypeScript-strict-3178c6)](#)
[![python](https://img.shields.io/badge/Python-3.11%2B-3776ab)](#python-sdk)
[![license](https://img.shields.io/badge/license-MIT-6b6862)](LICENSE)

[Quickstart](#quickstart-60-seconds) · [How it works](#how-it-works) · [Policies](#policy-reference) · [SDKs](#sdk-reference) · [API](#http-api) · [FAQ](#faq)

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

C. Dangerous action — held until a human decides
  ✋ agent requests permission to run 'delete_file' — execution HELD
  ✓ approved by operator → deleted: /data/production.db
  ⛔ denied by operator → approval denied by operator-demo
```

The live dashboard is at the URL the demo prints (default <http://localhost:8090>).

### Full stack

```bash
cp .env.example .env
docker compose up          # postgres + redis + gateway + control-plane + dashboard
```

| Service | URL | Role |
| :-- | :-- | :-- |
| **Gateway** | <http://localhost:8080> | OpenAI/Anthropic-compatible proxy — cost, loop, rate, time |
| **Control plane + dashboard** | <http://localhost:8090> | policies, Decision API, audit log, approval queue |

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
    default_headers={"X-Curb-Run-Id": run_id},
)
```

```ts
import { createOpenAI } from "@ai-sdk/openai";

const model = createOpenAI({
  baseURL: "http://localhost:8080/v1",
  headers: { "X-Curb-Run-Id": runId },
})("gpt-4o");
```

When a cost cap or loop breaker trips, the gateway returns `429` shaped exactly like the
provider's own error — so your existing SDK surfaces it as a normal error and the agent
stops on its own. Response headers carry `x-curb-run-id`, `x-curb-cost-usd`, `x-curb-policy`.

Streaming works: SSE is passed through untouched while usage is accumulated from the final
chunk, and breakers are still evaluated **before** the stream opens.

### 2. Guardrails (human approval before dangerous actions)

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

| Type | Params | Behaviour | Enforced at |
| :-- | :-- | :-- | :-- |
| `cost_cap` | `maxUsd` | Sum run cost; over the limit → `DENY` | Gateway |
| `loop_detect` | `maxRepeats`, `signatureWindow` | Identical message signature repeated, or a repeating tool cycle (`A→B→A→B→A→B`) → `DENY` | Gateway + SDK |
| `rate_limit` | `maxCalls`, `perMs` | Sliding window per run → `THROTTLE` | Gateway |
| `time_limit` | `maxWallClockMs` | Run older than the limit → `DENY` | Gateway + SDK |
| `step_limit` | `maxSteps` | Steps beyond the limit → `DENY` | SDK |
| `tool_permission` | `tools[]`, `sensitivity`, `mode` (`ask`/`deny`/`allow`) | Sensitive tool → `ASK` (human approval) or `DENY` | SDK |

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
  click at the same moment.
- **Long-poll, not naive polling.** Waiting SDKs hold one connection and are released the
  instant a human decides.

---

## HTTP API

All endpoints require `x-curb-key` (or `Authorization: Bearer …`). `GET /health` is open.

| Method | Endpoint | Purpose |
| :-- | :-- | :-- |
| `POST` | `/v1/decisions` | Ask for a decision (used by the SDKs) |
| `GET` `POST` | `/v1/policies` | List / create policies |
| `GET` `PUT` `DELETE` | `/v1/policies/:id` | Read / update / delete |
| `GET` | `/v1/approvals?status=pending` | Approval queue |
| `GET` | `/v1/approvals/:id?wait=30000` | Read, or **long-poll** for a decision |
| `POST` | `/v1/approvals/:id/decide` | `{ "approve": true, "by": "alice" }` |
| `POST` | `/v1/events` | Audit ingest (used by the gateway) |
| `GET` | `/v1/runs`, `/v1/runs/:id`, `/v1/events`, `/v1/stats` | Observability |

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
| `CURB_API_KEY` | — | Project API key (gateway, SDKs, dashboard) |
| `CURB_FAIL_MODE` | `closed` | `closed` = deny when unreachable, `open` = allow |
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
packages/shared          shared types + Zod schemas
packages/policy-engine   ★ pure engine, 6 policies, state stores (memory + Redis)
packages/sdk-ts          TypeScript SDK (guardrails)
sdks/python              Python SDK (guardrails)
apps/gateway             OpenAI/Anthropic proxy (circuit breaker)
apps/control-plane       API + Postgres + dashboard + approvals
examples/                framework wiring examples
scripts/demo.ts          60-second end-to-end demo
```

**Tech:** TypeScript (Node 20+, ESM, strict) · Python 3.11+ · Fastify · Postgres · Redis ·
Zod / Pydantic · Vitest / pytest · pnpm workspaces.

---

## Development

```bash
pnpm install
pnpm test          # 155 TypeScript tests
pnpm typecheck     # build + tsc --noEmit across every package
pnpm demo          # end-to-end demo in a single process

# Python SDK
cd sdks/python && python -m venv .venv && .venv/bin/pip install -e ".[dev]"
.venv/bin/python -m pytest -q        # 20 tests
```

Integration tests against real databases are opt-in — skipped when the env var is absent:

```bash
docker compose up -d postgres redis
DATABASE_URL=postgresql://curb:curb@localhost:5432/curb pnpm --filter @curb/control-plane test
REDIS_URL=redis://localhost:6379 pnpm --filter @curb/policy-engine test
```

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

**Is it production-ready?**
The engine, gateway, SDKs, and approval flow are covered by 175 tests including end-to-end runs.
Postgres persistence has a full integration suite that requires you to run it against your own
database once. It is not yet multi-region or HA.

---

## Roadmap

- [x] Policy engine with 6 policy types
- [x] Gateway: OpenAI + Anthropic, streaming, real pricing
- [x] Control plane: Postgres, audit log, dashboard
- [x] SDKs: TypeScript + Python with ask-before-acting
- [x] Webhook / Slack alerts, Docker Compose, demo
- [ ] Postgres suite verified in CI
- [ ] Per-org multi-tenancy and RBAC
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
