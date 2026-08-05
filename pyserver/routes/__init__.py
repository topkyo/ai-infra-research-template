"""FastAPI route registration for core market-data endpoints."""
from __future__ import annotations

from . import benchmarks, fundamental, health, klines, spot


def register_routes(app) -> None:
    """Register all core routes (analyst routes registered separately in main)."""
    health.register(app)
    klines.register(app)
    fundamental.register(app)
    spot.register(app)
    benchmarks.register(app)
