"""Curb Python SDK — enforcement point untuk tool call (guardrail).

Contoh:
    from curb import Curb
    curb = Curb(run_id="run-123")

    @curb.guard_tool(name="delete_file", sensitivity="high")
    def delete_file(path: str) -> None:
        os.remove(path)
"""
from __future__ import annotations

import time
import functools
from typing import Any, Callable, Optional

import httpx


class PolicyViolation(Exception):
    def __init__(self, decision: dict[str, Any]):
        self.decision = decision
        super().__init__(decision.get("reason", "policy violation"))


class Curb:
    def __init__(
        self,
        base_url: str = "http://localhost:8090",
        api_key: str = "",
        run_id: Optional[str] = None,
        poll_s: float = 1.5,
    ) -> None:
        self.base_url = base_url.rstrip("/")
        self.api_key = api_key
        self.run_id = run_id or "run"
        self.poll_s = poll_s
        self._http = httpx.Client(timeout=30)

    def decide(self, ctx: dict[str, Any]) -> dict[str, Any]:
        r = self._http.post(
            f"{self.base_url}/v1/decisions",
            json={"runId": self.run_id, **ctx},
            headers={"x-curb-key": self.api_key},
        )
        r.raise_for_status()
        return r.json()

    def guard_tool(self, name: str, sensitivity: str = "low") -> Callable:
        """Decorator: cek policy sebelum tool dieksekusi."""
        def deco(fn: Callable) -> Callable:
            @functools.wraps(fn)
            def wrapper(*args: Any, **kwargs: Any) -> Any:
                d = self.decide(
                    {
                        "kind": "tool_call",
                        "toolName": name,
                        "sensitivity": sensitivity,
                        "toolArgs": {"args": args, "kwargs": kwargs},
                    }
                )
                effect = d.get("effect")
                if effect == "DENY":
                    raise PolicyViolation(d)
                if effect == "ASK" and d.get("approvalId"):
                    if not self._wait_approval(d["approvalId"]):
                        raise PolicyViolation({**d, "effect": "DENY", "reason": "approval ditolak"})
                return fn(*args, **kwargs)

            return wrapper

        return deco

    def _wait_approval(self, approval_id: str) -> bool:
        # TODO: timeout & mode webhook, jangan polling selamanya.
        while True:
            a = self._http.get(f"{self.base_url}/v1/approvals/{approval_id}").json()
            if a.get("status") == "approved":
                return True
            if a.get("status") == "denied":
                return False
            time.sleep(self.poll_s)
