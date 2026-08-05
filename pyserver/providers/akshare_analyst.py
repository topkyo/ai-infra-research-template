"""AkShare valuation and analyst consensus helpers."""
from __future__ import annotations

import re
from datetime import date
from typing import Any

import akshare as ak
import pandas as pd

from cache import cache_get, cache_put
from config import NEGATIVE_CACHE, log
from http_util import _ak_call, _with_retries
from symbols import _compact_code
from util import _ak_col, _market_cap_to_yi, _num_or_none, seconds_until_next_trading_close


def _ak_stock_value_row(ts_code: str) -> dict[str, Any] | None:
    """Latest valuation row from AkShare stock_value_em."""
    if ts_code.endswith(".HK"):
        return None
    code = _compact_code(ts_code)
    key = f"ak:stock_value_em:v1:{code}"
    cached = cache_get(key)
    if cached is not None:
        if isinstance(cached, dict) and cached.get("__negative_cache__"):
            return None
        return cached
    try:
        df = _with_retries(
            _ak_call,
            ak.stock_value_em,
            symbol=code,
            attempts=2,
            base_delay=0.2,
        )
    except Exception as e:
        log.warning("provider %s failed: %s", "akshare_stock_value_em", e)
        cache_put(key, NEGATIVE_CACHE, 300)
        return None
    if df is None or df.empty:
        cache_put(key, NEGATIVE_CACHE, 300)
        return None
    df = df.sort_values("数据日期") if "数据日期" in df.columns else df
    row = df.iloc[-1]
    out = {
        "latest_date": str(row.get("数据日期") or ""),
        "latest_close": _num_or_none(_ak_col(row, "当日收盘价", "收盘价", "close")),
        "change_pct": _num_or_none(_ak_col(row, "当日涨跌幅", "涨跌幅", "pct_chg")),
        "pe_ttm": _num_or_none(_ak_col(row, "PE(TTM)", "市盈率TTM", "市盈率-动态")),
        "pb": _num_or_none(_ak_col(row, "市净率", "PB")),
        "market_cap": _market_cap_to_yi(_num_or_none(_ak_col(row, "总市值"))),
    }
    cache_put(key, out, seconds_until_next_trading_close())
    return out


def _ak_consensus_eps(symbol: str) -> tuple[float | None, int | None]:
    """Fetch nearest annual EPS forecast from 同花顺 via akshare."""
    try:
        df = _with_retries(
            _ak_call,
            ak.stock_profit_forecast_ths,
            symbol=symbol,
            indicator="预测年报每股收益",
            attempts=2,
            base_delay=0.2,
        )
    except Exception as e:
        log.warning("provider %s failed: %s", "akshare_stock_profit_forecast_ths", e)
        return None, None
    if df is None or df.empty or "年度" not in df.columns or "均值" not in df.columns:
        return None, None

    current_year = date.today().year
    work = df.copy()
    work["年度"] = pd.to_numeric(work["年度"], errors="coerce")
    work["均值"] = pd.to_numeric(work["均值"], errors="coerce")
    work = work.dropna(subset=["年度", "均值"])
    work = work[work["年度"].astype(int) >= current_year]
    if work.empty:
        return None, None

    row = work.sort_values("年度").iloc[0]
    count = None
    if "预测机构数" in row and pd.notna(row.get("预测机构数")):
        count = int(row["预测机构数"])
    return round(float(row["均值"]), 4), count


def _ak_research_consensus(symbol: str) -> dict[str, Any]:
    """Fetch per-stock research reports from Eastmoney via akshare."""
    try:
        df = _with_retries(
            _ak_call,
            ak.stock_research_report_em,
            symbol=symbol,
            attempts=2,
            base_delay=0.2,
        )
    except Exception as e:
        log.warning("provider %s failed: %s", "akshare_stock_research_report_em", e)
        return {}
    if df is None or df.empty:
        return {}

    out: dict[str, Any] = {"total_count": int(len(df))}

    if "东财评级" in df.columns:
        ratings = df["东财评级"].fillna("").astype(str)
        bullish = ratings.isin(["买入", "推荐", "强烈推荐", "增持"]).sum()
        out["buy_count"] = int(bullish)
        out["buy_ratio"] = round(out["buy_count"] / out["total_count"], 3)

    current_year = date.today().year
    eps_cols: list[tuple[int, str]] = []
    for col in df.columns:
        m = re.match(r"^(\d{4})-盈利预测-收益$", str(col))
        if m and int(m.group(1)) >= current_year:
            eps_cols.append((int(m.group(1)), str(col)))

    if eps_cols:
        _, eps_col = sorted(eps_cols)[0]
        eps_series = pd.to_numeric(df[eps_col], errors="coerce").dropna()
        if not eps_series.empty:
            out["consensus_eps_next"] = round(float(eps_series.median()), 4)

    return out
