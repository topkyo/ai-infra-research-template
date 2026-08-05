"""Spot quote endpoint."""
from __future__ import annotations

from datetime import date, datetime, timedelta

import akshare as ak
import pandas as pd
from fastapi import HTTPException

from cache import cache_get, cache_put
from config import MARKET_ENABLE_TUSHARE_SECONDARY, MOCK_MODE, log
from http_util import _ak_call, _with_retries
from mock_data import mock_spot
from models import Spot
from providers.akshare_analyst import _ak_stock_value_row
from providers.akshare_spot import (
    _ak_a_spot,
    _ak_a_spot_from_hist,
    _resolve_name,
    _spot_api_source_from_row,
    _spot_change_pct_from_ak,
    _spot_missing_field_warnings,
    _spot_price_from_ak,
    _spot_warnings_from_row,
)
from providers.tushare_api import _pro
from symbols import _echo_request_symbol, _to_ts_code
from util import _num_or_none
from validation import _validate_symbol


def spot(symbol: str):
    """Most-recent close (Tushare Pro has no realtime quote). 30s cache."""
    symbol = _validate_symbol(symbol)
    ts_code, market = _to_ts_code(symbol)
    key = f"spot:v3:{ts_code}"
    cached = cache_get(key)
    if cached is not None:
        return _echo_request_symbol(cached, symbol)

    if MOCK_MODE:
        out = mock_spot(symbol)
        out["source"] = "mock"
        out["fetched_at"] = datetime.now().isoformat()
        out["warnings"] = []
        cache_put(key, out, 30)
        return out

    start = (date.today() - timedelta(days=10)).strftime("%Y%m%d")
    end = date.today().strftime("%Y%m%d")
    try:
        if market in {"sh", "sz", "bj"}:
            ak_spot = _ak_a_spot(ts_code, market)
            price = _spot_price_from_ak(ak_spot) if ak_spot is not None else None
            if ak_spot is not None and price is not None:
                change_pct = _spot_change_pct_from_ak(ak_spot)
                volume = _num_or_none(ak_spot.get("成交量"))
                turnover = _num_or_none(ak_spot.get("成交额"))
                out = {
                    "symbol": symbol,
                    "name": str(ak_spot.get("名称") or _resolve_name(ts_code, market) or ""),
                    "price": price,
                    "change_pct": change_pct,
                    "volume": volume,
                    "turnover": turnover,
                    "source": _spot_api_source_from_row(ak_spot),
                    "fetched_at": datetime.now().isoformat(),
                    "warnings": _spot_warnings_from_row(ak_spot),
                }
                cache_put(key, out, 30)
                return out
            stock_value = _ak_stock_value_row(ts_code)
            if stock_value is not None and stock_value.get("latest_close") is not None:
                change_pct = _num_or_none(stock_value.get("change_pct"))
                out = {
                    "symbol": symbol,
                    "name": "",
                    "price": float(stock_value["latest_close"]),
                    "change_pct": change_pct,
                    "volume": None,
                    "turnover": None,
                    "source": "akshare_stock_value_em_close",
                    "fetched_at": datetime.now().isoformat(),
                    "warnings": [
                        "Eastmoney realtime unavailable; returned AkShare stock_value_em latest daily close, not realtime",
                        *_spot_missing_field_warnings(change_pct=change_pct, volume=None, turnover=None),
                    ],
                }
                cache_put(key, out, 30)
                return out
            hist_spot = _ak_a_spot_from_hist(ts_code, market, symbol)
            if hist_spot is not None:
                change_pct = _num_or_none(hist_spot.get("change_pct"))
                volume = _num_or_none(hist_spot.get("volume"))
                turnover = _num_or_none(hist_spot.get("turnover"))
                out = {
                    "symbol": symbol,
                    "name": hist_spot.get("name") or "",
                    "price": float(hist_spot["price"]),
                    "change_pct": change_pct,
                    "volume": volume,
                    "turnover": turnover,
                    "source": "akshare_daily_close",
                    "fetched_at": datetime.now().isoformat(),
                    "warnings": [
                        "Eastmoney realtime unavailable; returned AkShare latest daily close, not realtime",
                        *_spot_missing_field_warnings(change_pct=change_pct, volume=volume, turnover=turnover),
                    ],
                }
                cache_put(key, out, 30)
                return out
        if market == "hk":
            ak_code = ts_code.split(".")[0]
            df = _with_retries(
                _ak_call,
                ak.stock_hk_hist,
                symbol=ak_code, period="daily", start_date=start, end_date=end, adjust="",
            )
            if df is None or df.empty:
                raise HTTPException(404, f"symbol {symbol} not found")
            df = df.rename(columns={
                "日期": "trade_date", "开盘": "open", "最高": "high",
                "最低": "low", "收盘": "close", "成交量": "vol",
                "成交额": "amount", "涨跌幅": "pct_chg",
            })
        else:
            if _pro is None or not MARKET_ENABLE_TUSHARE_SECONDARY:
                raise HTTPException(502, f"spot quote unavailable for {symbol}")
            df = _with_retries(_pro.daily, ts_code=ts_code, start_date=start, end_date=end)
            if df is None or df.empty:
                raise HTTPException(502, f"spot quote unavailable for {symbol}")
            df = df.sort_values("trade_date")
    except HTTPException:
        raise
    except Exception as e:
        # Do not leak upstream exception details (URLs, tokens) to clients.
        log.exception("spot upstream failed for %s", symbol)
        raise HTTPException(502, "upstream market data error; detail logged server-side") from e
    r = df.iloc[-1]
    price = _num_or_none(r.get("close"))
    if price is None:
        raise HTTPException(502, f"spot quote unavailable for {symbol}")
    change_pct = _num_or_none(r.get("pct_chg"))
    volume = _num_or_none(r.get("vol"))
    turnover = _num_or_none(r.get("amount"))
    base_warnings: list[str] = (
        [] if market == "hk" else ["Eastmoney realtime unavailable; returned Tushare latest daily close, not realtime"]
    )
    out = {
        "symbol": symbol,
        "name": _resolve_name(ts_code, market) or "",
        "price": price,
        "change_pct": change_pct,
        "volume": volume,
        "turnover": turnover,
        "source": "akshare-hk-hist" if market == "hk" else "tushare-daily-close",
        "fetched_at": datetime.now().isoformat(),
        "warnings": [
            *base_warnings,
            *_spot_missing_field_warnings(change_pct=change_pct, volume=volume, turnover=turnover),
        ],
    }
    cache_put(key, out, 30)
    return out


def register(app):
    app.get("/spot", response_model=Spot)(spot)
