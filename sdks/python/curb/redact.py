"""Summarise tool arguments before they leave this process.

A human approving `delete_file` needs to know WHICH file — not the access token that
happened to sit next to it in the same kwargs. Long values are truncated and keys that
look secret are replaced by a short hash, so the approval queue stays useful without the
control plane ever storing a credential.

Mirrors packages/shared/src/redact.ts; the two must stay in step.
"""
from __future__ import annotations

import hashlib
import json
import re
from typing import Any, Dict

SECRET_KEYS = re.compile(r"pass|secret|token|key|auth|credential|cookie|session", re.I)
MAX_STRING = 120
MAX_DEPTH = 4
MAX_ITEMS = 10
MAX_KEYS = 25


def digest_args(args: Any, depth: int = 0) -> Dict[str, Any]:
    value = _redact(args, depth)
    return value if isinstance(value, dict) else {"value": value}


def fingerprint(value: Any) -> str:
    """Enough to compare two values without revealing either of them."""
    text = value if isinstance(value, str) else json.dumps(value, default=str, sort_keys=True)
    return "sha256:" + hashlib.sha256(text.encode("utf-8")).hexdigest()[:12]


def _redact(value: Any, depth: int) -> Any:
    if depth > MAX_DEPTH:
        return "[too deep]"
    if value is None or isinstance(value, (int, float, bool)):
        return value
    if isinstance(value, str):
        return _truncate(value)
    if isinstance(value, (list, tuple)):
        head = [_redact(v, depth + 1) for v in list(value)[:MAX_ITEMS]]
        extra = len(value) - MAX_ITEMS
        return head + [f"…+{extra} more"] if extra > 0 else head
    if isinstance(value, dict):
        out: Dict[str, Any] = {}
        for k, v in list(value.items())[:MAX_KEYS]:
            key = str(k)
            out[key] = fingerprint(v) if SECRET_KEYS.search(key) else _redact(v, depth + 1)
        return out
    return _truncate(str(value))


def _truncate(s: str) -> str:
    return s if len(s) <= MAX_STRING else f"{s[:MAX_STRING]}… ({len(s)} char)"
