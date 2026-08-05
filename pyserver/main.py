"""FastAPI sidecar wrapping free-first market data providers.

Data-source split:
- A-share (sh/sz/bj): AkShare/Eastmoney for current price/basic metrics;
  BaoStock for historical daily bars and growth fields; Tushare Pro is an
  explicit secondary source only.
- HK: akshare's stock_hk_hist — Tushare's hk_daily is hard-capped at
  10 calls/day on the free Pro tier (and 2/min within that), making it
  unusable for a HK watchlist beyond the first ~10 requests of the day.

All responses write through a SQLite cache so upstream is hit at most once
per symbol per trading day (klines/fundamentals/analyst) or per 30s (spot).
"""
from __future__ import annotations

import config  # noqa: F401 — load .env and proxy env before cache import

import time
from datetime import date, datetime, timedelta
from typing import Any

import akshare as ak
import baostock as bs
import pandas as pd
import tushare as ts
from fastapi import FastAPI, HTTPException, Query

from config import (
    CACHE_NAMESPACE,
    HAS_TUSHARE_TOKEN,
    MARKET_ENABLE_TUSHARE_SECONDARY,
    MARKET_HTTP_PROXY,
    MOCK_MODE,
    NEGATIVE_CACHE,
    STRICT_LIVE_DATA,
    TUSHARE_TOKEN,
    _QUOTE_SOURCE_KEY,
    _strip_proxy_env,
    log,
)
from util import (
    _ak_col,
    _empty_bars_ttl,
    _market_cap_to_yi,
    _num_or_none,
    _source_summary,
    seconds_until_next_trading_close,
)
from http_util import (
    _AK_LOCK,
    _BS_LOCK,
    _DAILY_BASIC_LIMITER,
    _FINA_INDICATOR_LIMITER,
    _MARKET_HTTP_SESSION,
    _REPORT_RC_LIMITER,
    _TokenBucket,
    _ak_call,
    _market_http_get,
    _market_http_session,
    _with_retries,
)
from models import Analyst, Fundamental, Kline, Spot
from symbols import (
    _cache_ts_code,
    _compact_code,
    _eastmoney_market_code,
    _echo_request_symbol,
    _infer_market_prefix,
    _to_ts_code,
)


# Cache lives in cache.py; importing it here (after .env is loaded) resolves
# DB_PATH and runs _init_db() once. Names are re-exported so existing call
# sites and tests keep working via main.DB_PATH / main.db / main.cache_*.
import cache as cache_mod  # noqa: E402
from cache import (  # noqa: E402
    CACHE_MAX_ROWS,
    DB_PATH,
    SCHEMA,
    _init_db,
    cache_get,
    cache_prune,
    cache_put,
    db,
)

# cache_get/cache_put read CACHE_NAMESPACE from cache.py's module globals at
# call time, so mirror the mock/live choice into the cache module here.
cache_mod.CACHE_NAMESPACE = config.CACHE_NAMESPACE

from mock_data import BENCHMARKS  # noqa: E402
if MOCK_MODE:
    from mock_data import (  # noqa: E402
        mock_analyst,
        mock_fundamental,
        mock_klines,
        mock_spot,
    )

from providers.akshare_analyst import (  # noqa: E402
    _ak_consensus_eps,
    _ak_research_consensus,
    _ak_stock_value_row,
)
from providers.akshare_hist import (  # noqa: E402
    _AK_HIST_RENAME,
    _ak_a_hist_df,
    _rows_from_ak_hist,
)
from providers.akshare_spot import (  # noqa: E402
    _NAME_CACHE,
    _ak_a_spot,
    _ak_a_spot_from_hist,
    _ak_a_spot_rows,
    _resolve_name,
    _sina_a_spot_rows,
    _sina_hq_list_id,
    _spot_api_source_from_row,
    _spot_change_pct_from_ak,
    _spot_missing_field_warnings,
    _spot_price_from_ak,
    _spot_warnings_from_row,
    parse_sina_hq_text,
)
from providers.baostock_api import (  # noqa: E402
    _baostock_code,
    _baostock_growth_yoy,
    _baostock_hist_df,
    _baostock_login,
    _baostock_logout,
    _rows_from_baostock_hist,
)
from providers.tushare_api import (  # noqa: E402
    _attach_profit_yoy,
    _daily_basic,
    _fina_indicator,
    _latest_profit_yoy,
    _pro,
    _report_rc,
)

app = FastAPI(title="topkyo pyserver", version="0.2.0")


# ---------- input validation whitelist -------------------------------------

# Validators live in validation.py; re-exported here so existing call sites
# and tests keep working via main._validate_symbol / main._validate_date.
from validation import (  # noqa: E402
    _DATE_MIN,
    _SYMBOL_MAX_LEN,
    _SYMBOL_RE,
    _validate_date,
    _validate_date_range,
    _validate_symbol,
)

# analyst/analysts endpoints live in analyst.py; registered after app routes
# are defined to preserve route ordering. Late imports inside analyst.py avoid
# the circular dependency (main imports analyst, analyst imports main at call
# time).
from analyst import register_routes as register_analyst_routes  # noqa: E402


# ---------- endpoints ------------------------------------------------------


@app.get("/health")
def health():
    return {
        "ok": True,
        "time": datetime.now().isoformat(),
        "source": "mock" if MOCK_MODE else ("akshare+baostock+tushare" if MARKET_ENABLE_TUSHARE_SECONDARY else "akshare+baostock"),
        "mock": MOCK_MODE,
        "a_share_quotes": "akshare_primary",
        "tushare_secondary_enabled": MARKET_ENABLE_TUSHARE_SECONDARY,
    }


@app.get("/klines", response_model=list[Kline])
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


@app.get("/fundamental", response_model=Fundamental)
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
                out["field_sources"][field] = "akshare_stock_value_em"
        if stock_value.get("latest_close") is not None:
            out["warnings"].append(
                "latest_close is latest daily close from AkShare stock_value_em, not realtime"
            )
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


@app.get("/spot", response_model=Spot)
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

@app.get("/benchmark/klines", response_model=list[Kline])
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
    try:
        df = _with_retries(
            _ak_call,
            ak.stock_zh_index_daily,
            symbol=ak_symbol,
            attempts=2,
            base_delay=0.2,
        )
        if df is not None and not df.empty:
            df = df[(pd.to_datetime(df["date"]) >= pd.to_datetime(start)) & (pd.to_datetime(df["date"]) <= pd.to_datetime(end))]
    except Exception:
        df = None

    if (df is None or df.empty) and _pro is not None and MARKET_ENABLE_TUSHARE_SECONDARY:
        try:
            df = _with_retries(
                _pro.index_daily,
                ts_code=ts_code,
                start_date=start,
                end_date=end,
            )
        except Exception as e:
            # Do not leak upstream exception details (URLs, tokens) to clients.
            log.exception("benchmark klines upstream failed for %s", index)
            raise HTTPException(502, "upstream index data error; detail logged server-side") from e

    if df is None:
        # All sources returned None — upstream failure, not genuinely empty.
        # Do NOT disguise this as a successful empty result (禁止静默降级).
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


@app.get("/benchmarks")
def list_benchmarks():
    return [{"id": k, "ts_code": v[0], "name": v[1]} for k, v in BENCHMARKS.items()]


# Register extracted analyst routes last so existing route ordering is kept.
register_analyst_routes(app, Analyst)
