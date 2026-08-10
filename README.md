# Curb

**Control plane keamanan untuk AI agent.** Curb duduk di antara agent kamu dan dunia luar
(LLM API + tools), lalu mencegah agent kebablasan: **loop tak terbatas**, **ledakan biaya**,
dan **aksi berbahaya tanpa izin**.

Wawasan intinya: *circuit breaker* (cost/loop) dan *guardrail* (izin aksi) bukan dua produk —
keduanya cuma dua jenis **policy** yang dievaluasi satu engine.

```
                    ┌──────────────────────────┐
                    │      POLICY ENGINE       │   murni, sinkron, tanpa I/O
                    └────────────▲─────────────┘
                                 │ allow / deny / ask / throttle
                 ┌───────────────┼────────────────┐
           ┌─────┴─────┐   ┌─────┴──────┐   ┌─────┴──────┐
           │  GATEWAY  │   │   SDK-TS   │   │ SDK-PYTHON │
           │  (proxy)  │   │            │   │            │
           └─────┬─────┘   └─────┬──────┘   └─────┬──────┘
          LLM call            tool call        tool call
       (cost, loop, rate)     (izin, ask)      (izin, ask)
```

## Coba dalam 60 detik

Tanpa API key, tanpa docker — demo memakai provider LLM palsu:

```bash
pnpm install
./scripts/demo.sh
```

Demo menjalankan tiga agent dan menunjukkan ketiganya dihentikan:

```
A. Ledakan biaya — agent dihentikan saat melewati $0.03
  ✓ call 1 lewat — biaya kumulatif $0.012500
  ✓ call 2 lewat — biaya kumulatif $0.025000
  ✓ call 3 lewat — biaya kumulatif $0.037500
  ⛔ call 4 DITOLAK — Curb policy: cost_cap: run mencapai $0.0375 (batas $0.03)

B. Loop tak terbatas — pesan identik berulang terdeteksi
  ⛔ call 3 DITOLAK — Curb policy: loop_detect: pesan identik berulang 3x (batas 3)

C. Aksi berbahaya — ditahan sampai manusia memutuskan
  ✋ agent minta izin menjalankan 'delete_file' — eksekusi DITAHAN
  ✓ disetujui operator → terhapus: /data/produksi.db
  ⛔ ditolak operator → approval ditolak oleh operator-demo
```

Dashboard live ada di URL yang dicetak demo (default <http://localhost:8090>).

## Stack penuh

```bash
cp .env.example .env
docker compose up          # postgres + redis + gateway + control-plane + dashboard
```

| Layanan | URL | Fungsi |
| --- | --- | --- |
| Gateway | <http://localhost:8080> | proxy OpenAI/Anthropic — cost, loop, rate, time |
| Control plane + dashboard | <http://localhost:8090> | policy, Decision API, audit, antrian approval |

## Cara pakai

### 1. Perlindungan nol-kode (cost + loop)

Ganti `base_url` klien LLM ke gateway. Tidak ada perubahan lain.

```python
client = OpenAI(base_url="http://localhost:8080/v1", default_headers={"X-Curb-Run-Id": run_id})
```

Saat cost cap atau loop breaker nyala, gateway membalas `429` dengan bentuk error milik
provider — jadi SDK klien memunculkannya sebagai error biasa, dan agent berhenti sendiri.

### 2. Guardrail (izin sebelum bertindak)

Proxy tidak bisa menahan eksekusi tool — itu terjadi di dalam kode kamu. Di situlah SDK masuk.

```ts
import { Curb } from "@curb/sdk";
const curb = new Curb({ baseUrl: "http://localhost:8090", apiKey: process.env.CURB_API_KEY });

const hapus = curb.wrapTool(deleteFile, { name: "delete_file", sensitivity: "high" });

await curb.run(async () => {
  await hapus("/data/produksi.db");   // ditahan sampai manusia klik Approve
});
```

```python
from curb import Curb
curb = Curb()

@curb.guard_tool(name="delete_file", sensitivity="high")
def delete_file(path): ...

with curb.run():
    delete_file("/data/produksi.db")
```

Contoh wiring framework (~20 baris) ada di [`examples/`](examples/): Vercel AI SDK,
LangChain JS, LangChain Python, OpenAI SDK.

### 3. Definisikan policy

Lewat dashboard, atau API:

```bash
curl -X POST localhost:8090/v1/policies -H "x-curb-key: $CURB_API_KEY" \
  -H 'content-type: application/json' -d '{
    "name": "cost cap $2/run", "type": "cost_cap",
    "params": {"maxUsd": 2}, "action": "deny", "scope": {}, "enabled": true
  }'
```

| Tipe | Params | Ditegakkan di |
| --- | --- | --- |
| `cost_cap` | `maxUsd` | gateway |
| `loop_detect` | `maxRepeats`, `signatureWindow` | gateway + SDK |
| `rate_limit` | `maxCalls`, `perMs` | gateway |
| `time_limit` | `maxWallClockMs` | gateway + SDK |
| `step_limit` | `maxSteps` | SDK |
| `tool_permission` | `tools[]`, `sensitivity`, `mode` (`ask`/`deny`/`allow`) | SDK |

Menambah kemampuan baru = menambah satu file di
`packages/policy-engine/src/policies/` + satu entri registry + test. Bukan mengubah arsitektur.

## Prinsip yang dipegang kode ini

- **Fail-safe, bukan fail-open.** Kalau engine/control plane tidak terjangkau, default-nya
  **menolak** — di gateway, di Decision API, dan di kedua SDK. Ubah dengan `CURB_FAIL_MODE=open`.
- **Engine tetap murni.** `evaluate(ctx, policies, state)` sinkron, tanpa I/O, tanpa `Date.now()`
  (waktu di-inject lewat `ctx.now`). Itulah sebabnya logika yang sama bisa jalan di dalam gateway
  maupun di belakang Decision API.
- **Counter atomik.** Cost/step naik lewat `HINCRBYFLOAT`/`HINCRBY`, supaya beberapa instance
  gateway tidak saling menimpa dan cost cap tidak bocor.
- **Tidak ada prompt mentah di log.** Audit event menyimpan ringkasan; argumen tool yang mengandung
  key/token diganti `sha256:…` sebelum masuk antrian approval.
- **Keputusan pertama menang.** Approve/Deny bersifat atomik dan tidak bisa dibalik.

## Alert

Isi salah satu di `.env`, alert terkirim saat breaker nyala atau ada yang menunggu izin
(dengan dedupe supaya run yang nyangkut tidak membanjiri channel):

```
CURB_WEBHOOK_URL=https://contoh.dev/hook
CURB_SLACK_WEBHOOK_URL=https://hooks.slack.com/services/...
```

## Struktur

```
packages/shared         tipe + skema Zod bersama
packages/policy-engine  ★ engine murni + 6 policy + state store (memori & Redis)
packages/sdk-ts         SDK TypeScript (guardrail)
sdks/python             SDK Python (guardrail)
apps/gateway            proxy OpenAI/Anthropic (breaker)
apps/control-plane      API + Postgres + dashboard + approval
examples/               wiring framework
scripts/demo.ts         demo 60 detik
```

## Pengembangan

```bash
pnpm install
pnpm test          # 155 test TS
pnpm typecheck     # build + tsc --noEmit seluruh paket
pnpm demo          # demo end-to-end di satu proses

# SDK Python
cd sdks/python && python -m venv .venv && .venv/bin/pip install -e ".[dev]"
.venv/bin/python -m pytest -q        # 20 test
```

Test integrasi lawan database sungguhan bersifat opt-in — dilewati kalau env-nya kosong:

```bash
docker compose up -d postgres redis
DATABASE_URL=postgresql://curb:curb@localhost:5432/curb pnpm --filter @curb/control-plane test
REDIS_URL=redis://localhost:6379 pnpm --filter @curb/policy-engine test
```

Spesifikasi lengkap ada di [DESIGN.md](DESIGN.md).
