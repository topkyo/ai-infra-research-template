"""Pure helpers and TTL utilities."""
from __future__ import annotations

import re
from datetime import date
from typing import Any

import pandas as pd

from config import log


def seconds_until_next_trading_close(
    *,
    _now=None,
    _timedelta=None,
) -> int:
    """TTL so daily klines refresh after the next 15:30 CN market close."""
    from datetime import datetime as dt, timedelta as td

    now_fn = _now or dt.now
    delta = _timedelta or td
    now = now_fn()
    target = now.replace(hour=15, minute=30, second=0, microsecond=0)
    if now >= target:
        target += delta(days=1)
    return int((target - now).total_seconds())


def _empty_bars_ttl(end: str) -> int:
    """Short TTL only when the window can still grow; closed windows are immutable."""
    return 300 if end >= date.today().strftime("%Y%m%d") else 24 * 3600


def _num_or_none(value: Any) -> float | None:
    if value is None or pd.isna(value):
        return None
    if isinstance(value, (int, float)):
        return float(value)
    text = str(value).replace(",", "")
    matches = re.findall(r"-?\d+(?:\.\d+)?", text)
    if len(matches) == 1:
        return float(matches[0])
    log.warning(
        "_num_or_none: expected exactly one number in %r, found %d",
        value,
        len(matches),
    )
    return None


def _ak_col(row: pd.Series, *names: str) -> Any:
    for name in names:
        if name in row and pd.notna(row.get(name)):
            return row.get(name)
    return None


def _market_cap_to_yi(value: float | None) -> float | None:
    if value is None:
        return None
    # AkShare's Eastmoney spot endpoint reports market cap in yuan. Keep this
    # defensive in case an alternate backend already returns 亿元.
    if abs(value) > 1_000_000:
        return value / 1e8
    return value


def _source_summary(field_sources: dict[str, str]) -> str:
    providers = {
        source.split("_", 1)[0]
        for source in field_sources.values()
        if not source.startswith("derived_")
    }
    if not providers:
        return "unknown"
    if providers == {"akshare"}:
        return "akshare_primary"
    if providers == {"tushare"}:
        return "tushare_only"
    if providers == {"baostock"}:
        return "baostock_only"
    if {"akshare", "baostock", "tushare"}.issubset(providers):
        return "akshare+baostock+tushare"
    if "akshare" in providers and "tushare" in providers:
        return "akshare+tushare"
    if "akshare" in providers and "baostock" in providers:
        return "akshare+baostock"
    if "baostock" in providers and "tushare" in providers:
        return "baostock+tushare"
    return "unknown"
