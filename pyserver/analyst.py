"""Analyst consensus endpoint — extracted from main.py for maintainability.

Uses late imports for main.py helpers to avoid circular imports.
"""
from __future__ import annotations

from datetime import date, datetime, timedelta
from typing import Any

import pandas as pd
from fastapi import HTTPException, Query

from cache import cache_get, cache_put
from validation import _validate_symbol

_ANALYSTS_MAX_SYMBOLS = 50


def analyst(symbol: str):
    """Sell-side consensus from free AkShare paths with optional Tushare.

    Aggregates EPS forecasts for next fiscal year across recent analyst
    reports; implied target = consensus EPS * current PE(TTM).
    """
    # Late import: main.py imports this module, so we can't import main at
    # module level. These are resolved at call time, which is after main.py
    # has finished loading.
    from main import (
        MOCK_MODE,
        MARKET_ENABLE_TUSHARE_SECONDARY,
        _QUOTE_SOURCE_KEY,
        _ak_a_spot,
        _ak_a_spot_from_hist,
        _ak_col,
        _ak_consensus_eps,
        _ak_research_consensus,
        _ak_stock_value_row,
        _daily_basic,
        _echo_request_symbol,
        _num_or_none,
        _pro,
        _report_rc,
        _source_summary,
        _spot_price_from_ak,
        _to_ts_code,
        _with_retries,
        log,
    )

    symbol = _validate_symbol(symbol)
    ts_code, market = _to_ts_code(symbol)
    key = f"analyst:v4:{ts_code}"
    cached = cache_get(key)
    if cached is not None:
        return _echo_request_symbol(cached, symbol)

    if MOCK_MODE:
        # mock_analyst is only present in main's namespace when MOCK_MODE is
        # set, so import it lazily here rather than in the top-level late import.
        from main import mock_analyst

        out = mock_analyst(symbol)
        out["source"] = "mock"
        out["fetched_at"] = datetime.now().isoformat()
        out["warnings"] = []
        out["field_sources"] = {k: "mock" for k in (
            "buy_count", "total_count", "buy_ratio", "consensus_eps_next",
            "implied_target", "current_price", "upside_pct",
        ) if out.get(k) is not None}
        cache_put(key, out, 3600)
        return out

    out: dict[str, Any] = {
        "symbol": symbol,
        "source": "akshare_primary",
        "fetched_at": datetime.now().isoformat(),
        "warnings": [],
        "field_sources": {},
    }
    if market == "hk":
        raise HTTPException(502, "analyst data unavailable for HK symbols")

    # Always fetch most-recent close first so the UI can show current price even
    # when sell-side reports are absent or Tushare report_rc is rate-limited.
    pe_ttm: float | None = None
    ak_spot = _ak_a_spot(ts_code, market)
    if ak_spot is not None:
        price = _spot_price_from_ak(ak_spot)
        if price is not None:
            out["current_price"] = round(price, 3)
            out["field_sources"]["current_price"] = ak_spot.get(_QUOTE_SOURCE_KEY, "akshare_eastmoney")
        pe_ttm = _num_or_none(_ak_col(pd.Series(ak_spot), "市盈率-动态", "市盈率", "PE"))
    stock_value = _ak_stock_value_row(ts_code)
    if stock_value is not None:
        if out.get("current_price") is None and stock_value.get("latest_close") is not None:
            out["current_price"] = round(float(stock_value["latest_close"]), 3)
            out["field_sources"]["current_price"] = "akshare_stock_value_em_close"
            out["warnings"].append("current_price is latest daily close from AkShare stock_value_em, not realtime")
        if pe_ttm is None and stock_value.get("pe_ttm") is not None:
            pe_ttm = float(stock_value["pe_ttm"])
            out["field_sources"]["pe_ttm"] = "akshare_stock_value_em"
    if out.get("current_price") is None and market in {"sh", "sz", "bj"}:
        hist_spot = _ak_a_spot_from_hist(ts_code, market, symbol)
        if hist_spot is not None:
            out["current_price"] = round(float(hist_spot["price"]), 3)
            out["field_sources"]["current_price"] = "akshare_daily_close"
            out["warnings"].append("current_price is latest daily close from AkShare daily history, not realtime")
    if MARKET_ENABLE_TUSHARE_SECONDARY and _pro is not None and (out.get("current_price") is None or pe_ttm is None):
        try:
            today = date.today().strftime("%Y%m%d")
            start_d = (date.today() - timedelta(days=10)).strftime("%Y%m%d")
            db = _with_retries(
                _daily_basic,
                ts_code=ts_code, start_date=start_d, end_date=today,
                fields="ts_code,trade_date,close,pe_ttm",
            )
            if db is not None and not db.empty:
                latest = db.sort_values("trade_date").iloc[-1]
                if out.get("current_price") is None and pd.notna(latest.get("close")):
                    out["current_price"] = round(float(latest["close"]), 3)
                    out["field_sources"]["current_price"] = "tushare_daily_basic"
                if pe_ttm is None and pd.notna(latest.get("pe_ttm")):
                    pe_ttm = float(latest["pe_ttm"])
        except Exception as e:
            log.exception("tushare daily_basic failed for %s", ts_code)
            out["warnings"].append(f"tushare daily_basic unavailable: {type(e).__name__}")
    elif out.get("current_price") is None or pe_ttm is None:
        out["warnings"].append("Tushare daily_basic secondary disabled")

    compact_symbol = ts_code.split(".")[0]
    research = _ak_research_consensus(compact_symbol)
    out.update(research)
    for field_name in ("buy_count", "total_count", "buy_ratio", "consensus_eps_next"):
        if field_name in research and research.get(field_name) is not None:
            out["field_sources"][field_name] = "akshare_research_report"

    if out.get("consensus_eps_next") is None:
        eps, forecast_count = _ak_consensus_eps(compact_symbol)
        if eps is not None:
            out["consensus_eps_next"] = eps
            out["field_sources"]["consensus_eps_next"] = "akshare_profit_forecast"
            if forecast_count is not None and out.get("total_count") is None:
                out["total_count"] = forecast_count
                out["field_sources"]["total_count"] = "akshare_profit_forecast"

    if out.get("consensus_eps_next") is not None and pe_ttm is not None:
        out["implied_target"] = round(out["consensus_eps_next"] * pe_ttm, 3)
        out["field_sources"]["implied_target"] = "derived_eps_pe"
        if out.get("current_price"):
            out["upside_pct"] = round(
                (out["implied_target"] / out["current_price"] - 1) * 100, 2
            )
            out["field_sources"]["upside_pct"] = "derived_target_price"

    if out.get("implied_target") is not None and out.get("buy_count") is not None:
        out["source"] = _source_summary(out["field_sources"])
        cache_put(key, out, 24 * 3600)
        return out

    if any(out.get(k) is not None for k in ("buy_count", "total_count", "consensus_eps_next")):
        if pe_ttm is None:
            out["warnings"].append("pe_ttm unavailable; implied target not calculated")
        out["source"] = _source_summary(out["field_sources"])
        cache_put(key, out, 24 * 3600)
        return out

    if not MARKET_ENABLE_TUSHARE_SECONDARY:
        out["warnings"].append("implied target unavailable from free sources; Tushare report_rc secondary disabled")
        out["source"] = _source_summary(out["field_sources"])
        cache_put(key, out, 24 * 3600 if any(out.get(k) is not None for k in ("current_price", "consensus_eps_next", "buy_count", "total_count")) else 3600)
        return out

    # Pull last ~180 days of broker reports.
    start = (date.today() - timedelta(days=180)).strftime("%Y%m%d")
    try:
        rc = _with_retries(_report_rc, ts_code=ts_code, start_date=start)
    except Exception as e:
        log.exception("tushare report_rc failed for %s", ts_code)
        out["warnings"].append(f"tushare report_rc unavailable: {type(e).__name__}")
        if not any(out.get(k) is not None for k in ("implied_target", "buy_count", "total_count", "consensus_eps_next", "upside_pct")):
            out["error"] = "report_rc unavailable; detail logged server-side"
        cache_put(key, out, 60)
        return out

    if rc is None or rc.empty:
        out["warnings"].append("tushare report_rc returned no analyst reports")
        if not any(out.get(k) is not None for k in ("implied_target", "buy_count", "total_count", "consensus_eps_next", "upside_pct")):
            out["error"] = "report_rc returned no analyst reports"
        cache_put(key, out, 24 * 3600)
        return out

    out["total_count"] = int(len(rc))
    out["field_sources"]["total_count"] = "tushare_report_rc"
    if "rating" in rc.columns:
        # tushare ratings: 买入/推荐/增持/中性/减持/卖出 etc.
        bullish = rc["rating"].isin(["买入", "推荐", "强烈推荐", "增持"]).sum()
        out["buy_count"] = int(bullish)
        out["buy_ratio"] = round(out["buy_count"] / out["total_count"], 3)
        out["field_sources"]["buy_count"] = "tushare_report_rc"
        out["field_sources"]["buy_ratio"] = "tushare_report_rc"

    # Consensus next-year EPS: pick the median forecast for the soonest
    # forward fiscal year present in the data.
    next_year = date.today().year + 1
    yr_str = f"{next_year}Q4"
    pool = rc[rc.get("quarter") == yr_str]
    if pool.empty:
        # fall back to nearest available future year
        future = rc[rc["quarter"].str.match(r"^\d{4}Q4$", na=False)]
        future = future[future["quarter"].str[:4].astype(int) > date.today().year]
        if not future.empty:
            soonest = future["quarter"].min()
            pool = future[future["quarter"] == soonest]
    eps_series = pd.to_numeric(pool.get("eps"), errors="coerce").dropna() if not pool.empty else pd.Series(dtype=float)
    if not eps_series.empty:
        out["consensus_eps_next"] = round(float(eps_series.median()), 4)
        out["field_sources"]["consensus_eps_next"] = "tushare_report_rc"

    # Prefer explicit sell-side target-price fields when Tushare provides them;
    # otherwise fall back to EPS * PE(TTM).
    target_cols = [c for c in rc.columns if str(c).lower() in {"target_price", "target", "tp"}]
    targets: list[float] = []
    for col in target_cols:
        targets.extend(x for x in (_num_or_none(v) for v in rc[col]) if x is not None and x > 0)
    if targets:
        out["implied_target"] = round(float(pd.Series(targets).median()), 3)
        out["field_sources"]["implied_target"] = "tushare_report_rc"
    elif out.get("consensus_eps_next") is not None and pe_ttm is not None:
        out["implied_target"] = round(out["consensus_eps_next"] * pe_ttm, 3)
        out["field_sources"]["implied_target"] = "derived_eps_pe"

    if out.get("implied_target") is not None and out.get("current_price"):
        out["upside_pct"] = round(
            (out["implied_target"] / out["current_price"] - 1) * 100, 2
        )
        out["field_sources"]["upside_pct"] = "derived_target_price"

    out["source"] = _source_summary(out["field_sources"])
    cache_put(key, out, 24 * 3600)
    return out


def analysts(symbols: str = Query(..., description="comma-separated symbols")):
    # Late import for main.py helpers used in the error-reporting path.
    from main import MARKET_ENABLE_TUSHARE_SECONDARY, log

    uniq = [s.strip() for s in symbols.split(",") if s.strip()]
    if len(uniq) > _ANALYSTS_MAX_SYMBOLS:
        raise HTTPException(400, f"symbols 最多 {_ANALYSTS_MAX_SYMBOLS} 个")
    # A single invalid symbol rejects the whole batch with 400.
    for s in uniq:
        _validate_symbol(s)
    seen: set[str] = set()
    out: list[dict[str, Any]] = []
    for symbol in uniq:
        if symbol in seen:
            continue
        seen.add(symbol)
        try:
            out.append(analyst(symbol))
        except Exception as e:
            detail = getattr(e, "detail", None)
            if detail is not None:
                # HTTPException details are already sanitized static messages.
                message = str(detail)
            else:
                # Do not leak internal exception text (DB paths, URLs) to clients.
                log.exception("analyst failed for %s", symbol)
                message = "analyst upstream error; detail logged server-side"
            out.append({
                "symbol": symbol,
                "source": "akshare+baostock+tushare" if MARKET_ENABLE_TUSHARE_SECONDARY else "akshare+baostock",
                "fetched_at": datetime.now().isoformat(),
                "error": message,
                "warnings": [message],
                "field_sources": {},
            })
    return out


def register_routes(app, Analyst_model):
    """Register analyst routes on the FastAPI app."""
    @app.get("/analyst", response_model=Analyst_model)
    def _analyst_route(symbol: str):
        return analyst(symbol)

    @app.get("/analysts", response_model=list[Analyst_model])
    def _analysts_route(symbols: str = Query(..., description="comma-separated symbols")):
        return analysts(symbols)
