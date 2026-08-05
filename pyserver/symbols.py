"""Symbol normalization helpers."""
from __future__ import annotations

from typing import Any


def _to_ts_code(symbol: str) -> tuple[str, str]:
    """Convert internal symbol -> (ts_code, market). market in {sh, sz, bj, hk}."""
    s = symbol.lower().strip()
    if "." in s:
        code, suffix = s.split(".", 1)
        mkt = suffix[:2]
        if mkt in {"sh", "sz", "bj"}:
            return code + {"sh": ".SH", "sz": ".SZ", "bj": ".BJ"}[mkt], mkt
        if mkt == "hk":
            return code.zfill(5) + ".HK", "hk"
    if s.startswith(("sh", "sz", "bj")):
        code, mkt = s[2:], s[:2]
    elif s.startswith("hk"):
        code, mkt = s[2:].zfill(5), "hk"
    elif s.startswith(("60", "68", "9")):
        code, mkt = s, "sh"
    elif s.startswith(("00", "30", "20")):
        code, mkt = s, "sz"
    elif s.startswith(("8", "4")):
        code, mkt = s, "bj"
    else:
        code, mkt = s.zfill(5), "hk"
    suffix = {"sh": ".SH", "sz": ".SZ", "bj": ".BJ", "hk": ".HK"}[mkt]
    return code + suffix, mkt


def _cache_ts_code(symbol: str) -> str:
    """Canonical ts_code for symbol-scoped cache keys."""
    ts_code, _ = _to_ts_code(symbol)
    return ts_code


def _echo_request_symbol(cached: Any, symbol: str) -> Any:
    """On cache hit, return payload with symbol matching the current request."""
    if isinstance(cached, dict) and "symbol" in cached:
        return {**cached, "symbol": symbol}
    return cached


def _compact_code(ts_code: str) -> str:
    return ts_code.split(".")[0]


def _infer_market_prefix(code: str) -> str:
    if code.startswith(("60", "68", "9")):
        return "sh"
    if code.startswith(("8", "4")):
        return "bj"
    return "sz"


def _eastmoney_market_code(market: str) -> int:
    # Eastmoney uses 1 for Shanghai and 0 for Shenzhen/Beijing in these quote
    # endpoints.
    return 1 if market == "sh" else 0
