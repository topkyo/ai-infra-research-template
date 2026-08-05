"""FastAPI sidecar wrapping free-first market data providers.

Composition root: wires config, cache, providers, routes, and analyst endpoints.
Business logic lives in routes/, providers/, analyst.py; names are re-exported
here so existing tests and callers keep working via ``import main``.
"""
from __future__ import annotations

import config  # noqa: F401 — load .env and proxy env before cache import

from fastapi import FastAPI

from config import (  # noqa: F401
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
from util import (  # noqa: F401
    _ak_col,
    _empty_bars_ttl,
    _market_cap_to_yi,
    _num_or_none,
    _source_summary,
    seconds_until_next_trading_close,
)
from http_util import (  # noqa: F401
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
from models import Analyst, Fundamental, Kline, Spot  # noqa: F401
from symbols import (  # noqa: F401
    _cache_ts_code,
    _compact_code,
    _eastmoney_market_code,
    _echo_request_symbol,
    _infer_market_prefix,
    _to_ts_code,
)

# Cache lives in cache.py; importing here (after .env is loaded) resolves
# DB_PATH and runs _init_db() once.
import cache as cache_mod  # noqa: E402
from cache import (  # noqa: E402, F401
    CACHE_MAX_ROWS,
    DB_PATH,
    SCHEMA,
    _init_db,
    cache_get,
    cache_prune,
    cache_put,
    db,
)

cache_mod.CACHE_NAMESPACE = config.CACHE_NAMESPACE

from mock_data import BENCHMARKS  # noqa: E402, F401
if MOCK_MODE:
    from mock_data import (  # noqa: E402, F401
        mock_analyst,
        mock_fundamental,
        mock_klines,
        mock_spot,
    )

from providers.akshare_analyst import (  # noqa: E402, F401
    _ak_consensus_eps,
    _ak_research_consensus,
    _ak_stock_value_row,
)
from providers.akshare_hist import (  # noqa: E402, F401
    _AK_HIST_RENAME,
    _ak_a_hist_df,
    _rows_from_ak_hist,
)
from providers.akshare_spot import (  # noqa: E402, F401
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
from providers.baostock_api import (  # noqa: E402, F401
    _baostock_code,
    _baostock_growth_yoy,
    _baostock_hist_df,
    _baostock_login,
    _baostock_logout,
    _rows_from_baostock_hist,
)
from providers.tushare_api import (  # noqa: E402, F401
    _attach_profit_yoy,
    _daily_basic,
    _fina_indicator,
    _latest_profit_yoy,
    _pro,
    _report_rc,
)

from validation import (  # noqa: E402, F401
    _DATE_MIN,
    _SYMBOL_MAX_LEN,
    _SYMBOL_RE,
    _validate_date,
    _validate_date_range,
    _validate_symbol,
)

from analyst import register_routes as register_analyst_routes  # noqa: E402
from routes import register_routes  # noqa: E402
from routes.benchmarks import benchmark_klines, list_benchmarks  # noqa: F401
from routes.fundamental import fundamental  # noqa: F401
from routes.health import health  # noqa: F401
from routes.klines import klines  # noqa: F401
from routes.spot import spot  # noqa: F401

app = FastAPI(title="topkyo pyserver", version="0.2.0")

register_routes(app)
register_analyst_routes(app, Analyst)
