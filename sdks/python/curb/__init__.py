"""Curb SDK — enforcement point untuk TOOL CALL (guardrail).

Contoh:
    from curb import Curb

    curb = Curb()
    hapus = curb.wrap_tool(delete_file, name="delete_file", sensitivity="high")

    with curb.run() as run_id:
        hapus("/tmp/x")     # ditahan sampai manusia menyetujui
"""
from __future__ import annotations

import contextvars
import functools
import time
import uuid
from contextlib import contextmanager
from typing import Any, Callable, Dict, Iterator, Optional, TypeVar

from .client import CurbClient
from .errors import ApprovalTimeout, PolicyViolation

__all__ = ["Curb", "CurbClient", "PolicyViolation", "ApprovalTimeout", "current_run_id"]

F = TypeVar("F", bound=Callable[..., Any])

# run_id mengalir otomatis ke tool yang dipanggil di dalam run()
_run_id: contextvars.ContextVar[Optional[str]] = contextvars.ContextVar("curb_run_id", default=None)


def current_run_id() -> Optional[str]:
    return _run_id.get()


class Curb:
    def __init__(
        self,
        base_url: Optional[str] = None,
        api_key: Optional[str] = None,
        run_id: Optional[str] = None,
        project_id: Optional[str] = None,
        env: Optional[str] = None,
        approval_timeout_s: float = 300.0,
        fail_mode: str = "closed",
        client: Optional[CurbClient] = None,
        on_decision: Optional[Callable[[Dict[str, Any], Dict[str, Any]], None]] = None,
    ) -> None:
        self.client = client or CurbClient(base_url, api_key)
        self._run_id = run_id
        self.project_id = project_id
        self.env = env
        self.approval_timeout_s = approval_timeout_s
        self.fail_mode = fail_mode
        self.on_decision = on_decision

    # ── konteks run ────────────────────────────────────────────────────────
    @contextmanager
    def run(self, run_id: Optional[str] = None) -> Iterator[str]:
        """Satu run agent: run_id dibuat, disebar, lalu dikembalikan seperti semula."""
        rid = run_id or self._run_id or str(uuid.uuid4())
        token = _run_id.set(rid)
        try:
            yield rid
        finally:
            _run_id.reset(token)

    def run_id(self) -> str:
        return current_run_id() or self._run_id or "run-tanpa-konteks"

    def gateway_headers(self) -> Dict[str, str]:
        """Tempelkan ke klien LLM supaya cost/loop ikut terjaring gateway."""
        return {"X-Curb-Run-Id": self.run_id()}

    # ── penegakan ──────────────────────────────────────────────────────────
    def step(self, **meta: Any) -> None:
        """Laporkan satu langkah agent — menegakkan step_limit / time_limit."""
        self._enforce({"kind": "step", "runId": self.run_id(), "meta": meta or {}})

    def decide(self, **ctx: Any) -> Dict[str, Any]:
        payload = {"runId": self.run_id()}
        payload.update(ctx)
        return self._ask(payload)

    def wrap_tool(
        self,
        fn: Callable[..., Any],
        name: Optional[str] = None,
        sensitivity: str = "low",
        approval_timeout_s: Optional[float] = None,
    ) -> Callable[..., Any]:
        """Bungkus tool: policy ditanya SEBELUM tool dieksekusi."""
        tool_name = name or getattr(fn, "__name__", "tool")

        @functools.wraps(fn)
        def wrapper(*args: Any, **kwargs: Any) -> Any:
            self._enforce(
                {
                    "kind": "tool_call",
                    "runId": self.run_id(),
                    "toolName": tool_name,
                    "sensitivity": sensitivity,
                    "toolArgs": {"args": list(args), "kwargs": kwargs},
                },
                tool_name=tool_name,
                approval_timeout_s=approval_timeout_s,
            )
            return fn(*args, **kwargs)

        return wrapper

    def guard_tool(
        self,
        name: Optional[str] = None,
        sensitivity: str = "low",
        approval_timeout_s: Optional[float] = None,
    ) -> Callable[[F], F]:
        """Bentuk dekorator dari wrap_tool.

            @curb.guard_tool(name="delete_file", sensitivity="high")
            def delete_file(path): ...
        """

        def deco(fn: F) -> F:
            return self.wrap_tool(fn, name=name, sensitivity=sensitivity, approval_timeout_s=approval_timeout_s)  # type: ignore[return-value]

        return deco

    # ── internal ───────────────────────────────────────────────────────────
    def _ask(self, ctx: Dict[str, Any]) -> Dict[str, Any]:
        full = {"projectId": self.project_id, "env": self.env}
        full.update({k: v for k, v in ctx.items() if v is not None})
        full = {k: v for k, v in full.items() if v is not None}
        try:
            decision = self.client.decide(full)
        except Exception as err:  # noqa: BLE001 — semua kegagalan transport diperlakukan sama
            # Control plane tak terjangkau = kita tidak tahu apakah aksi ini aman.
            # Default fail-closed: lebih baik agent berhenti daripada bertindak buta.
            if self.fail_mode == "open":
                return {"effect": "ALLOW", "reason": f"curb tidak terjangkau (fail-open): {err}"}
            return {
                "effect": "DENY",
                "policyId": "curb_unreachable",
                "reason": f"curb tidak terjangkau (fail-closed): {err}",
            }
        if self.on_decision:
            self.on_decision(decision, full)
        return decision

    def _enforce(
        self,
        ctx: Dict[str, Any],
        tool_name: Optional[str] = None,
        approval_timeout_s: Optional[float] = None,
    ) -> None:
        decision = self._ask(ctx)
        effect = decision.get("effect")

        if effect == "DENY":
            raise PolicyViolation(decision, tool_name)
        if effect == "THROTTLE" and decision.get("retryAfterMs"):
            time.sleep(decision["retryAfterMs"] / 1000)
        if effect != "ASK":
            return

        approval_id = decision.get("approvalId")
        if not approval_id:
            raise PolicyViolation(
                {**decision, "effect": "DENY", "reason": "ASK tanpa approvalId — control plane tidak konsisten"},
                tool_name,
            )
        self._await_approval(approval_id, tool_name, approval_timeout_s)

    def _await_approval(
        self,
        approval_id: str,
        tool_name: Optional[str],
        approval_timeout_s: Optional[float],
    ) -> None:
        budget = approval_timeout_s if approval_timeout_s is not None else self.approval_timeout_s
        deadline = time.monotonic() + budget

        while time.monotonic() < deadline:
            remaining = deadline - time.monotonic()
            slice_ms = int(min(30.0, remaining) * 1000)
            started = time.monotonic()
            try:
                view = self.client.wait_approval(approval_id, slice_ms)
            except Exception:  # noqa: BLE001 — long-poll putus; coba lagi selama masih ada waktu
                time.sleep(min(1.0, max(0.0, deadline - time.monotonic())))
                continue

            status = view.get("status")
            if status == "approved":
                return
            if status in ("denied", "expired"):
                by = view.get("decidedBy")
                raise PolicyViolation(
                    {
                        "effect": "DENY",
                        "policyId": "curb_approval_denied",
                        "reason": f"approval ditolak{f' oleh {by}' if by else ''}",
                    },
                    tool_name,
                )
            # why: kalau server balas cepat (tidak mendukung ?wait), tanpa jeda ini
            # loop berubah jadi busy-poll yang menghantam control plane.
            if (time.monotonic() - started) * 1000 < slice_ms:
                time.sleep(min(0.5, max(0.0, deadline - time.monotonic())))

        if self.fail_mode == "open":
            return
        raise ApprovalTimeout(approval_id, int(budget * 1000), tool_name)
