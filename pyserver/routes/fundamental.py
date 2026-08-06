"""Fundamental endpoint."""
from __future__ import annotations

from datetime import date, datetime, timedelta
from typing import Any

import pandas as pd
from fastapi import HTTPException

from cache import cache_get, cache_put
from config import MARKET_ENABLE_TUSHARE_SECONDARY, MOCK_MODE, log
from http_util import _with_retries
from mock_data import mock_fundamental
from models import Fundamental
from providers.akshare_spot import _ak_a_spot, _resolve_name
from providers.akshare_analyst import _ak_stock_value_row
from providers.tushare_api import _attach_profit_yoy, _daily_basic, _pro
from symbols import _echo_request_symbol, _to_ts_code
from util import _ak_col, _market_cap_to_yi, _num_or_none, _source_summary
from validation import _validate_symbol


def fundamental(symbol: str):
    symbol = _validate_symbol(symbol)
    ts_code, market = _to_ts_code(symbol)
    key = f"fund:v4:{ts_code}"
    cached = cache_get(key)
    if cached is not None:
        return _echo_request_symbol(cached, symbol)

    if MOCK_MODE:
        out = mock_fundamental(symbol)
        out["source"] = "mock"
        out["fetched_at"] = datetime.now().isoformat()
        out["warnings"] = []
        out["field_sources"] = {k: "mock" for k in ("pe_ttm", "pb", "market_cap", "profit_yoy") if out.get(k) is not None}
        cache_put(key, out, 3600)
        return out

    out: dict[str, Any] = {
        "symbol": symbol,
        "name": None if market in {"sh", "sz", "bj"} else _resolve_name(ts_code, market),
        "source": "unknown",
        "fetched_at": datetime.now().isoformat(),
        "warnings": [],
        "field_sources": {},
    }

    stock_value = _ak_stock_value_row(ts_code)
    if stock_value is not None:
        for field in ("pe_ttm", "pb", "market_cap"):
            if stock_value.get(field) is not None:
                out[field] = stock_value[field]
                out["field_sources"][field] = "akshare_stock_value_em"
        for field in ("latest_close", "latest_date", "change_pct"):
            if stock_value.get(field) is not None:
                out[field] = stock_value[field]
                # Primary A-share path: audit via field_sources only (not warnings).
                out["field_sources"][field] = "akshare_stock_value_em"
    elif market in {"sh", "sz", "bj"}:
        out["warnings"].append("akshare stock_value_em unavailable")

    ak_spot = _ak_a_spot(ts_code, market)
    if ak_spot is not None:
        out["name"] = str(ak_spot.get("名称") or out.get("name") or "")
        pe_ttm = _num_or_none(_ak_col(pd.Series(ak_spot), "市盈率-动态", "市盈率", "PE"))
        pb = _num_or_none(_ak_col(pd.Series(ak_spot), "市净率", "PB"))
        market_cap = _market_cap_to_yi(_num_or_none(_ak_col(pd.Series(ak_spot), "总市值")))
        if out.get("pe_ttm") is None and pe_ttm is not None:
            out["pe_ttm"] = pe_ttm
            out["field_sources"]["pe_ttm"] = "akshare_eastmoney"
        if out.get("pb") is None and pb is not None:
            out["pb"] = pb
            out["field_sources"]["pb"] = "akshare_eastmoney"
        if out.get("market_cap") is None and market_cap is not None:
            out["market_cap"] = market_cap
            out["field_sources"]["market_cap"] = "akshare_eastmoney"

    _attach_profit_yoy(out, ts_code, market)

    if (
        market in {"sh", "sz", "bj"}
        and MARKET_ENABLE_TUSHARE_SECONDARY
        and _pro is not None
        and any(out.get(field) is None for field in ("pe_ttm", "pb", "market_cap"))
    ):
        try:
            today = date.today().strftime("%Y%m%d")
            start = (date.today() - timedelta(days=10)).strftime("%Y%m%d")
            df = _with_retries(
                _daily_basic,
                ts_code=ts_code, start_date=start, end_date=today,
                fields="ts_code,trade_date,close,pe_ttm,pb,total_mv",
            )
            if df is not None and not df.empty:
                latest = df.sort_values("trade_date").iloc[-1]
                if out.get("pe_ttm") is None and pd.notna(latest.get("pe_ttm")):
                    out["pe_ttm"] = float(latest["pe_ttm"])
                    out["field_sources"]["pe_ttm"] = "tushare_daily_basic"
                if out.get("pb") is None and pd.notna(latest.get("pb")):
                    out["pb"] = float(latest["pb"])
                    out["field_sources"]["pb"] = "tushare_daily_basic"
                if out.get("market_cap") is None and pd.notna(latest.get("total_mv")):
                    out["market_cap"] = float(latest["total_mv"]) / 1e4
                    out["field_sources"]["market_cap"] = "tushare_daily_basic"
        except Exception as e:
            log.exception("tushare daily_basic failed for %s", ts_code)
            out["warnings"].append(f"tushare daily_basic unavailable: {type(e).__name__}")
    elif market in {"sh", "sz", "bj"} and not MARKET_ENABLE_TUSHARE_SECONDARY:
        missing_for_tushare = [field for field in ("pe_ttm", "pb", "market_cap") if out.get(field) is None]
        if missing_for_tushare:
            out["warnings"].append(f"Tushare secondary disabled; missing fields: {','.join(missing_for_tushare)}")

    missing = [field for field in ("pe_ttm", "pb", "market_cap") if out.get(field) is None]
    if missing:
        out["source"] = _source_summary(out["field_sources"])
        raise HTTPException(502, f"fundamental fields missing for {symbol}: {','.join(missing)}")

    out["source"] = _source_summary(out["field_sources"])
    cache_put(key, out, 24 * 3600 if out.get("profit_yoy") is not None else 3600)
    return out


def register(app):
    app.get("/fundamental", response_model=Fundamental)(fundamental)
