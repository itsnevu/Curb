# Curb

**Control plane keamanan untuk AI agent** — mencegah agent kebablasan: loop tak terbatas, ledakan biaya, dan aksi berbahaya. Satu *policy engine*, dua enforcement point (Gateway proxy + SDK).

> Baca `DESIGN.md` untuk spec lengkap, dan `CLAUDE_CODE_PROMPT.md` untuk membangunnya end-to-end dengan Claude Code.

## Struktur

```
curb/
├── packages/
│   ├── shared/         # tipe & schema bersama (Policy, Decision, Context, RunState)
│   ├── policy-engine/  # INTI: evaluate() + policy (cost, loop, rate, step, time, tool-permission)
│   └── sdk-ts/         # SDK TypeScript (guard tool call)
├── apps/
│   ├── gateway/        # PROXY LLM (cost/loop breaker, nol-kode)
│   └── control-plane/  # Decision API + policy CRUD + approval + (dashboard)
├── sdks/python/        # SDK Python (guard tool call)
└── docker-compose.yml
```

## Quickstart (dev)

```bash
pnpm install
pnpm --filter @curb/policy-engine test    # jalankan test engine
docker compose up -d postgres redis
pnpm --filter @curb/gateway dev           # proxy :8080
pnpm --filter @curb/control-plane dev     # api :8090
```

**Pakai breaker (nol kode):** arahkan LLM client ke gateway:

```bash
export OPENAI_BASE_URL=http://localhost:8080/v1
# tiap call sekarang kena cost_cap + loop_detect
```

**Pakai guardrail (SDK):**

```ts
import { Curb } from "@curb/sdk";
const curb = new Curb({ runId: "run-1" });
const safeDelete = curb.wrapTool(deleteFile, { name: "delete_file", sensitivity: "high" });
```

## Status

Ini **scaffold**. Policy engine + test sudah jalan; gateway/control-plane/SDK berupa skeleton fungsional dengan `TODO(Mx)` sesuai milestone di `CLAUDE_CODE_PROMPT.md`.
