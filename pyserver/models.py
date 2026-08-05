"""Pydantic response models."""
from __future__ import annotations

from pydantic import BaseModel


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
    latest_close: float | None = None
    latest_date: str | None = None
    change_pct: float | None = None
    profit_yoy: float | None = None
    source: str | None = None
    fetched_at: str | None = None
    error: str | None = None
    warnings: list[str] | None = None
    field_sources: dict[str, str] | None = None


class Analyst(BaseModel):
    symbol: str
    buy_count: int | None = None
    total_count: int | None = None
    buy_ratio: float | None = None
    consensus_eps_next: float | None = None
    implied_target: float | None = None
    current_price: float | None = None
    upside_pct: float | None = None
    source: str | None = None
    fetched_at: str | None = None
    error: str | None = None
    warnings: list[str] | None = None
    field_sources: dict[str, str] | None = None


class Spot(BaseModel):
    symbol: str
    name: str
    price: float
    change_pct: float | None = None
    volume: float | None = None
    turnover: float | None = None
    source: str | None = None
    fetched_at: str | None = None
    warnings: list[str] | None = None
