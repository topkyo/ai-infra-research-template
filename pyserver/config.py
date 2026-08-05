"""Environment bootstrap and module-level configuration."""
from __future__ import annotations

import logging
import os
from pathlib import Path

from dotenv import load_dotenv

load_dotenv(Path(__file__).parent / ".env")

logging.basicConfig(
    level=os.environ.get("PYSERVER_LOG_LEVEL", "INFO").upper(),
    format="%(asctime)s %(levelname)s %(name)s %(message)s",
)
log = logging.getLogger("pyserver")

MARKET_HTTP_PROXY = os.environ.get("MARKET_HTTP_PROXY", "").strip()


def _strip_proxy_env() -> None:
    """Use MARKET_HTTP_PROXY when set (VPN); else drop broken inherited proxies."""
    for key in (
        "HTTP_PROXY",
        "HTTPS_PROXY",
        "ALL_PROXY",
        "http_proxy",
        "https_proxy",
        "all_proxy",
    ):
        os.environ.pop(key, None)
    if MARKET_HTTP_PROXY:
        os.environ["HTTP_PROXY"] = MARKET_HTTP_PROXY
        os.environ["HTTPS_PROXY"] = MARKET_HTTP_PROXY
        return
    os.environ.setdefault(
        "NO_PROXY",
        "localhost,127.0.0.1,::1,push2.eastmoney.com,push2his.eastmoney.com,.eastmoney.com,hq.sinajs.cn,.sinajs.cn",
    )


_strip_proxy_env()
TUSHARE_TOKEN = os.environ.get("TUSHARE_TOKEN", "").strip()
MOCK_MODE = TUSHARE_TOKEN.lower() == "mock"
HAS_TUSHARE_TOKEN = TUSHARE_TOKEN.lower() not in {"", "mock", "your-tushare-pro-token-here"}
STRICT_LIVE_DATA = os.environ.get("STRICT_LIVE_DATA", "0").strip() == "1"
MARKET_ENABLE_TUSHARE_SECONDARY = os.environ.get("MARKET_ENABLE_TUSHARE_SECONDARY", "0").strip() == "1"
if STRICT_LIVE_DATA and MOCK_MODE:
    raise RuntimeError("STRICT_LIVE_DATA=1 requires a real TUSHARE_TOKEN")
if MARKET_ENABLE_TUSHARE_SECONDARY and not HAS_TUSHARE_TOKEN:
    raise RuntimeError("MARKET_ENABLE_TUSHARE_SECONDARY=1 requires a real TUSHARE_TOKEN")
CACHE_NAMESPACE = "mock" if MOCK_MODE else "live"
NEGATIVE_CACHE = {"__negative_cache__": True}
_QUOTE_SOURCE_KEY = "_quote_source"
