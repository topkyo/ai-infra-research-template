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

# Core endpoints live in routes/; re-exported here so main.klines(...) and
# TestClient(main.app) keep working for existing tests and callers.
from routes import register_routes  # noqa: E402
from routes.benchmarks import benchmark_klines, list_benchmarks  # noqa: E402
from routes.fundamental import fundamental  # noqa: E402
from routes.health import health  # noqa: E402
from routes.klines import klines  # noqa: E402
from routes.spot import spot  # noqa: E402

register_routes(app)

# Register extracted analyst routes last so existing route ordering is kept.
register_analyst_routes(app, Analyst)
