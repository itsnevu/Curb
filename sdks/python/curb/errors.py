"""Kesalahan yang dilempar Curb SDK."""
from __future__ import annotations

from typing import Any, Dict, Optional


class PolicyViolation(Exception):
    """Dilempar saat policy menolak sebuah aksi."""

    def __init__(self, decision: Dict[str, Any], tool_name: Optional[str] = None) -> None:
        self.decision = decision
        self.policy_id = decision.get("policyId")
        self.tool_name = tool_name
        super().__init__(decision.get("reason") or "aksi ditolak oleh policy Curb")


class ApprovalTimeout(PolicyViolation):
    """Approval tidak diputuskan sampai batas waktu."""

    def __init__(self, approval_id: str, waited_ms: int, tool_name: Optional[str] = None) -> None:
        super().__init__(
            {
                "effect": "DENY",
                "policyId": "curb_approval_timeout",
                "reason": f"approval {approval_id} tidak diputuskan dalam {waited_ms}ms",
            },
            tool_name,
        )
