"""Health check endpoint."""
from __future__ import annotations

from datetime import datetime

from config import MARKET_ENABLE_TUSHARE_SECONDARY, MOCK_MODE


def health():
    return {
        "ok": True,
        "time": datetime.now().isoformat(),
        "source": "mock" if MOCK_MODE else ("akshare+baostock+tushare" if MARKET_ENABLE_TUSHARE_SECONDARY else "akshare+baostock"),
        "mock": MOCK_MODE,
        "a_share_quotes": "akshare_primary",
        "tushare_secondary_enabled": MARKET_ENABLE_TUSHARE_SECONDARY,
    }


def register(app):
    app.get("/health")(health)
