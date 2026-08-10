# Curb — Design & Product Spec

> **Curb** — nama produk (codename awal: Nomos).
> Nama ini codename/placeholder — gampang di-find-replace kalau mau ganti (kandidat lain: Curb, Rein, Governor).
>
> **Satu kalimat:** Curb adalah lapisan kontrol di antara agent kamu dan dunia luar (LLM API + tools), yang **mencegah agent kebablasan** — loop tak terbatas, ledakan biaya, dan aksi berbahaya — lewat satu *policy engine* terpusat.

---

## 1. Kenapa ini dibangun (problem)

Siapa pun yang pernah menjalankan AI agent pasti pernah kena minimal satu dari ini:

1. **Loop tak terbatas** — agent nyangkut, memanggil LLM berulang-ulang dengan konteks yang sama, nggak pernah selesai.
2. **Ledakan biaya** — satu run yang harusnya $0.10 tiba-tiba jadi $40 karena retry, konteks membengkak, atau loop di atas. Ketahuannya belakangan pas lihat tagihan.
3. **Aksi berbahaya tanpa izin** — agent mengeksekusi tool yang destruktif (hapus file, kirim email, transaksi, `rm -rf`, DB write) tanpa ada gerbang persetujuan.

Ketiganya sebenarnya **gejala dari satu penyakit yang sama**: agent berjalan tanpa *policy layer* yang bisa menghentikannya. Hari ini tiap tim menambal sendiri dengan `if step > 20: break` yang tersebar di mana-mana, tanpa observability, tanpa audit, tanpa kontrol terpusat.

**Insight inti produk:** *circuit breaker* (cost/loop) dan *guardrail* (izin aksi) itu **bukan dua produk** — keduanya cuma dua jenis **policy** yang dievaluasi oleh engine yang sama. Curb membangun engine itu, lalu breaker & guardrail jadi policy di atasnya.

---

## 2. Prinsip desain

- **Fail-safe, bukan fail-open.** Kalau ragu / policy engine down, default-nya *stop*, bukan *lanjut* (opsional, bisa dikonfigurasi per-environment).
- **Zero-to-low code untuk dipakai.** Lapisan pertama (cost/loop breaker) harus bisa dipakai tanpa mengubah kode agent sama sekali.
- **Satu policy engine, banyak enforcement point.** Otak (evaluasi policy) terpusat; tangan (tempat penegakan) tersebar.
- **Language-agnostic di inti, idiomatik di tepi.** Inti tidak peduli bahasa; SDK tipis bikin nyaman di TS & Python.
- **Observable by default.** Tiap keputusan (allow/deny/ask) tercatat: run mana, policy mana, alasan apa, biaya berapa.

---

## 3. Rekomendasi Form Factor (jawaban atas pertanyaan arsitektur)

Kamu memilih **dua bahasa (TS + Python)** dan **full guardrail framework**. Dengan dua syarat itu, **tidak ada satu form factor tunggal yang cukup.** Ini kenapa:

| Form factor | Kelebihan | Kekurangan | Cocok untuk |
|---|---|---|---|
| **Proxy / Gateway** (user ganti `base_url` LLM ke kita) | Adopsi **nol-kode**, language-agnostic, langsung lihat **semua** LLM call → sempurna buat hitung cost & deteksi loop. Kill switch gampang (tinggal tolak call). | **Tidak bisa** menahan *eksekusi tool* di runtime user. Proxy cuma lihat *permintaan* model buat manggil tool, tapi eksekusi tool ada di kode user → **guardrail/ask-before-acting lemah**. | Cost cap, loop detect, rate limit, kill switch |
| **SDK / Middleware** (user bungkus agent loop) | Kontrol **dalam**: lihat tiap step & tiap tool call **sebelum** dieksekusi → bisa gerbang izin, ask-before-acting, blast-radius. | **Per bahasa** (harus maintain TS + Python), adopsi lebih ribet (user ubah kode). | Guardrail, permission, approval, policy per-tool |
| **CLI wrapper** (`curb run python agent.py`) | Paling gampang dicoba, satu perintah. | Observability dangkal, susah dapat konteks tool-level, kurang production-grade. | Demo, quickstart lokal |

### → Rekomendasi: **Hybrid** — Proxy + SDK tipis (TS & Python) di atas satu Policy Engine

```
                    ┌─────────────────────────┐
                    │     POLICY ENGINE        │  ← otak: evaluasi semua policy
                    │  (cost, loop, rate,      │
                    │   tool-permission, ...)  │
                    └───────────▲─────────────┘
                                │  Decision API (allow/deny/ask/throttle)
              ┌─────────────────┼──────────────────┐
              │                 │                  │
        ┌─────┴─────┐    ┌──────┴──────┐    ┌──────┴──────┐
        │  GATEWAY  │    │   SDK-TS    │    │ SDK-PYTHON  │  ← tangan (enforcement points)
        │  (proxy)  │    │ (middleware)│    │ (middleware)│
        └─────┬─────┘    └──────┬──────┘    └──────┬──────┘
              │                 │                  │
       intercept LLM      gerbang tool       gerbang tool
       call (cost/loop)   call (guardrail)   call (guardrail)
```

**Kenapa hybrid, bukan salah satu saja:**

- **Proxy jadi jaring pengaman universal.** Begitu user arahkan `base_url`, *semua* LLM call kelihatan — cost & loop ketahan tanpa mereka sentuh kode. Ini "pintu masuk" yang paling gampang dijual.
- **SDK jadi lapisan guardrail dalam.** Untuk ask-before-acting / permission (yang kamu mau sejak awal), kita **wajib** intercept tool call di runtime user — dan itu cuma bisa dari dalam kode (SDK). Proxy nggak bisa.
- **Dua-duanya nyetor ke satu Policy Engine.** Persis insight kamu: breaker = satu policy, guardrail = policy lain, semua satu engine. Tidak ada logika ganda.

Konsekuensi praktis: **mulai dari Proxy + Policy Engine dulu** (nilai kebukti cepat), lalu SDK menyusul untuk mengaktifkan guardrail penuh. Arsitektur di bawah sudah menyiapkan keduanya.

---

## 4. Arsitektur sistem

Tiga bidang klasik: **control plane**, **data plane**, **policy engine** (dipakai bersama).

### 4.1 Komponen

- **Policy Engine** (`packages/policy-engine`, TS, murni/stateless-logic)
  Fungsi inti `evaluate(context, policies, state) → Decision`. Tidak tahu HTTP, tidak tahu DB. Bisa diimpor langsung oleh Gateway & Control Plane, atau dipanggil via Decision API oleh SDK.

- **Gateway / Proxy** (`apps/gateway`, TS + Fastify) — *Policy Enforcement Point untuk LLM call*
  OpenAI/Anthropic-compatible endpoint. User set `base_url` ke sini. Tiap request:
  1. Identifikasi `run_id` (dari header `X-Curb-Run-Id` atau di-generate).
  2. Ambil `RunState` (counter token/cost/step/loop-signature) dari store.
  3. Panggil `evaluate()` dengan konteks LLM-call.
  4. Kalau `ALLOW` → forward ke provider asli, hitung token/cost dari response, update state. Kalau `DENY` → balikin error `429/403` dengan alasan. Kalau `THROTTLE` → delay.

- **Control Plane** (`apps/control-plane`, TS + Fastify + web dashboard) — *otak operasional*
  - Decision API (`POST /v1/decisions`) buat SDK yang butuh keputusan.
  - CRUD policy & policy-set (`/v1/policies`).
  - Approval API (`/v1/approvals`) untuk ask-before-acting (human-in-the-loop).
  - Audit log & metrics (`/v1/runs`, `/v1/events`).
  - Dashboard: lihat run berjalan, biaya real-time, event yang di-block, antrian approval.

- **SDK-TS** (`packages/sdk-ts`) & **SDK-Python** (`sdks/python`) — *PEP untuk tool call*
  - `guard.wrapTool(fn, {name, sensitivity})` → sebelum eksekusi, tanya Decision API; kalau `ASK`, tahan & tunggu approval.
  - `guard.run(fn)` → bikin `run_id`, ikat context, laporkan step.
  - Auto-set `base_url` LLM ke Gateway (opsional) supaya cost/loop juga kejaring.

- **State store**: Redis (counter per-run, loop signature window, rate window). **Persistensi**: Postgres (policy, audit event, approval, run summary).

### 4.2 Alur data (data flow)

```
Agent  ──LLM call──►  Gateway ──evaluate()──► Policy Engine
                        │  ALLOW → provider asli → update RunState (token, cost)
                        │  DENY  → 429 + reason (breaker trip)
Agent  ──tool call──►  SDK guard ──POST /decisions──► Control Plane ──evaluate()──► Policy Engine
                        │  ALLOW → jalankan tool
                        │  ASK   → buat Approval → tunggu → (approve→jalan / deny→batal)
                        │  DENY  → lempar PolicyViolation
Semua keputusan ──────► Audit log (Postgres) ──────► Dashboard
```

---

## 5. Model policy (jantung sistem)

Semua aturan direduksi jadi satu bentuk seragam:

```ts
interface Policy {
  id: string
  name: string
  type: PolicyType            // 'cost_cap' | 'loop_detect' | 'rate_limit'
                              // | 'tool_permission' | 'step_limit' | 'time_limit'
  scope: PolicyScope          // { org?, project?, run?, tool? } — di mana berlaku
  when?: Condition            // opsional: kondisi tambahan (mis. env == 'prod')
  params: Record<string, any> // parameter spesifik per-type
  action: Action              // 'allow' | 'deny' | 'ask' | 'throttle'
  enabled: boolean
}
```

Fungsi evaluasi:

```ts
function evaluate(ctx: Context, policies: Policy[], state: RunState): Decision
// Decision = { effect: 'ALLOW'|'DENY'|'ASK'|'THROTTLE', policyId?, reason?, retryAfterMs? }
```

`Context` bisa berupa `llm_call` (dilihat Gateway) atau `tool_call`/`step` (dilihat SDK). Engine memilih policy yang match scope + type + when, mengevaluasi, dan mengembalikan keputusan paling ketat (DENY > ASK > THROTTLE > ALLOW).

### Policy tipe MVP

| Type | Params | Cara kerja | Enforcement point |
|---|---|---|---|
| `cost_cap` | `maxUsd`, `window` (`run`/`hour`/`day`) | Jumlahkan cost dari RunState; lewat batas → DENY | Gateway |
| `loop_detect` | `signatureWindow`, `maxRepeats` | Hash pesan/urutan tool-call; sinyal sama berulang > N → DENY | Gateway + SDK |
| `step_limit` | `maxSteps` | Hitung step per run; lewat → DENY | SDK |
| `rate_limit` | `maxCalls`, `perMs` | Sliding window per run/tool | Gateway |
| `time_limit` | `maxWallClockMs` | Umur run > batas → DENY | Gateway + SDK |
| `tool_permission` | `tools[]`, `sensitivity`, `mode` (`ask`/`deny`/`allow`) | Tool sensitif → ASK (human approve) atau DENY | SDK |

Menambah kemampuan baru = menambah satu file policy, bukan mengubah arsitektur. Inilah kenapa "breaker dulu → guardrail penuh" tidak butuh rewrite.

### Loop detection (detail)

Dua sinyal digabung:
1. **Semantic repeat** — hash normalisasi dari `messages` (buang timestamp/id). Sama persis muncul ≥ `maxRepeats` dalam `signatureWindow` call terakhir → loop.
2. **Tool-cycle repeat** — urutan `tool → tool → tool` yang sama berulang (mis. A→B→A→B→A→B) → loop.

Kalau loop terdeteksi → trip breaker (DENY sisa call di run itu) + catat event + (opsional) kirim webhook/Slack.

---

## 6. Data model (Postgres)

```
orgs(id, name)
projects(id, org_id, name, api_key_hash)
policies(id, project_id, name, type, scope_json, when_json, params_json, action, enabled, created_at)
runs(id, project_id, started_at, ended_at, status, total_tokens, total_cost_usd, step_count, verdict)
events(id, run_id, ts, kind, context_json, decision_json, policy_id)   -- audit trail
approvals(id, run_id, tool_name, args_json, status, requested_at, decided_at, decided_by)
```

`RunState` (Redis, ephemeral, TTL): `run:{id}` → `{ tokens, costUsd, stepCount, startedAt, sigWindow[], toolWindow[] }`.

---

## 7. Flow end-to-end (skenario nyata)

**Skenario A — Cost cap (nol kode, via proxy):**
1. User set `OPENAI_BASE_URL=https://gw.curb.dev/v1` + `X-Curb-Key`.
2. Policy aktif: `cost_cap { maxUsd: 2.00, window: run }`.
3. Agent jalan; tiap call Gateway update cost. Saat kumulatif > $2 → call berikutnya dapat `429 { reason: "cost_cap: run melebihi $2.00" }`.
4. Agent berhenti, event tercatat, dashboard menampilkan run yang di-trip.

**Skenario B — Loop breaker:**
1. Agent nyangkut, kirim messages identik berulang.
2. Gateway hitung signature; pada repeat ke-`maxRepeats` → DENY + tandai `verdict: looped`.

**Skenario C — Ask-before-acting (guardrail, via SDK):**
1. Tool `delete_file` di-wrap: `guard.wrapTool(deleteFile, { name:'delete_file', sensitivity:'high' })`.
2. Policy: `tool_permission { tools:['delete_file'], mode:'ask' }`.
3. Saat agent mau panggil `delete_file`, SDK POST ke Decision API → `ASK` → buat Approval → **tahan eksekusi**.
4. Manusia lihat di dashboard/Slack, klik Approve/Deny → SDK lanjut atau lempar `PolicyViolation`.

---

## 8. Roadmap / milestone (dipakai juga oleh prompt Claude Code)

- **M0 — Fondasi & Policy Engine.** Types, `evaluate()`, RunState store (in-memory + Redis), unit test policy `cost_cap`, `loop_detect`, `step_limit`.
- **M1 — Gateway (breaker).** OpenAI/Anthropic-compatible proxy, forwarding, penghitungan token/cost, integrasi engine, error DENY yang rapi. *Titik "nilai kebukti cepat".*
- **M2 — Control Plane + Dashboard.** Decision API, CRUD policy, audit log, dashboard run/cost/event realtime.
- **M3 — SDK (guardrail).** SDK-TS & SDK-Python: `run()`, `wrapTool()`, ask-before-acting + approval flow.
- **M4 — Integrasi & polish.** Adaptor contoh (Vercel AI SDK, LangChain JS/Py), webhook/Slack alert, quickstart, docker-compose one-command up.

Acceptance ringkas tiap milestone ada di `CLAUDE_CODE_PROMPT.md`.

---

## 9. Non-goals (MVP)

- Bukan APM/observability umum (fokus: keputusan keamanan, bukan tracing lengkap).
- Bukan LLM router/load-balancer (walau proxy bisa berkembang ke sana).
- Belum multi-region / HA di MVP.
- Belum "memory passport" / multi-agent traffic control (ide #4/#5 — nanti).

---

## 10. Tech stack

- **Bahasa:** TypeScript (Node 20+) untuk engine, gateway, control-plane, dashboard, sdk-ts. Python 3.11+ untuk sdk-python.
- **Web:** Fastify (gateway & API), Next.js/React (dashboard).
- **Data:** Postgres (Prisma/Drizzle), Redis (ioredis).
- **Validasi:** Zod (TS), Pydantic (Py).
- **Monorepo:** pnpm workspaces. **Test:** Vitest (TS), pytest (Py).
- **Dev:** docker-compose (postgres + redis + gateway + control-plane).
