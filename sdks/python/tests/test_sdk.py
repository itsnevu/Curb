"""Python SDK tests. The control plane is faked via httpx.MockTransport."""
from __future__ import annotations

import threading
import time

import httpx
import pytest

from curb import ApprovalTimeout, Curb, CurbClient, PolicyViolation, current_run_id


def make_curb(decision, approval_status=None, fail_decide=False, **kwargs):
    """Build a Curb wired to a fake control plane. `seen` records the contexts sent."""
    seen = []

    def handler(request: httpx.Request) -> httpx.Response:
        if "/v1/decisions" in request.url.path:
            if fail_decide:
                raise httpx.ConnectError("connection refused")
            import json

            ctx = json.loads(request.content)
            seen.append(ctx)
            d = decision(ctx) if callable(decision) else decision
            return httpx.Response(200, json=d)
        if "/v1/approvals/" in request.url.path:
            status = approval_status() if callable(approval_status) else (approval_status or "pending")
            return httpx.Response(200, json={"id": "apr_1", "status": status, "decidedBy": "alice"})
        raise AssertionError(f"unexpected url: {request.url}")

    http = httpx.Client(transport=httpx.MockTransport(handler))
    client = CurbClient(base_url="http://cp", api_key="k", http=http)
    return Curb(client=client, **kwargs), seen


# ── run() and run_id propagation ───────────────────────────────────────────
def test_run_creates_and_propagates_run_id():
    curb, seen = make_curb({"effect": "ALLOW"})
    tool = curb.wrap_tool(lambda: "result", name="read")

    with curb.run() as rid:
        assert current_run_id() == rid
        tool()

    assert seen[0]["runId"] == rid
    assert current_run_id() is None  # context restored


def test_run_id_can_be_supplied():
    curb, seen = make_curb({"effect": "ALLOW"})
    with curb.run("run-mine"):
        curb.wrap_tool(lambda: 1, name="t")()
    assert seen[0]["runId"] == "run-mine"


def test_gateway_headers_carry_run_id_and_key():
    # why both: the run id groups calls into one budget, and the gateway rejects calls
    # that carry no key — run id alone would 401.
    curb, _ = make_curb({"effect": "ALLOW"})
    curb.client.api_key = "k"
    with curb.run("run-x"):
        assert curb.gateway_headers() == {"X-Curb-Run-Id": "run-x", "X-Curb-Key": "k"}


def test_gateway_headers_omit_key_when_absent():
    curb, _ = make_curb({"effect": "ALLOW"})
    curb.client.api_key = ""
    with curb.run("run-x"):
        assert curb.gateway_headers() == {"X-Curb-Run-Id": "run-x"}


def test_run_id_restored_even_when_tool_raises():
    curb, _ = make_curb({"effect": "DENY", "reason": "forbidden"})
    with pytest.raises(PolicyViolation):
        with curb.run("run-y"):
            curb.wrap_tool(lambda: 1, name="t")()
    assert current_run_id() is None


# ── wrap_tool / guard_tool ─────────────────────────────────────────────────
def test_allow_runs_tool_with_original_arguments():
    curb, _ = make_curb({"effect": "ALLOW"})
    tool = curb.wrap_tool(lambda a, b=0: a + b, name="add")
    assert tool(2, b=3) == 5


def test_deny_raises_and_tool_never_runs():
    curb, _ = make_curb({"effect": "DENY", "policyId": "tp", "reason": "not allowed"})
    called = []
    tool = curb.wrap_tool(lambda: called.append(1), name="wipe_db")

    with pytest.raises(PolicyViolation) as err:
        tool()

    assert "not allowed" in str(err.value)
    assert err.value.policy_id == "tp"
    assert err.value.tool_name == "wipe_db"
    assert called == []


def test_guard_tool_as_decorator():
    curb, seen = make_curb({"effect": "ALLOW"})

    @curb.guard_tool(name="delete_file", sensitivity="high")
    def delete_file(path):
        return f"removed {path}"

    assert delete_file("/tmp/a") == "removed /tmp/a"
    assert seen[0]["toolName"] == "delete_file"
    assert seen[0]["sensitivity"] == "high"
    assert delete_file.__name__ == "delete_file"  # functools.wraps preserved


def test_tool_name_defaults_to_function_name():
    curb, seen = make_curb({"effect": "ALLOW"})

    def send_email():
        return "sent"

    curb.wrap_tool(send_email)()
    assert seen[0]["toolName"] == "send_email"


def test_tool_arguments_are_sent_for_the_approval_view():
    curb, seen = make_curb({"effect": "ALLOW"})
    curb.wrap_tool(lambda p: p, name="delete_file")("/etc/hosts")
    assert seen[0]["toolArgs"]["args"] == ["/etc/hosts"]


# ── ask-before-acting ──────────────────────────────────────────────────────
def test_waits_then_runs_once_approved():
    state = {"status": "pending"}
    curb, _ = make_curb(
        {"effect": "ASK", "approvalId": "apr_1"},
        approval_status=lambda: state["status"],
        approval_timeout_s=3,
    )
    threading.Timer(0.15, lambda: state.__setitem__("status", "approved")).start()

    tool = curb.wrap_tool(lambda: "deleted", name="delete_file")
    assert tool() == "deleted"


def test_denied_by_human_raises_policy_violation():
    curb, _ = make_curb({"effect": "ASK", "approvalId": "apr_1"}, approval_status="denied")
    called = []
    with pytest.raises(PolicyViolation) as err:
        curb.wrap_tool(lambda: called.append(1), name="delete_file")()
    assert "alice" in str(err.value)
    assert called == []


def test_approval_timeout_fail_closed():
    curb, _ = make_curb(
        {"effect": "ASK", "approvalId": "apr_1"}, approval_status="pending", approval_timeout_s=0.3
    )
    with pytest.raises(ApprovalTimeout):
        curb.wrap_tool(lambda: 1, name="delete_file")()


def test_approval_timeout_fail_open_still_runs():
    curb, _ = make_curb(
        {"effect": "ASK", "approvalId": "apr_1"},
        approval_status="pending",
        approval_timeout_s=0.3,
        fail_mode="open",
    )
    assert curb.wrap_tool(lambda: "ran", name="delete_file")() == "ran"


def test_waiting_for_approval_does_not_flood_the_server():
    """Without a pause, a long-poll that replies instantly turns into a busy-poll."""
    hits = {"n": 0}

    def status():
        hits["n"] += 1
        return "pending"

    curb, _ = make_curb(
        {"effect": "ASK", "approvalId": "apr_1"}, approval_status=status, approval_timeout_s=1.1
    )
    with pytest.raises(ApprovalTimeout):
        curb.wrap_tool(lambda: 1, name="t")()
    assert hits["n"] <= 6  # ~2 requests/second, not thousands


def test_ask_without_approval_id_counts_as_deny():
    curb, _ = make_curb({"effect": "ASK"})
    with pytest.raises(PolicyViolation):
        curb.wrap_tool(lambda: 1, name="t")()


# ── fail mode ──────────────────────────────────────────────────────────────
def test_fail_closed_when_control_plane_is_down():
    curb, _ = make_curb({"effect": "ALLOW"}, fail_decide=True)
    called = []
    with pytest.raises(PolicyViolation) as err:
        curb.wrap_tool(lambda: called.append(1), name="t")()
    assert "unreachable" in str(err.value)
    assert called == []


def test_fail_open_when_control_plane_is_down():
    curb, _ = make_curb({"effect": "ALLOW"}, fail_decide=True, fail_mode="open")
    assert curb.wrap_tool(lambda: "ran", name="t")() == "ran"


# ── step() ─────────────────────────────────────────────────────────────────
def test_step_enforces_step_limit():
    n = {"i": 0}

    def decide(_ctx):
        n["i"] += 1
        return {"effect": "DENY", "reason": "step_limit"} if n["i"] > 2 else {"effect": "ALLOW"}

    curb, _ = make_curb(decide)
    curb.step()
    curb.step()
    with pytest.raises(PolicyViolation, match="step_limit"):
        curb.step()


def test_on_decision_called_for_every_decision():
    effects = []
    curb, _ = make_curb({"effect": "ALLOW"}, on_decision=lambda d, _c: effects.append(d["effect"]))
    curb.step()
    curb.wrap_tool(lambda: 1, name="t")()
    assert effects == ["ALLOW", "ALLOW"]


def test_throttle_waits_briefly_then_continues():
    curb, _ = make_curb({"effect": "THROTTLE", "retryAfterMs": 60})
    mulai = time.monotonic()
    assert curb.wrap_tool(lambda: "ran", name="t")() == "ran"
    assert time.monotonic() - mulai >= 0.05
