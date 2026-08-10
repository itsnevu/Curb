"""Test SDK Python. Control plane dipalsukan lewat httpx.MockTransport."""
from __future__ import annotations

import threading
import time

import httpx
import pytest

from curb import ApprovalTimeout, Curb, CurbClient, PolicyViolation, current_run_id


def make_curb(decision, approval_status=None, fail_decide=False, **kwargs):
    """Bikin Curb yang berbicara dengan control plane palsu. `seen` merekam konteks terkirim."""
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
            return httpx.Response(200, json={"id": "apr_1", "status": status, "decidedBy": "budi"})
        raise AssertionError(f"url tak terduga: {request.url}")

    http = httpx.Client(transport=httpx.MockTransport(handler))
    client = CurbClient(base_url="http://cp", api_key="k", http=http)
    return Curb(client=client, **kwargs), seen


# ── run() & propagasi run_id ───────────────────────────────────────────────
def test_run_membuat_dan_menyebarkan_run_id():
    curb, seen = make_curb({"effect": "ALLOW"})
    tool = curb.wrap_tool(lambda: "hasil", name="baca")

    with curb.run() as rid:
        assert current_run_id() == rid
        tool()

    assert seen[0]["runId"] == rid
    assert current_run_id() is None  # konteks dipulihkan


def test_run_id_bisa_ditentukan_sendiri():
    curb, seen = make_curb({"effect": "ALLOW"})
    with curb.run("run-saya"):
        curb.wrap_tool(lambda: 1, name="t")()
    assert seen[0]["runId"] == "run-saya"


def test_gateway_headers_membawa_run_id():
    curb, _ = make_curb({"effect": "ALLOW"})
    with curb.run("run-x"):
        assert curb.gateway_headers() == {"X-Curb-Run-Id": "run-x"}


def test_run_id_dipulihkan_walau_tool_melempar():
    curb, _ = make_curb({"effect": "DENY", "reason": "tidak boleh"})
    with pytest.raises(PolicyViolation):
        with curb.run("run-y"):
            curb.wrap_tool(lambda: 1, name="t")()
    assert current_run_id() is None


# ── wrap_tool / guard_tool ─────────────────────────────────────────────────
def test_allow_menjalankan_tool_dengan_argumen_asli():
    curb, _ = make_curb({"effect": "ALLOW"})
    tool = curb.wrap_tool(lambda a, b=0: a + b, name="tambah")
    assert tool(2, b=3) == 5


def test_deny_melempar_dan_tool_tidak_dijalankan():
    curb, _ = make_curb({"effect": "DENY", "policyId": "tp", "reason": "dilarang"})
    dipanggil = []
    tool = curb.wrap_tool(lambda: dipanggil.append(1), name="wipe_db")

    with pytest.raises(PolicyViolation) as err:
        tool()

    assert "dilarang" in str(err.value)
    assert err.value.policy_id == "tp"
    assert err.value.tool_name == "wipe_db"
    assert dipanggil == []


def test_guard_tool_sebagai_dekorator():
    curb, seen = make_curb({"effect": "ALLOW"})

    @curb.guard_tool(name="delete_file", sensitivity="high")
    def delete_file(path):
        return f"hapus {path}"

    assert delete_file("/tmp/a") == "hapus /tmp/a"
    assert seen[0]["toolName"] == "delete_file"
    assert seen[0]["sensitivity"] == "high"
    assert delete_file.__name__ == "delete_file"  # functools.wraps terjaga


def test_nama_tool_default_dari_nama_fungsi():
    curb, seen = make_curb({"effect": "ALLOW"})

    def kirim_email():
        return "terkirim"

    curb.wrap_tool(kirim_email)()
    assert seen[0]["toolName"] == "kirim_email"


def test_argumen_tool_ikut_dikirim_untuk_ditampilkan_saat_approval():
    curb, seen = make_curb({"effect": "ALLOW"})
    curb.wrap_tool(lambda p: p, name="delete_file")("/etc/hosts")
    assert seen[0]["toolArgs"]["args"] == ["/etc/hosts"]


# ── ask-before-acting ──────────────────────────────────────────────────────
def test_menunggu_lalu_jalan_setelah_disetujui():
    state = {"status": "pending"}
    curb, _ = make_curb(
        {"effect": "ASK", "approvalId": "apr_1"},
        approval_status=lambda: state["status"],
        approval_timeout_s=3,
    )
    threading.Timer(0.15, lambda: state.__setitem__("status", "approved")).start()

    tool = curb.wrap_tool(lambda: "terhapus", name="delete_file")
    assert tool() == "terhapus"


def test_ditolak_manusia_melempar_policy_violation():
    curb, _ = make_curb({"effect": "ASK", "approvalId": "apr_1"}, approval_status="denied")
    dipanggil = []
    with pytest.raises(PolicyViolation) as err:
        curb.wrap_tool(lambda: dipanggil.append(1), name="delete_file")()
    assert "budi" in str(err.value)
    assert dipanggil == []


def test_timeout_approval_fail_closed():
    curb, _ = make_curb(
        {"effect": "ASK", "approvalId": "apr_1"}, approval_status="pending", approval_timeout_s=0.3
    )
    with pytest.raises(ApprovalTimeout):
        curb.wrap_tool(lambda: 1, name="delete_file")()


def test_timeout_approval_fail_open_tetap_jalan():
    curb, _ = make_curb(
        {"effect": "ASK", "approvalId": "apr_1"},
        approval_status="pending",
        approval_timeout_s=0.3,
        fail_mode="open",
    )
    assert curb.wrap_tool(lambda: "jalan", name="delete_file")() == "jalan"


def test_menunggu_approval_tidak_membanjiri_server():
    """Tanpa jeda, long-poll yang balas instan berubah jadi busy-poll."""
    hits = {"n": 0}

    def status():
        hits["n"] += 1
        return "pending"

    curb, _ = make_curb(
        {"effect": "ASK", "approvalId": "apr_1"}, approval_status=status, approval_timeout_s=1.1
    )
    with pytest.raises(ApprovalTimeout):
        curb.wrap_tool(lambda: 1, name="t")()
    assert hits["n"] <= 6  # ~2 permintaan/detik, bukan ribuan


def test_ask_tanpa_approval_id_dianggap_deny():
    curb, _ = make_curb({"effect": "ASK"})
    with pytest.raises(PolicyViolation):
        curb.wrap_tool(lambda: 1, name="t")()


# ── fail mode ──────────────────────────────────────────────────────────────
def test_fail_closed_saat_control_plane_mati():
    curb, _ = make_curb({"effect": "ALLOW"}, fail_decide=True)
    dipanggil = []
    with pytest.raises(PolicyViolation) as err:
        curb.wrap_tool(lambda: dipanggil.append(1), name="t")()
    assert "unreachable" in str(err.value)
    assert dipanggil == []


def test_fail_open_saat_control_plane_mati():
    curb, _ = make_curb({"effect": "ALLOW"}, fail_decide=True, fail_mode="open")
    assert curb.wrap_tool(lambda: "jalan", name="t")() == "jalan"


# ── step() ─────────────────────────────────────────────────────────────────
def test_step_menegakkan_step_limit():
    n = {"i": 0}

    def decide(_ctx):
        n["i"] += 1
        return {"effect": "DENY", "reason": "step_limit"} if n["i"] > 2 else {"effect": "ALLOW"}

    curb, _ = make_curb(decide)
    curb.step()
    curb.step()
    with pytest.raises(PolicyViolation, match="step_limit"):
        curb.step()


def test_on_decision_dipanggil_tiap_keputusan():
    efek = []
    curb, _ = make_curb({"effect": "ALLOW"}, on_decision=lambda d, _c: efek.append(d["effect"]))
    curb.step()
    curb.wrap_tool(lambda: 1, name="t")()
    assert efek == ["ALLOW", "ALLOW"]


def test_throttle_menahan_sebentar_lalu_lanjut():
    curb, _ = make_curb({"effect": "THROTTLE", "retryAfterMs": 60})
    mulai = time.monotonic()
    assert curb.wrap_tool(lambda: "jalan", name="t")() == "jalan"
    assert time.monotonic() - mulai >= 0.05
