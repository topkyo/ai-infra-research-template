"""Klines endpoint."""
from __future__ import annotations

from datetime import date

import akshare as ak
import pandas as pd
import tushare as ts
from fastapi import HTTPException, Query

from cache import cache_get, cache_put
from config import MARKET_ENABLE_TUSHARE_SECONDARY, MOCK_MODE, log
from http_util import _ak_call, _with_retries
from mock_data import mock_klines
from models import Kline
from providers.akshare_hist import _ak_a_hist_df, _rows_from_ak_hist
from providers.baostock_api import _baostock_hist_df, _rows_from_baostock_hist
from providers.tushare_api import _pro
from symbols import _compact_code, _to_ts_code
from util import _empty_bars_ttl, seconds_until_next_trading_close
from validation import _validate_date, _validate_date_range, _validate_symbol


def klines(
    symbol: str = Query(..., description="e.g. sh600519, 000858, hk00700"),
    start: str = Query("20230101"),
    end: str | None = Query(None),
    adjust: str = Query("qfq", pattern="^(|qfq|hfq)$"),
):
    symbol = _validate_symbol(symbol)
    start = _validate_date(start, "start")
    end = _validate_date(end, "end") if end else date.today().strftime("%Y%m%d")
    _validate_date_range(start, end)
    ts_code, market = _to_ts_code(symbol)
    key = f"kline:{ts_code}:{start}:{end}:{adjust}"
    cached = cache_get(key)
    if cached is not None:
        return cached

    if MOCK_MODE:
        rows = mock_klines(symbol, start, end)
        cache_put(key, rows, 3600)
        return rows

    source = ""
    had_failure = False
    df: pd.DataFrame | None = None
    if market == "hk":
        # akshare for HK — Tushare's hk_daily is capped at 10/day.
        ak_code = ts_code.split(".")[0]  # "00700"
        try:
            df = _with_retries(
                _ak_call,
                ak.stock_hk_hist,
                symbol=ak_code, period="daily",
                start_date=start, end_date=end, adjust=(adjust or ""),
            )
            source = "akshare_hk_hist"
            if df is None:
                had_failure = True
        except Exception:
            log.exception("klines HK akshare failed for %s", symbol)
            had_failure = True
            df = None
    else:
        code = _compact_code(ts_code)
        # Per-source tri-state: None=failure, empty=confirmed no rows, rows=data.
        # Only None advances the fallback chain; empty still tries secondary sources.
        try:
            ak_df = _ak_a_hist_df(code, start, end, adjust or "qfq")
            if ak_df is None:
                had_failure = True
            elif not ak_df.empty:
                df = ak_df
                source = "akshare_a_hist"
        except Exception:
            log.exception("klines AkShare failed for %s", symbol)
            had_failure = True
        if df is None:
            try:
                bs_df = _baostock_hist_df(ts_code, start, end, adjust or "qfq")
                if bs_df is None:
                    had_failure = True
                elif not bs_df.empty:
                    df = bs_df
                    source = "baostock_history_k"
            except Exception:
                log.exception("klines BaoStock failed for %s", symbol)
                had_failure = True
        if df is None and _pro is not None and MARKET_ENABLE_TUSHARE_SECONDARY:
            try:
                ts_df = _with_retries(
                    ts.pro_bar,
                    ts_code=ts_code,
                    adj=(adjust or None),
                    start_date=start,
                    end_date=end,
                )
                if ts_df is None:
                    had_failure = True
                elif not ts_df.empty:
                    df = ts_df
                    source = "tushare_pro_bar"
            except Exception:
                log.exception("klines Tushare pro_bar failed for %s", symbol)
                had_failure = True

    if df is None and not had_failure:
        # A-share: every source confirmed empty window — not a failure.
        cache_put(key, [], _empty_bars_ttl(end))
        return []
    if df is None:
        # At least one source failed and none returned rows.
        log.warning("klines: all sources returned None for %s (%s-%s)", symbol, start, end)
        raise HTTPException(502, "market data unavailable from any source; detail logged server-side")
    if df.empty:
        # A working source returned an empty DataFrame — genuinely no bars
        # in the requested window (e.g. pre-IPO date range). Short TTL so
        # a retry sooner can pick up newly available data.
        cache_put(key, [], _empty_bars_ttl(end))
        return []

    if market == "hk":
        # akshare HK schema: 日期 / 开盘 / 最高 / 最低 / 收盘 / 成交量 ...
        df = df.rename(columns={
            "日期": "date", "开盘": "open", "最高": "high",
            "最低": "low", "收盘": "close", "成交量": "volume",
        })
        df["date"] = pd.to_datetime(df["date"]).dt.strftime("%Y-%m-%d")
        rows = df[["date", "open", "high", "low", "close", "volume"]].to_dict(orient="records")
    elif source == "baostock_history_k":
        rows = _rows_from_baostock_hist(df)
    elif "trade_date" in df.columns:
        df = df.sort_values("trade_date")
        rows = [
            {
                "date": f"{d[:4]}-{d[4:6]}-{d[6:]}",
                "open": float(r.open),
                "high": float(r.high),
                "low": float(r.low),
                "close": float(r.close),
                "volume": float(r.vol),
            }
            for r in df.itertuples()
            for d in [str(r.trade_date)]
        ]
    else:
        rows = _rows_from_ak_hist(df)
    cache_put(key, rows, seconds_until_next_trading_close())
    return rows


def register(app):
    app.get("/klines", response_model=list[Kline])(klines)
