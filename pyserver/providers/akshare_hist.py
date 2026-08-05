"""AkShare historical daily bar helpers."""
from __future__ import annotations

from typing import Any

import akshare as ak
import pandas as pd

from config import log
from http_util import _ak_call, _with_retries
from symbols import _infer_market_prefix

_AK_HIST_RENAME = {
    "日期": "date",
    "开盘": "open",
    "最高": "high",
    "最低": "low",
    "收盘": "close",
    "成交量": "volume",
    "成交额": "amount",
    "涨跌幅": "pct_chg",
}


def _ak_a_hist_df(code: str, start: str, end: str, adjust: str = "qfq") -> pd.DataFrame | None:
    """A-share daily bars via AkShare.

    Eastmoney's push2his endpoint is fast but can disconnect/IP-throttle.
    Sina's daily endpoint is slower and less feature-rich, but has been more
    reliable for this watchlist, so use it as the second AkShare path before
    falling back to Tushare.

    ``None`` means upstream failure; an empty DataFrame means the source
    succeeded but returned zero rows for the requested window.
    """
    first_success_empty = False
    try:
        df = _with_retries(
            _ak_call,
            ak.stock_zh_a_hist,
            symbol=code,
            period="daily",
            start_date=start,
            end_date=end,
            adjust=adjust or "",
        )
    except Exception as e:
        log.warning("provider %s failed: %s", "akshare_stock_zh_a_hist", e)
        df = None
    if df is not None and not df.empty:
        return df
    if df is not None and df.empty:
        first_success_empty = True
    try:
        df = _with_retries(
            _ak_call,
            ak.stock_zh_a_daily,
            symbol=f"{_infer_market_prefix(code)}{code}",
            start_date=start,
            end_date=end,
            adjust=adjust or "",
            attempts=2,
            base_delay=0.2,
        )
    except Exception as e:
        log.warning("provider %s failed: %s", "akshare_stock_zh_a_daily", e)
        return pd.DataFrame() if first_success_empty else None
    if df is None:
        return pd.DataFrame() if first_success_empty else None
    if df.empty:
        return df
    return df


def _rows_from_ak_hist(df: pd.DataFrame) -> list[dict[str, Any]]:
    out = df.rename(columns=_AK_HIST_RENAME)
    if "date" in out.columns:
        out["date"] = pd.to_datetime(out["date"]).dt.strftime("%Y-%m-%d")
    cols = [c for c in ("date", "open", "high", "low", "close", "volume") if c in out.columns]
    return out[cols].to_dict(orient="records")
