"""Deterministic mock market data for local dev when TUSHARE_TOKEN=mock."""
from __future__ import annotations

import hashlib
from datetime import date, datetime, timedelta
from typing import Any

BENCHMARKS: dict[str, tuple[str, str]] = {
    "csi300": ("000300.SH", "沪深300"),
    "star50": ("000688.SH", "科创50"),
    "csi500": ("000905.SH", "中证500"),
}


def _seed(symbol: str) -> int:
    return int(hashlib.sha256(symbol.encode()).hexdigest()[:8], 16)


def _parse_yyyymmdd(s: str) -> date:
    s = s.replace("-", "")
    return datetime.strptime(s[:8], "%Y%m%d").date()


def _iter_trading_days(start: date, end: date):
    d = start
    while d <= end:
        if d.weekday() < 5:
            yield d
        d += timedelta(days=1)


def mock_klines(symbol: str, start: str, end: str) -> list[dict[str, Any]]:
    seed = _seed(symbol)
    base = 20 + (seed % 500)
    start_d = _parse_yyyymmdd(start)
    end_d = _parse_yyyymmdd(end)
    rows: list[dict[str, Any]] = []
    price = float(base)
    for i, d in enumerate(_iter_trading_days(start_d, end_d)):
        drift = ((seed >> (i % 16)) & 7) - 3
        price = max(1.0, price * (1 + drift / 1000))
        rows.append(
            {
                "date": d.isoformat(),
                "open": round(price * 0.998, 3),
                "high": round(price * 1.01, 3),
                "low": round(price * 0.99, 3),
                "close": round(price, 3),
                "volume": float(1_000_000 + (seed % 100_000)),
            }
        )
    return rows


def mock_spot(symbol: str) -> dict[str, Any]:
    seed = _seed(symbol)
    price = 20 + (seed % 500)
    return {
        "symbol": symbol,
        "name": f"Mock-{symbol}",
        "price": float(price),
        "change_pct": float((seed % 21) - 10) / 10,
        "volume": float(1_000_000),
        "turnover": float(price * 1_000_000),
    }


def mock_fundamental(symbol: str) -> dict[str, Any]:
    seed = _seed(symbol)
    return {
        "symbol": symbol,
        "name": f"Mock-{symbol}",
        "pe_ttm": float(10 + seed % 80),
        "pb": float(1 + (seed % 50) / 10),
        "market_cap": float(50 + seed % 5000),
        "profit_yoy": float(5 + seed % 95),
    }


def mock_analyst(symbol: str) -> dict[str, Any]:
    spot = mock_spot(symbol)
    price = spot["price"]
    target = price * (1 + (_seed(symbol) % 30) / 100)
    return {
        "symbol": symbol,
        "buy_count": 3 + _seed(symbol) % 5,
        "total_count": 8,
        "buy_ratio": 0.6,
        "consensus_eps_next": round(price / 25, 4),
        "implied_target": round(target, 3),
        "current_price": price,
        "upside_pct": round((target / price - 1) * 100, 2),
    }
