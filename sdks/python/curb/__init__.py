"""Curb SDK — the enforcement point for TOOL CALLS (guardrails).

Example:
    from curb import Curb

    curb = Curb()
    remove = curb.wrap_tool(delete_file, name="delete_file", sensitivity="high")

    with curb.run() as run_id:
        remove("/tmp/x")     # held until a human approves
"""
from __future__ import annotations

import contextvars
import functools
import hashlib
import inspect
import json
import time
import uuid
from contextlib import contextmanager
from typing import Any, Callable, Dict, Iterator, Optional, TypeVar

from .client import CurbClient
from .errors import ApprovalTimeout, PolicyViolation
from .redact import digest_args

__all__ = [
    "Curb",
    "CurbClient",
    "PolicyViolation",
    "ApprovalTimeout",
    "current_run_id",
    "digest_args",
]


def _signature_of(value: Any) -> str:
    """Stable short hash of anything, for the semantic half of loop detection."""
    text = json.dumps(value, default=str, sort_keys=True)
    return hashlib.sha256(text.encode("utf-8")).hexdigest()[:16]

F = TypeVar("F", bound=Callable[..., Any])

# run_id flows automatically to any tool called inside run()
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
        send_raw_tool_args: bool = False,
    ) -> None:
        self.client = client or CurbClient(base_url, api_key)
        self._run_id = run_id
        self.project_id = project_id
        self.env = env
        self.approval_timeout_s = approval_timeout_s
        self.fail_mode = fail_mode
        self.on_decision = on_decision
        # Tool arguments are summarised before they leave this process unless you
        # explicitly opt out. See curb.redact.
        self.send_raw_tool_args = send_raw_tool_args

    # ── run context ────────────────────────────────────────────────────────
    @contextmanager
    def run(self, run_id: Optional[str] = None) -> Iterator[str]:
        """One agent run: a run_id is created, propagated, then restored on exit."""
        rid = run_id or self._run_id or str(uuid.uuid4())
        token = _run_id.set(rid)
        try:
            yield rid
        finally:
            _run_id.reset(token)

    def run_id(self) -> str:
        return current_run_id() or self._run_id or "run-without-context"

    def gateway_headers(self) -> Dict[str, str]:
        """Attach to your LLM client so cost and loops are caught by the gateway.

        The run id ties calls together; the key authenticates them. Without the run id
        every call looks like a fresh run with a fresh budget, and an authenticated
        gateway rejects calls that carry no key.
        """
        headers = {"X-Curb-Run-Id": self.run_id()}
        if self.client.api_key:
            headers["X-Curb-Key"] = self.client.api_key
        return headers

    # ── enforcement ────────────────────────────────────────────────────────
    def step(self, signature: Any = None, **meta: Any) -> None:
        """Report one agent step — enforces step_limit, time_limit and loop_detect.

        Pass `signature=` (the conversation or plan behind this step) to enable the
        semantic half of loop detection; without it only repeating TOOL cycles are
        visible, so an agent spinning on the same prompt looks healthy.
        """
        ctx: Dict[str, Any] = {"kind": "step", "runId": self.run_id(), "meta": meta or {}}
        if signature is not None:
            ctx["signature"] = _signature_of(signature)
        self._enforce(ctx)

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
        """Wrap a tool: the policy engine is consulted BEFORE the tool executes.

        Async tools are wrapped as async, so `await remove(path)` keeps working and the
        approval wait does not block the event loop's thread any more than the tool would.
        """
        tool_name = name or getattr(fn, "__name__", "tool")

        def gate(args: Any, kwargs: Any) -> None:
            raw = {"args": list(args), "kwargs": kwargs}
            self._enforce(
                {
                    "kind": "tool_call",
                    "runId": self.run_id(),
                    "toolName": tool_name,
                    "sensitivity": sensitivity,
                    # Redacted here, not on the server: a secret that never leaves this
                    # process cannot leak from the control plane.
                    "toolArgs": raw if self.send_raw_tool_args else digest_args(raw),
                },
                tool_name=tool_name,
                approval_timeout_s=approval_timeout_s,
            )

        if inspect.iscoroutinefunction(fn):

            @functools.wraps(fn)
            async def async_wrapper(*args: Any, **kwargs: Any) -> Any:
                gate(args, kwargs)
                return await fn(*args, **kwargs)

            return async_wrapper

        @functools.wraps(fn)
        def wrapper(*args: Any, **kwargs: Any) -> Any:
            gate(args, kwargs)
            return fn(*args, **kwargs)

        return wrapper

    def guard_tool(
        self,
        name: Optional[str] = None,
        sensitivity: str = "low",
        approval_timeout_s: Optional[float] = None,
    ) -> Callable[[F], F]:
        """Decorator form of wrap_tool.

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
        except Exception as err:  # noqa: BLE001 — every transport failure is treated the same
            # An unreachable control plane means we cannot know whether this action is
            # safe. Fail closed by default: halting beats acting blind.
            if self.fail_mode == "open":
                return {"effect": "ALLOW", "reason": f"curb unreachable (fail-open): {err}"}
            return {
                "effect": "DENY",
                "policyId": "curb_unreachable",
                "reason": f"curb unreachable (fail-closed): {err}",
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
                {**decision, "effect": "DENY", "reason": "ASK without approvalId — inconsistent control plane"},
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
            except Exception:  # noqa: BLE001 — long-poll dropped; retry while time remains
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
                        "reason": f"approval denied{f' by {by}' if by else ''}",
                    },
                    tool_name,
                )
            # why: if the server replies instantly (no ?wait support), without this pause
            # the loop becomes a busy-poll that hammers the control plane.
            if (time.monotonic() - started) * 1000 < slice_ms:
                time.sleep(min(0.5, max(0.0, deadline - time.monotonic())))

        if self.fail_mode == "open":
            return
        raise ApprovalTimeout(approval_id, int(budget * 1000), tool_name)
