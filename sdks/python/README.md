# curb-sdk (Python)

The enforcement point for **tool calls** — the thing a proxy fundamentally cannot do.

```bash
pip install curb-sdk
```

> You need a running Curb control plane for this to do anything. The fastest way:
> `docker compose -f docker-compose.release.yml up -d` — see the
> [quickstart](https://github.com/itsnevu/Curb#quickstart-60-seconds).

```python
from curb import Curb, PolicyViolation

curb = Curb(base_url="http://localhost:8090", api_key="dev-key")

@curb.guard_tool(name="delete_file", sensitivity="high")
def delete_file(path: str) -> None:
    os.remove(path)

with curb.run() as run_id:
    # Cost and loops are covered too if your LLM client points at the gateway:
    #   OpenAI(base_url="http://localhost:8080/v1", default_headers=curb.gateway_headers())
    curb.step()                 # enforces step_limit / time_limit
    try:
        delete_file("/tmp/x")   # ASK → held until a human clicks Approve
    except PolicyViolation as e:
        print("denied:", e, e.policy_id)
```

## Behaviour that matters

| Decision | What happens |
| --- | --- |
| `ALLOW` | the tool runs |
| `DENY` | `PolicyViolation` is raised; the tool is **never** called |
| `ASK` | execution is held until a human decides (long-poll) |
| `THROTTLE` | waits `retryAfterMs`, then runs |

- **Fail-safe.** If the control plane is unreachable, or an approval runs out of time, the
  default is to deny (`fail_mode="closed"`). Set `fail_mode="open"` when availability matters
  more than protection.
- `run_id` propagates automatically through `contextvars`, so nested tools never need it
  passed explicitly.

## Tests

```bash
python -m venv .venv && .venv/bin/pip install -e ".[dev]"
.venv/bin/python -m pytest -q
```
