"""BaoStock free secondary source for A-share history and growth."""
from __future__ import annotations

import io
from contextlib import redirect_stdout
from datetime import date
from typing import Any

import baostock as bs
import pandas as pd

from cache import cache_get, cache_put
from config import NEGATIVE_CACHE, log
from http_util import _BS_LOCK
from util import _num_or_none


def _baostock_code(ts_code: str) -> str:
    code, suffix = ts_code.split(".")
    return f"{suffix.lower()}.{code}"


def _baostock_login():
    with redirect_stdout(io.StringIO()):
        lg = bs.login()
    if getattr(lg, "error_code", "0") != "0":
        raise RuntimeError(getattr(lg, "error_msg", "BaoStock login failed"))
    return lg


def _baostock_logout() -> None:
    with redirect_stdout(io.StringIO()):
        bs.logout()


def _baostock_hist_df(ts_code: str, start: str, end: str, adjust: str) -> pd.DataFrame | None:
    """A-share daily bars via BaoStock as the free secondary source."""
    if ts_code.endswith(".HK"):
        return None
    start_s = f"{start[:4]}-{start[4:6]}-{start[6:]}"
    end_s = f"{end[:4]}-{end[4:6]}-{end[6:]}"
    adjustflag = {"qfq": "2", "hfq": "1", "": "3"}.get(adjust, "2")
    fields = "date,code,open,high,low,close,volume,amount,pctChg"
    with _BS_LOCK:
        _baostock_login()
        try:
            rs = bs.query_history_k_data_plus(
                _baostock_code(ts_code),
                fields,
                start_date=start_s,
                end_date=end_s,
                frequency="d",
                adjustflag=adjustflag,
            )
            if getattr(rs, "error_code", "0") != "0":
                return None
            data: list[list[str]] = []
            while rs.next():
                data.append(rs.get_row_data())
        finally:
            _baostock_logout()
    if not data:
        return pd.DataFrame()
    df = pd.DataFrame(data, columns=rs.fields)
    for col in ("open", "high", "low", "close", "volume"):
        df[col] = pd.to_numeric(df[col], errors="coerce")
    df = df.dropna(subset=["date", "open", "high", "low", "close"])
    if df.empty:
        return pd.DataFrame()
    return df


def _rows_from_baostock_hist(df: pd.DataFrame) -> list[dict[str, Any]]:
    out = df.sort_values("date").copy()
    out["date"] = pd.to_datetime(out["date"]).dt.strftime("%Y-%m-%d")
    return out[["date", "open", "high", "low", "close", "volume"]].to_dict(orient="records")


def _baostock_growth_yoy(ts_code: str) -> float | None:
    """Latest annual/quarterly YOY net-profit growth from BaoStock."""
    if ts_code.endswith(".HK"):
        return None
    cache_key = f"baostock:growth:v2:{ts_code}"
    cached = cache_get(cache_key)
    if cached is not None:
        if isinstance(cached, dict) and cached.get("__negative_cache__"):
            return None
        return _num_or_none(cached.get("profit_yoy"))

    current_year = date.today().year
    with _BS_LOCK:
        _baostock_login()
        try:
            for year in range(current_year, current_year - 4, -1):
                for quarter in (4, 3, 2, 1):
                    rs = bs.query_growth_data(code=_baostock_code(ts_code), year=year, quarter=quarter)
                    if getattr(rs, "error_code", "0") != "0":
                        continue
                    rows: list[list[str]] = []
                    while rs.next():
                        rows.append(rs.get_row_data())
                    if not rows:
                        continue
                    df = pd.DataFrame(rows, columns=rs.fields)
                    if df.empty or "YOYNI" not in df.columns:
                        continue
                    value = _num_or_none(df.iloc[-1].get("YOYNI"))
                    if value is not None:
                        profit_yoy = value * 100
                        cache_put(cache_key, {"profit_yoy": profit_yoy}, 24 * 3600)
                        return profit_yoy
        finally:
            _baostock_logout()
    cache_put(cache_key, NEGATIVE_CACHE, 3600)
    return None
