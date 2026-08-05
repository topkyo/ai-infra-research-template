"""AkShare / Sina A-share spot quote helpers."""
from __future__ import annotations

import re
from datetime import date, timedelta
from typing import Any

import pandas as pd

from cache import cache_get, cache_put
from config import NEGATIVE_CACHE, _QUOTE_SOURCE_KEY, log
from http_util import _market_http_get
from providers.akshare_hist import _ak_a_hist_df
from providers.tushare_api import _pro
from symbols import _compact_code, _eastmoney_market_code, _infer_market_prefix
from util import _ak_col, _num_or_none

# Cache the stock_basic / hk_basic name lookups once per process startup.
_NAME_CACHE: dict[str, str] = {}


def _ak_a_spot_from_hist(ts_code: str, market: str, symbol: str) -> dict[str, Any] | None:
    """Last daily bar as a spot quote when Eastmoney realtime is unreachable."""
    if market not in {"sh", "sz", "bj"}:
        return None
    code = _compact_code(ts_code)
    end = date.today().strftime("%Y%m%d")
    start = (date.today() - timedelta(days=15)).strftime("%Y%m%d")
    df = _ak_a_hist_df(code, start, end, "qfq")
    if df is None:
        return None
    row = df.iloc[-1]
    price = _num_or_none(_ak_col(row, "收盘", "close"))
    if price is None:
        return None
    return {
        "symbol": symbol,
        "name": str(row.get("名称") or ""),
        "price": price,
        "change_pct": _num_or_none(_ak_col(row, "涨跌幅", "pct_chg")),
        "volume": _num_or_none(_ak_col(row, "成交量", "volume")),
        "turnover": _num_or_none(_ak_col(row, "成交额", "amount")),
    }


def _ak_a_spot_rows(ts_code: str, market: str) -> dict[str, Any] | None:
    """Fetch/cached A-share spot quote with a hard timeout.

    AkShare's whole-market spot helpers paginate thousands of rows and can take
    tens of seconds. This mirrors the single-symbol Eastmoney endpoint used by
    AkShare so a slow upstream can fall back to Tushare quickly.
    """
    code = _compact_code(ts_code)
    key = f"ak:a:spot:em:{code}"
    cached = cache_get(key)
    if cached is not None:
        if isinstance(cached, dict) and cached.get("__negative_cache__"):
            return None
        return cached
    url = "https://push2.eastmoney.com/api/qt/stock/get"
    params = {
        "fltt": "2",
        "invt": "2",
        "fields": "f43,f57,f58,f116,f117,f162,f167,f168,f47,f48,f170",
        "secid": f"{_eastmoney_market_code(market)}.{code}",
    }
    try:
        response = _market_http_get(url, params=params, timeout=3)
        response.raise_for_status()
        data = response.json().get("data")
    except Exception as e:
        log.warning("provider %s failed: %s", "akshare_a_spot_em", e)
        cache_put(key, NEGATIVE_CACHE, 10)
        return None
    if not data:
        cache_put(key, NEGATIVE_CACHE, 10)
        return None
    row = {
        "代码": data.get("f57") or code,
        "名称": data.get("f58"),
        "最新价": data.get("f43"),
        "涨跌幅": data.get("f170"),
        "成交量": data.get("f47"),
        "成交额": data.get("f48"),
        "总市值": data.get("f116"),
        "流通市值": data.get("f117"),
        "市盈率-动态": data.get("f162"),
        "市净率": data.get("f167"),
        "换手率": data.get("f168"),
        _QUOTE_SOURCE_KEY: "akshare_eastmoney",
    }
    cache_put(key, row, 30)
    return row


def _sina_hq_list_id(market: str, code: str) -> str:
    return f"{_infer_market_prefix(code)}{code}"


def parse_sina_hq_text(text: str, code: str) -> dict[str, Any] | None:
    """Parse hq.sinajs.cn response: var hq_str_sh600000=\"name,open,prev,price,...\";"""
    match = re.search(r'="([^"]*)"', text)
    if not match:
        return None
    body = match.group(1).strip()
    if not body:
        return None
    parts = body.split(",")
    if len(parts) < 4:
        return None
    prev_close = _num_or_none(parts[2])
    price = _num_or_none(parts[3])
    if price is None:
        return None
    change_pct = None
    if prev_close and prev_close > 0:
        change_pct = (price - prev_close) / prev_close * 100
    volume = _num_or_none(parts[8]) if len(parts) > 8 else None
    turnover = _num_or_none(parts[9]) if len(parts) > 9 else None
    return {
        "代码": code,
        "名称": parts[0] or None,
        "最新价": price,
        "涨跌幅": change_pct,
        "成交量": volume,
        "成交额": turnover,
    }


def _sina_a_spot_rows(ts_code: str, market: str) -> dict[str, Any] | None:
    """Single-symbol realtime quote via Sina hq.sinajs.cn when Eastmoney push2 fails."""
    if market not in {"sh", "sz", "bj"}:
        return None
    code = _compact_code(ts_code)
    key = f"ak:a:spot:sina:{code}"
    cached = cache_get(key)
    if cached is not None:
        if isinstance(cached, dict) and cached.get("__negative_cache__"):
            return None
        return cached
    list_id = _sina_hq_list_id(market, code)
    url = f"https://hq.sinajs.cn/list={list_id}"
    headers = {
        "Referer": "https://finance.sina.com.cn/",
        "User-Agent": (
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
            "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
        ),
    }
    try:
        response = _market_http_get(url, headers=headers, timeout=5)
        response.raise_for_status()
        response.encoding = "gbk"
        row = parse_sina_hq_text(response.text, code)
    except Exception as e:
        log.warning("provider %s failed: %s", "sina_hq_sinajs", e)
        cache_put(key, NEGATIVE_CACHE, 10)
        return None
    if row is None:
        cache_put(key, NEGATIVE_CACHE, 10)
        return None
    row[_QUOTE_SOURCE_KEY] = "sina_hq_sinajs"
    cache_put(key, row, 30)
    return row


def _ak_a_spot(ts_code: str, market: str) -> dict[str, Any] | None:
    if market not in {"sh", "sz", "bj"}:
        return None
    try:
        row = _ak_a_spot_rows(ts_code, market)
        if row is not None:
            return row
        return _sina_a_spot_rows(ts_code, market)
    except Exception as e:
        log.warning("provider %s failed: %s", "akshare_a_spot", e)
        return None


def _spot_api_source_from_row(row: dict[str, Any]) -> str:
    if row.get(_QUOTE_SOURCE_KEY) == "sina_hq_sinajs":
        return "sina-hq-realtime"
    return "eastmoney"


def _spot_missing_field_warnings(
    *,
    change_pct: float | None = None,
    volume: float | None = None,
    turnover: float | None = None,
) -> list[str]:
    warnings: list[str] = []
    if change_pct is None:
        warnings.append("change_pct unavailable from upstream")
    if volume is None:
        warnings.append("volume unavailable from upstream")
    if turnover is None:
        warnings.append("turnover unavailable from upstream")
    return warnings


def _spot_warnings_from_row(row: dict[str, Any]) -> list[str]:
    return _spot_missing_field_warnings(
        change_pct=_spot_change_pct_from_ak(row),
        volume=_num_or_none(row.get("成交量")),
        turnover=_num_or_none(row.get("成交额")),
    )


def _spot_price_from_ak(row: dict[str, Any]) -> float | None:
    return _num_or_none(row.get("最新价"))


def _spot_change_pct_from_ak(row: dict[str, Any]) -> float | None:
    return _num_or_none(row.get("涨跌幅"))


def _resolve_name(ts_code: str, market: str) -> str | None:
    if _pro is None:
        return None
    if ts_code in _NAME_CACHE:
        return _NAME_CACHE[ts_code]
    try:
        if market == "hk":
            df = _pro.hk_basic(fields="ts_code,name")
        else:
            df = _pro.stock_basic(list_status="L", fields="ts_code,name")
    except Exception as e:
        log.warning("provider %s failed: %s", "tushare_name_lookup", e)
        return None
    if df is None or df.empty:
        return None
    for r in df.itertuples():
        _NAME_CACHE[r.ts_code] = r.name
    return _NAME_CACHE.get(ts_code)
