# curb-sdk (Python)

Enforcement point untuk **tool call** — hal yang tidak bisa dilakukan proxy.

```bash
pip install -e ".[dev]"
```

```python
from curb import Curb, PolicyViolation

curb = Curb(base_url="http://localhost:8090", api_key="dev-key")

@curb.guard_tool(name="delete_file", sensitivity="high")
def delete_file(path: str) -> None:
    os.remove(path)

with curb.run() as run_id:
    # cost & loop juga terjaga kalau klien LLM diarahkan ke gateway:
    #   OpenAI(base_url="http://localhost:8080/v1", default_headers=curb.gateway_headers())
    curb.step()                 # menegakkan step_limit / time_limit
    try:
        delete_file("/tmp/x")   # ASK → ditahan sampai manusia klik Approve
    except PolicyViolation as e:
        print("ditolak:", e, e.policy_id)
```

## Perilaku penting

| Keputusan | Yang terjadi |
| --- | --- |
| `ALLOW` | tool jalan |
| `DENY` | `PolicyViolation`, tool **tidak pernah** dipanggil |
| `ASK` | eksekusi ditahan sampai ada keputusan manusia (long-poll) |
| `THROTTLE` | menunggu `retryAfterMs`, lalu jalan |

- **Fail-safe.** Kalau control plane tak terjangkau atau approval kehabisan waktu,
  default-nya menolak (`fail_mode="closed"`). Setel `fail_mode="open"` kalau
  ketersediaan lebih penting daripada penjagaan.
- `run_id` mengalir otomatis lewat `contextvars`, jadi tool bersarang tidak
  perlu dioper run id.

## Test

```bash
python -m venv .venv && .venv/bin/pip install -e ".[dev]"
.venv/bin/python -m pytest -q
```
