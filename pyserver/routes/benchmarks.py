"""Benchmark index endpoints."""
from __future__ import annotations

from datetime import date

import akshare as ak
import pandas as pd
from fastapi import HTTPException, Query

from cache import cache_get, cache_put
from config import MARKET_ENABLE_TUSHARE_SECONDARY, MOCK_MODE, log
from http_util import _ak_call, _with_retries
from mock_data import BENCHMARKS, mock_klines
from models import Kline
from providers.tushare_api import _pro
from util import _empty_bars_ttl, seconds_until_next_trading_close
from validation import _validate_date, _validate_date_range


def benchmark_klines(
    index: str = Query("csi300", description="csi300 | star50 | csi500"),
    start: str = Query("20230101"),
    end: str | None = Query(None),
):
    """Index benchmark klines for backtest comparison."""
    if index not in BENCHMARKS:
        raise HTTPException(400, f"unknown index {index}")
    start = _validate_date(start, "start")
    end = _validate_date(end, "end") if end else date.today().strftime("%Y%m%d")
    _validate_date_range(start, end)
    ts_code, _name = BENCHMARKS[index]
    key = f"bench:{index}:{start}:{end}"
    cached = cache_get(key)
    if cached is not None:
        return cached

    if MOCK_MODE:
        rows = mock_klines(ts_code, start, end)
        cache_put(key, rows, 3600)
        return rows

    ak_symbol = ts_code.split(".")[0]
    if ts_code.endswith(".SH"):
        ak_symbol = f"sh{ak_symbol}"
    elif ts_code.endswith(".SZ"):
        ak_symbol = f"sz{ak_symbol}"
    # Per-source tri-state: None=failure, empty=confirmed no rows, rows=data.
    had_failure = False
    confirmed_empty = False
    df: pd.DataFrame | None = None
    try:
        ak_df = _with_retries(
            _ak_call,
            ak.stock_zh_index_daily,
            symbol=ak_symbol,
            attempts=2,
            base_delay=0.2,
        )
        if ak_df is None:
            had_failure = True
        elif ak_df.empty:
            confirmed_empty = True
            df = ak_df
        else:
            filtered = ak_df[
                (pd.to_datetime(ak_df["date"]) >= pd.to_datetime(start))
                & (pd.to_datetime(ak_df["date"]) <= pd.to_datetime(end))
            ]
            if filtered.empty:
                confirmed_empty = True
            df = filtered
    except Exception:
        log.exception("benchmark klines AkShare failed for %s", index)
        had_failure = True
        df = None

    if (df is None or df.empty) and _pro is not None and MARKET_ENABLE_TUSHARE_SECONDARY:
        try:
            ts_df = _with_retries(
                _pro.index_daily,
                ts_code=ts_code,
                start_date=start,
                end_date=end,
            )
            if ts_df is None:
                had_failure = True
            elif not ts_df.empty:
                df = ts_df
            else:
                confirmed_empty = True
                df = ts_df
        except Exception as e:
            log.exception("benchmark klines Tushare failed for %s", index)
            if not confirmed_empty:
                raise HTTPException(
                    502, "upstream index data error; detail logged server-side"
                ) from e
            had_failure = True

    if df is None and not had_failure:
        cache_put(key, [], _empty_bars_ttl(end))
        return []
    if df is None:
        log.warning("benchmark/klines: all sources returned None for %s (%s-%s)", index, start, end)
        raise HTTPException(502, "index data unavailable from any source; detail logged server-side")
    if df.empty:
        cache_put(key, [], _empty_bars_ttl(end))
        return []

    if "trade_date" in df.columns:
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
        out = df.sort_values("date").copy()
        out["date"] = pd.to_datetime(out["date"]).dt.strftime("%Y-%m-%d")
        rows = out[["date", "open", "high", "low", "close", "volume"]].to_dict(orient="records")
    cache_put(key, rows, seconds_until_next_trading_close())
    return rows


def list_benchmarks():
    return [{"id": k, "ts_code": v[0], "name": v[1]} for k, v in BENCHMARKS.items()]


def register(app):
    app.get("/benchmark/klines", response_model=list[Kline])(benchmark_klines)
    app.get("/benchmarks")(list_benchmarks)
