# Claude Code — End-to-End Build Prompt: **Curb**

> **Cara pakai (baca ini dulu, lalu hapus blok ini sebelum menempel):**
> 1. Prompt di bawah ditulis dalam Bahasa Inggris supaya presisi untuk Claude Code. Kamu boleh menambah kalimat Bahasa Indonesia di akhir kalau mau.
> 2. Taruh scaffold ini (folder `curb/`) sebagai working directory Claude Code, lalu tempel seluruh isi di bawah garis `═══`.
> 3. Prompt ini menyuruh Claude Code membangun **bertahap per milestone (M0→M4)** dan berhenti minta review di tiap milestone. Kalau mau full-auto, hapus kalimat "Stop after each milestone…".
> 4. Ganti nama produk: find-replace `Curb` → nama pilihanmu.

═══════════════════════════════════════════════════════════════════

## ROLE

You are the lead engineer building **Curb**, a security control plane for AI agents. It prevents agents from running away: infinite loops, cost blowups, and dangerous actions. There is an existing scaffold in this repository — **read it first**, then extend it. Do not rewrite the architecture; fill in the `TODO(Mx)` markers.

Read these files before writing any code: `DESIGN.md` (full spec), `README.md`, and everything under `packages/`, `apps/`, `sdks/`. `DESIGN.md` is the source of truth; if this prompt and `DESIGN.md` disagree, follow `DESIGN.md` and flag the conflict.

## PRODUCT IN ONE PARAGRAPH

Curb sits between an agent and the outside world (LLM APIs + tools) and enforces **policies**. The core insight: a cost/loop *circuit breaker* and an action *guardrail* are not two products — they are two kinds of policy evaluated by one engine. There are two enforcement points that both call that one engine: a **Gateway** (an OpenAI/Anthropic-compatible proxy — zero-code, catches cost & loops on every LLM call) and **SDKs** (TypeScript + Python — wrap tool calls, enabling deny/ask-before-acting that a proxy cannot do). Everything funnels into a control plane with audit log + dashboard + human approval queue.

## ARCHITECTURE (already scaffolded — respect it)

- `packages/shared` — shared types (`Policy`, `Decision`, `Context`, `RunState`) + Zod schemas.
- `packages/policy-engine` — **the core**. Pure, synchronous `evaluate(ctx, policies, state) → Decision`. Policy registry in `src/policies/`. Strictest effect wins: `DENY > ASK > THROTTLE > ALLOW`. Has passing tests.
- `apps/gateway` — Fastify proxy. Enforcement point for **LLM calls** (cost_cap, loop_detect, rate/time limit, kill switch).
- `apps/control-plane` — Fastify API: Decision API (for SDKs), policy CRUD, approval flow, audit; plus a dashboard.
- `packages/sdk-ts`, `sdks/python` — enforcement point for **tool calls** (tool_permission, ask-before-acting).
- State: Redis (ephemeral `RunState`), Postgres (policies, events, approvals, runs).

## GLOBAL CONSTRAINTS

- **Stack:** TypeScript (Node 20+, ESM, `strict`), Python 3.11+ for the Python SDK. pnpm workspaces. Fastify. Postgres + Redis. Zod (TS) / Pydantic (Py). Vitest (TS) / pytest (Py).
- **Fail-safe:** honor `CURB_FAIL_MODE`. Default `closed` = if the engine/deps are unavailable, **deny** (stop the agent) rather than let it run unchecked. Make this the default everywhere a decision can't be computed.
- **The engine stays pure.** No I/O, no HTTP, no DB inside `policy-engine`. All state is passed in via `RunState`. This is what lets the same logic run inside the gateway and behind the Decision API.
- **Adding a capability = adding one policy file** in `packages/policy-engine/src/policies/` + one registry entry + tests. Never branch business logic into the gateway/SDK.
- **Everything is observable.** Every decision (allow/deny/ask/throttle) must produce an audit event: runId, policyId, effect, reason, timestamp, cost snapshot.
- **Security:** never log full prompts/args at info level (may contain secrets/PII); hash or truncate. API keys via env only. The gateway must strip Curb headers before forwarding upstream (already done — keep it).

## HOW TO WORK

- Build **milestone by milestone (M0 → M4)**. After each milestone: run all tests, run `pnpm typecheck`, write/update the milestone's acceptance test, update `README.md` if the run steps changed, and **make one git commit** titled `feat(Mx): …`. **Stop after each milestone and summarize what changed + how to verify**, then wait for me to say continue.
- Test-first for the engine and any policy: write the failing test, then implement.
- Prefer small, composable modules. Keep files under ~200 lines. Match the existing code style.
- When you make a non-obvious decision, leave a short `// why:` comment.
- If something in the scaffold is wrong or a `TODO` is ambiguous, ask a concise question before proceeding — do not guess on architecture.

## MILESTONES & ACCEPTANCE CRITERIA

### M0 — Foundation & Policy Engine
Solidify the core (most of it is scaffolded).
- Implement/confirm all six policy evaluators: `cost_cap`, `loop_detect`, `step_limit`, `rate_limit`, `time_limit`, `tool_permission`.
- Implement `RedisRunStateStore` in `policy-engine/src/state.ts` (ioredis): `run:{id}` hash, atomic counters (`INCRBYFLOAT` for cost, `INCR` for steps), TTL (e.g. 24h), and windowed lists for sig/tool/timestamps.
- **Accept:** `pnpm --filter @curb/policy-engine test` passes; tests cover each policy (allow + trip cases), "strictest effect wins", and loop-cycle detection (`A,B,A,B,A,B` → DENY). RedisRunStateStore has an integration test (can use `ioredis-mock` or a docker redis).

### M1 — Gateway (the circuit breaker) ← *fastest time-to-value*
Make the proxy production-shaped for OpenAI **and** Anthropic message APIs.
- Support `POST /v1/chat/completions`, `/v1/messages`, and **streaming (SSE)** — for streaming, accumulate usage from the final chunk and still enforce pre-call breakers.
- Real per-model price table (configurable via JSON/env), correct token extraction for both providers.
- Wire `RedisRunStateStore`. Emit an audit event to the control plane (fire-and-forget HTTP or a queue) on every decision.
- Clean `429`/`403` error bodies mirroring the provider's error shape so client SDKs surface them naturally, with `x-curb-*` headers (run id, cost, tripped policy).
- **Accept:** an integration test where a fake upstream returns usage, cost accumulates across calls, and the `(N+1)`th call is `DENY`ed by `cost_cap`; a loop test where identical `messages` repeated `maxRepeats` times gets `DENY`ed; streaming passthrough works.

### M2 — Control Plane + Dashboard
- Postgres schema (Prisma or Drizzle) per `DESIGN.md §6`. Migrations. Persist policies, events, approvals, run summaries.
- Decision API `POST /v1/decisions` backed by Postgres policies + Redis state (replace in-memory maps).
- Policy CRUD with Zod validation; project/API-key auth (hash keys).
- Approval flow: `ASK` → create approval → `GET/POST /v1/approvals/:id/decide`.
- **Dashboard** (Next.js or a Fastify-served React app): live runs with real-time cost, a feed of blocked/asked events, the pending-approval queue with Approve/Deny buttons, and a policy editor.
- **Accept:** create a policy via API → it's enforced by the Decision API; an `ASK` decision appears in the dashboard queue and approving it unblocks the waiting SDK caller (end-to-end test).

### M3 — SDKs (the guardrail)
Both SDKs are scaffolded; make them robust.
- TS (`packages/sdk-ts`) and Python (`sdks/python`): `wrapTool`/`guard_tool`, `run()` context that generates/propagates `runId` and reports `step`s, and a client for the Decision + approval APIs.
- Ask-before-acting: on `ASK`, block the tool call until approval resolves; support a **timeout** (configurable) that falls back to `CURB_FAIL_MODE` (default deny). Prefer webhook/long-poll over naive polling.
- Optionally auto-point the LLM client's `base_url` at the gateway so cost/loop is covered too.
- **Accept:** a Python and a TS example agent where a `high`-sensitivity tool triggers `ASK`, waits, and proceeds only after dashboard approval; a `deny` policy raises `PolicyViolation`. Unit tests for both.

### M4 — Integrations & Polish
- Framework adapters/examples: **Vercel AI SDK**, **LangChain JS**, **LangChain Python** — show wiring in ~20 lines each under `examples/`.
- Alerts: webhook + Slack on trip/ask events.
- `docker compose up` brings up postgres + redis + gateway + control-plane + dashboard in one command; a `scripts/demo.sh` runs a scripted agent that (a) hits a cost cap, (b) triggers a loop trip, (c) triggers an approval — so the whole thing is demoable in 60 seconds.
- **Accept:** fresh clone → `pnpm install && cp .env.example .env && docker compose up` → `scripts/demo.sh` demonstrates all three protections; README quickstart verified.

## DEFINITION OF DONE (whole project)
A developer can, without reading the source: point their base_url at the gateway and get automatic cost + loop protection; install an SDK and gate sensitive tools behind human approval; define policies and watch decisions/costs/approvals live in a dashboard; and run the full stack locally with one command. All packages typecheck; all tests pass in CI.

## FIRST ACTIONS
1. Read `DESIGN.md` + the scaffold. 2. Run `pnpm install` and `pnpm --filter @curb/policy-engine test` to confirm the baseline is green. 3. Start **M0**. 4. Stop after M0 and report.
