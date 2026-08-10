# curb-sdk (Python)

SDK guardrail untuk agent Python. Membungkus tool call & menanyakan keputusan ke Curb control-plane sebelum eksekusi (allow / deny / ask-before-acting).

```bash
pip install -e .
```

```python
from curb import Curb, PolicyViolation

curb = Curb(run_id="run-123")

@curb.guard_tool(name="delete_file", sensitivity="high")
def delete_file(path: str) -> None:
    import os; os.remove(path)

try:
    delete_file("/tmp/x")          # kalau policy 'ask' → tahan sampai di-approve
except PolicyViolation as e:
    print("diblokir:", e)
```

Untuk cost/loop breaker (tanpa ubah kode), arahkan `base_url` LLM ke Curb Gateway — lihat README utama.
