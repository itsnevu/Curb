"""Pembungkus tipis Decision & Approval API. Tidak menyimpan state."""
from __future__ import annotations

import os
from typing import Any, Dict, Optional

import httpx


class CurbClient:
    def __init__(
        self,
        base_url: Optional[str] = None,
        api_key: Optional[str] = None,
        request_timeout_s: float = 10.0,
        http: Optional[httpx.Client] = None,
    ) -> None:
        self.base_url = (base_url or os.environ.get("CURB_URL") or "http://localhost:8090").rstrip("/")
        self.api_key = api_key or os.environ.get("CURB_API_KEY", "")
        self.request_timeout_s = request_timeout_s
        self._http = http or httpx.Client(timeout=request_timeout_s)

    @property
    def _headers(self) -> Dict[str, str]:
        return {"content-type": "application/json", "x-curb-key": self.api_key}

    def decide(self, ctx: Dict[str, Any]) -> Dict[str, Any]:
        r = self._http.post(
            f"{self.base_url}/v1/decisions",
            json=ctx,
            headers=self._headers,
            timeout=self.request_timeout_s,
        )
        r.raise_for_status()
        return r.json()

    def wait_approval(self, approval_id: str, wait_ms: int) -> Dict[str, Any]:
        """Long-poll: server menggantung koneksi sampai ada keputusan atau wait_ms habis."""
        r = self._http.get(
            f"{self.base_url}/v1/approvals/{approval_id}",
            params={"wait": wait_ms},
            headers=self._headers,
            # timeout HTTP dibuat lebih longgar dari wait_ms supaya bukan kita yang memutus duluan
            timeout=wait_ms / 1000 + 5,
        )
        r.raise_for_status()
        return r.json()

    def get_approval(self, approval_id: str) -> Dict[str, Any]:
        r = self._http.get(
            f"{self.base_url}/v1/approvals/{approval_id}",
            headers=self._headers,
            timeout=self.request_timeout_s,
        )
        r.raise_for_status()
        return r.json()

    def close(self) -> None:
        self._http.close()
