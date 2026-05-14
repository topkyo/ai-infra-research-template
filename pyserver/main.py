"""FastAPI sidecar wrapping Tushare Pro (A-share) + akshare (HK fallback).

Data-source split:
- A-share (sh/sz/bj): Tushare Pro via ts.pro_bar / daily_basic / report_rc.
- HK: akshare's stock_hk_hist — Tushare's hk_daily is hard-capped at
  10 calls/day on the free Pro tier (and 2/min within that), making it
  unusable for a HK watchlist beyond the first ~10 requests of the day.

All responses write through a SQLite cache so upstream is hit at most once
per symbol per trading day (klines/fundamentals/analyst) or per 30s (spot).
"""
from __future__ import annotations

import json
import os
import re
import sqlite3
import time
from contextlib import contextmanager
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Any

import akshare as ak
import pandas as pd
import tushare as ts
from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, Query
from pydantic import BaseModel

# ---------- bootstrap ------------------------------------------------------

load_dotenv(Path(__file__).parent / ".env")
TUSHARE_TOKEN = os.environ.get("TUSHARE_TOKEN")
if not TUSHARE_TOKEN:
    raise RuntimeError(
        "TUSHARE_TOKEN not set. Put it in pyserver/.env or export it.",
    )
ts.set_token(TUSHARE_TOKEN)
_pro = ts.pro_api()

DB_PATH = Path(__file__).parent / "cache.db"

app = FastAPI(title="silicon-civ pyserver", version="0.2.0")

# ---------- cache ----------------------------------------------------------

SCHEMA = """
CREATE TABLE IF NOT EXISTS cache (
  key TEXT PRIMARY KEY,
  payload TEXT NOT NULL,
  fetched_at INTEGER NOT NULL,
  ttl_seconds INTEGER NOT NULL
);
"""


@contextmanager
def db():
    conn = sqlite3.connect(DB_PATH)
    conn.execute(SCHEMA)
    try:
        yield conn
        conn.commit()
    finally:
        conn.close()


def cache_get(key: str) -> Any | None:
    with db() as conn:
        row = conn.execute(
            "SELECT payload, fetched_at, ttl_seconds FROM cache WHERE key = ?",
            (key,),
        ).fetchone()
    if not row:
        return None
    payload, fetched_at, ttl = row
    if ttl > 0 and time.time() - fetched_at > ttl:
        return None
    return json.loads(payload)


def cache_put(key: str, value: Any, ttl_seconds: int) -> None:
    with db() as conn:
        conn.execute(
            "REPLACE INTO cache (key, payload, fetched_at, ttl_seconds) VALUES (?, ?, ?, ?)",
            (key, json.dumps(value, ensure_ascii=False), int(time.time()), ttl_seconds),
        )


def seconds_until_next_trading_close() -> int:
    """TTL so daily klines refresh after the next 15:30 CN market close."""
    now = datetime.now()
    target = now.replace(hour=15, minute=30, second=0, microsecond=0)
    if now >= target:
        target += timedelta(days=1)
    return int((target - now).total_seconds())


# ---------- retry wrapper + per-endpoint rate limiter ----------------------

import threading
from collections import deque


class _TokenBucket:
    """Simple token bucket — at most `n` calls per `window_s` seconds."""

    def __init__(self, n: int, window_s: float) -> None:
        self.n = n
        self.window = window_s
        self.calls: deque[float] = deque()
        self.lock = threading.Lock()

    def acquire(self) -> None:
        while True:
            with self.lock:
                now = time.monotonic()
                while self.calls and now - self.calls[0] > self.window:
                    self.calls.popleft()
                if len(self.calls) < self.n:
                    self.calls.append(now)
                    return
                wait = self.window - (now - self.calls[0]) + 0.05
            time.sleep(wait)


# Tushare free tier caps hk_daily at 2/minute. Self-throttle to avoid 502s.
_HK_DAILY_LIMITER = _TokenBucket(n=2, window_s=65)
_REPORT_RC_LIMITER = _TokenBucket(n=2, window_s=65)


def _with_retries(fn, *args, attempts: int = 3, base_delay: float = 0.5, **kwargs):
    last: Exception | None = None
    for i in range(attempts):
        try:
            return fn(*args, **kwargs)
        except Exception as e:  # noqa: BLE001
            last = e
            time.sleep(base_delay * (2 ** i))
    assert last is not None
    raise last


def _hk_daily(**kwargs):
    """Rate-limited wrapper around pro.hk_daily."""
    _HK_DAILY_LIMITER.acquire()
    return _pro.hk_daily(**kwargs)


def _report_rc(**kwargs):
    """Rate-limited wrapper around pro.report_rc."""
    _REPORT_RC_LIMITER.acquire()
    return _pro.report_rc(**kwargs)


# ---------- models ---------------------------------------------------------


class Kline(BaseModel):
    date: str
    open: float
    high: float
    low: float
    close: float
    volume: float


class Fundamental(BaseModel):
    symbol: str
    name: str | None = None
    pe_ttm: float | None = None
    pb: float | None = None
    market_cap: float | None = None  # 亿元
    revenue_yoy: float | None = None
    profit_yoy: float | None = None


class Analyst(BaseModel):
    symbol: str
    buy_count: int | None = None
    total_count: int | None = None
    buy_ratio: float | None = None
    consensus_eps_next: float | None = None
    implied_target: float | None = None
    current_price: float | None = None
    upside_pct: float | None = None


# ---------- symbol normalization -------------------------------------------


def _to_ts_code(symbol: str) -> tuple[str, str]:
    """Convert internal symbol -> (ts_code, market). market in {sh, sz, bj, hk}."""
    s = symbol.lower().strip()
    if s.startswith(("sh", "sz", "bj")):
        code, mkt = s[2:], s[:2]
    elif s.startswith("hk"):
        code, mkt = s[2:].zfill(5), "hk"
    elif s.startswith(("60", "68", "9")):
        code, mkt = s, "sh"
    elif s.startswith(("00", "30", "20")):
        code, mkt = s, "sz"
    elif s.startswith(("8", "4")):
        code, mkt = s, "bj"
    else:
        code, mkt = s.zfill(5), "hk"
    suffix = {"sh": ".SH", "sz": ".SZ", "bj": ".BJ", "hk": ".HK"}[mkt]
    return code + suffix, mkt


# Tushare expects YYYYMMDD; the route accepts both forms.
def _date(s: str) -> str:
    s = s.replace("-", "")
    return s


def _num_or_none(value: Any) -> float | None:
    if value is None or pd.isna(value):
        return None
    if isinstance(value, (int, float)):
        return float(value)
    matches = re.findall(r"-?\d+(?:\.\d+)?", str(value))
    if not matches:
        return None
    nums = [float(x) for x in matches]
    return sum(nums) / len(nums)


def _ak_consensus_eps(symbol: str) -> tuple[float | None, int | None]:
    """Fetch nearest annual EPS forecast from 同花顺 via akshare."""
    try:
        df = _with_retries(
            ak.stock_profit_forecast_ths,
            symbol=symbol,
            indicator="预测年报每股收益",
            attempts=2,
            base_delay=0.2,
        )
    except Exception:
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
            ak.stock_research_report_em,
            symbol=symbol,
            attempts=2,
            base_delay=0.2,
        )
    except Exception:
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


# Cache the stock_basic / hk_basic name lookups once per process startup.
_NAME_CACHE: dict[str, str] = {}


def _resolve_name(ts_code: str, market: str) -> str | None:
    if ts_code in _NAME_CACHE:
        return _NAME_CACHE[ts_code]
    try:
        if market == "hk":
            df = _pro.hk_basic(fields="ts_code,name")
        else:
            df = _pro.stock_basic(list_status="L", fields="ts_code,name")
    except Exception:
        return None
    if df is None or df.empty:
        return None
    for r in df.itertuples():
        _NAME_CACHE[r.ts_code] = r.name
    return _NAME_CACHE.get(ts_code)


# ---------- endpoints ------------------------------------------------------


@app.get("/health")
def health():
    return {"ok": True, "time": datetime.now().isoformat(), "source": "tushare"}


@app.get("/klines", response_model=list[Kline])
def klines(
    symbol: str = Query(..., description="e.g. sh600519, 000858, hk00700"),
    start: str = Query("20230101"),
    end: str | None = Query(None),
    adjust: str = Query("qfq", pattern="^(|qfq|hfq)$"),
):
    end = end or date.today().strftime("%Y%m%d")
    start, end = _date(start), _date(end)
    key = f"kline:{symbol}:{start}:{end}:{adjust}"
    cached = cache_get(key)
    if cached is not None:
        return cached

    ts_code, market = _to_ts_code(symbol)
    try:
        if market == "hk":
            # akshare for HK — Tushare's hk_daily is capped at 10/day.
            ak_code = ts_code.split(".")[0]  # "00700"
            df = _with_retries(
                ak.stock_hk_hist,
                symbol=ak_code, period="daily",
                start_date=start, end_date=end, adjust=(adjust or ""),
            )
        else:
            df = _with_retries(
                ts.pro_bar,
                ts_code=ts_code, adj=(adjust or None), start_date=start, end_date=end,
            )
    except Exception as e:
        raise HTTPException(502, f"upstream error: {e}") from e

    if df is None or df.empty:
        cache_put(key, [], 3600)
        return []

    if market == "hk":
        # akshare HK schema: 日期 / 开盘 / 最高 / 最低 / 收盘 / 成交量 ...
        df = df.rename(columns={
            "日期": "date", "开盘": "open", "最高": "high",
            "最低": "low", "收盘": "close", "成交量": "volume",
        })
        df["date"] = pd.to_datetime(df["date"]).dt.strftime("%Y-%m-%d")
        rows = df[["date", "open", "high", "low", "close", "volume"]].to_dict(orient="records")
    else:
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
    cache_put(key, rows, seconds_until_next_trading_close())
    return rows


@app.get("/fundamental", response_model=Fundamental)
def fundamental(symbol: str):
    key = f"fund:{symbol}"
    cached = cache_get(key)
    if cached is not None:
        return cached

    ts_code, market = _to_ts_code(symbol)
    out: dict[str, Any] = {"symbol": symbol, "name": _resolve_name(ts_code, market)}

    try:
        if market == "hk":
            # daily_basic is A-share only; for HK we leave fundamentals blank.
            cache_put(key, out, 24 * 3600)
            return out
        # Latest trading day's basic metrics. Pull last 5 days then take tail.
        today = date.today().strftime("%Y%m%d")
        start = (date.today() - timedelta(days=10)).strftime("%Y%m%d")
        df = _with_retries(
            _pro.daily_basic,
            ts_code=ts_code, start_date=start, end_date=today,
            fields="ts_code,trade_date,close,pe_ttm,pb,total_mv",
        )
    except Exception as e:
        raise HTTPException(502, f"tushare error: {e}") from e

    if df is not None and not df.empty:
        latest = df.sort_values("trade_date").iloc[-1]
        if pd.notna(latest.get("pe_ttm")):
            out["pe_ttm"] = float(latest["pe_ttm"])
        if pd.notna(latest.get("pb")):
            out["pb"] = float(latest["pb"])
        if pd.notna(latest.get("total_mv")):
            # tushare returns 万元 -> convert to 亿元
            out["market_cap"] = float(latest["total_mv"]) / 1e4

    cache_put(key, out, 24 * 3600)
    return out


@app.get("/analyst", response_model=Analyst)
def analyst(symbol: str):
    """Sell-side consensus from Tushare `report_rc` broker reports.

    Aggregates EPS forecasts for next fiscal year across recent analyst
    reports; implied target = consensus EPS * current PE(TTM).
    """
    key = f"analyst:{symbol}"
    cached = cache_get(key)
    if cached is not None:
        return cached

    ts_code, market = _to_ts_code(symbol)
    out: dict[str, Any] = {"symbol": symbol}
    if market == "hk":
        # report_rc covers A-share only.
        cache_put(key, out, 24 * 3600)
        return out

    # Always fetch most-recent close first so the UI can show current price even
    # when sell-side reports are absent or Tushare report_rc is rate-limited.
    pe_ttm: float | None = None
    try:
        today = date.today().strftime("%Y%m%d")
        start_d = (date.today() - timedelta(days=10)).strftime("%Y%m%d")
        db = _with_retries(
            _pro.daily_basic,
            ts_code=ts_code, start_date=start_d, end_date=today,
            fields="ts_code,trade_date,close,pe_ttm",
        )
        if db is not None and not db.empty:
            latest = db.sort_values("trade_date").iloc[-1]
            if pd.notna(latest.get("close")):
                out["current_price"] = round(float(latest["close"]), 3)
            if pd.notna(latest.get("pe_ttm")):
                pe_ttm = float(latest["pe_ttm"])
    except Exception:
        pass

    compact_symbol = ts_code.split(".")[0]
    research = _ak_research_consensus(compact_symbol)
    out.update(research)

    if out.get("consensus_eps_next") is None:
        eps, forecast_count = _ak_consensus_eps(compact_symbol)
        if eps is not None:
            out["consensus_eps_next"] = eps
            if forecast_count is not None and out.get("total_count") is None:
                out["total_count"] = forecast_count

    if out.get("consensus_eps_next") is not None and pe_ttm is not None:
        out["implied_target"] = round(out["consensus_eps_next"] * pe_ttm, 3)
        if out.get("current_price"):
            out["upside_pct"] = round(
                (out["implied_target"] / out["current_price"] - 1) * 100, 2
            )

    if out.get("implied_target") is not None and out.get("buy_count") is not None:
        cache_put(key, out, 24 * 3600)
        return out

    # Pull last ~180 days of broker reports.
    start = (date.today() - timedelta(days=180)).strftime("%Y%m%d")
    try:
        rc = _with_retries(_report_rc, ts_code=ts_code, start_date=start)
    except Exception as e:
        # Keep current_price usable; do not poison the cache for a full day
        # because rate-limit errors are transient.
        cache_put(key, out, 60)
        return out

    if rc is None or rc.empty:
        cache_put(key, out, 24 * 3600)
        return out

    out["total_count"] = int(len(rc))
    if "rating" in rc.columns:
        # tushare ratings: 买入/推荐/增持/中性/减持/卖出 etc.
        bullish = rc["rating"].isin(["买入", "推荐", "强烈推荐", "增持"]).sum()
        out["buy_count"] = int(bullish)
        out["buy_ratio"] = round(out["buy_count"] / out["total_count"], 3)

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

    # Prefer explicit sell-side target-price fields when Tushare provides them;
    # otherwise fall back to EPS * PE(TTM).
    target_cols = [c for c in rc.columns if str(c).lower() in {"target_price", "target", "tp"}]
    targets: list[float] = []
    for col in target_cols:
        targets.extend(x for x in (_num_or_none(v) for v in rc[col]) if x is not None and x > 0)
    if targets:
        out["implied_target"] = round(float(pd.Series(targets).median()), 3)
    elif out.get("consensus_eps_next") is not None and pe_ttm is not None:
        out["implied_target"] = round(out["consensus_eps_next"] * pe_ttm, 3)

    if out.get("implied_target") is not None and out.get("current_price"):
        out["upside_pct"] = round(
            (out["implied_target"] / out["current_price"] - 1) * 100, 2
        )

    cache_put(key, out, 24 * 3600)
    return out


@app.get("/spot")
def spot(symbol: str):
    """Most-recent close (Tushare Pro has no realtime quote). 30s cache."""
    key = f"spot:{symbol}"
    cached = cache_get(key)
    if cached is not None:
        return cached

    ts_code, market = _to_ts_code(symbol)
    start = (date.today() - timedelta(days=10)).strftime("%Y%m%d")
    end = date.today().strftime("%Y%m%d")
    try:
        if market == "hk":
            ak_code = ts_code.split(".")[0]
            df = _with_retries(
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
            df = _with_retries(_pro.daily, ts_code=ts_code, start_date=start, end_date=end)
            if df is None or df.empty:
                raise HTTPException(404, f"symbol {symbol} not found")
            df = df.sort_values("trade_date")
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(502, f"upstream error: {e}") from e
    r = df.iloc[-1]
    out = {
        "symbol": symbol,
        "name": _resolve_name(ts_code, market) or "",
        "price": float(r.get("close", 0) or 0),
        "change_pct": float(r.get("pct_chg", 0) or 0),
        "volume": float(r.get("vol", 0) or 0),
        "turnover": float(r.get("amount", 0) or 0),
    }
    cache_put(key, out, 30)
    return out
