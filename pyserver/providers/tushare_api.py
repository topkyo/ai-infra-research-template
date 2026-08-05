"""Tushare Pro secondary source helpers."""
from __future__ import annotations

from datetime import date, timedelta
from typing import Any

import tushare as ts

from config import MARKET_ENABLE_TUSHARE_SECONDARY, MOCK_MODE, TUSHARE_TOKEN, log
from http_util import (
    _DAILY_BASIC_LIMITER,
    _FINA_INDICATOR_LIMITER,
    _REPORT_RC_LIMITER,
    _with_retries,
)
from util import _num_or_none

if MOCK_MODE:
    _pro = None
elif MARKET_ENABLE_TUSHARE_SECONDARY:
    _pro = ts.pro_api(TUSHARE_TOKEN)
else:
    _pro = None


def _report_rc(**kwargs):
    """Rate-limited wrapper around pro.report_rc."""
    if not MARKET_ENABLE_TUSHARE_SECONDARY:
        raise RuntimeError("Tushare report_rc secondary source is disabled")
    _REPORT_RC_LIMITER.acquire()
    return _pro.report_rc(**kwargs)


def _daily_basic(**kwargs):
    """Rate-limited wrapper around pro.daily_basic."""
    if not MARKET_ENABLE_TUSHARE_SECONDARY:
        raise RuntimeError("Tushare daily_basic secondary source is disabled")
    _DAILY_BASIC_LIMITER.acquire()
    return _pro.daily_basic(**kwargs)


def _fina_indicator(**kwargs):
    """Rate-limited wrapper around pro.fina_indicator."""
    if not MARKET_ENABLE_TUSHARE_SECONDARY:
        raise RuntimeError("Tushare fina_indicator secondary source is disabled")
    _FINA_INDICATOR_LIMITER.acquire()
    return _pro.fina_indicator(**kwargs)


def _latest_profit_yoy(ts_code: str) -> float | None:
    """Return the latest available net-profit growth percentage for PEG."""
    if _pro is None or not MARKET_ENABLE_TUSHARE_SECONDARY:
        return None
    start = (date.today() - timedelta(days=540)).strftime("%Y%m%d")
    today = date.today().strftime("%Y%m%d")
    df = _with_retries(
        _fina_indicator,
        ts_code=ts_code,
        start_date=start,
        end_date=today,
        fields="ts_code,ann_date,end_date,netprofit_yoy,q_netprofit_yoy,q_profit_yoy",
    )
    if df is None or df.empty:
        return None
    df = df.sort_values(["end_date", "ann_date"], na_position="first")
    latest = df.iloc[-1]
    for col in ("netprofit_yoy", "q_netprofit_yoy", "q_profit_yoy"):
        value = _num_or_none(latest.get(col))
        if value is not None:
            return value
    return None


def _attach_profit_yoy(out: dict[str, Any], ts_code: str, market: str) -> None:
    from providers.baostock_api import _baostock_growth_yoy

    if market == "hk":
        return
    profit_yoy = _baostock_growth_yoy(ts_code)
    if profit_yoy is not None:
        out["profit_yoy"] = profit_yoy
        out.setdefault("field_sources", {})["profit_yoy"] = "baostock_growth"
        return
    if not MARKET_ENABLE_TUSHARE_SECONDARY:
        out.setdefault("warnings", []).append("profit_yoy unavailable from free sources; Tushare secondary disabled")
        return
    try:
        profit_yoy = _latest_profit_yoy(ts_code)
    except Exception as e:
        log.exception("tushare fina_indicator failed for %s", ts_code)
        out.setdefault("warnings", []).append(
            f"tushare fina_indicator unavailable: {type(e).__name__}"
        )
        return
    if profit_yoy is not None:
        out["profit_yoy"] = profit_yoy
        out.setdefault("field_sources", {})["profit_yoy"] = "tushare_fina_indicator"
