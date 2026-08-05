"""Unit tests for /fundamental non-realtime latest_close warning."""
from __future__ import annotations

import unittest
from unittest.mock import patch

import main


class FundamentalLatestCloseWarningTest(unittest.TestCase):
    def test_stock_value_em_latest_close_adds_non_realtime_warning(self) -> None:
        stock_value = {
            "pe_ttm": 12.5,
            "pb": 2.1,
            "market_cap": 500.0,
            "latest_close": 88.8,
            "latest_date": "2026-08-01",
            "change_pct": 1.2,
        }
        with (
            patch("routes.fundamental.MOCK_MODE", False),
            patch("routes.fundamental.cache_get", return_value=None),
            patch("routes.fundamental.cache_put"),
            patch("routes.fundamental._ak_stock_value_row", return_value=stock_value),
            patch("routes.fundamental._ak_a_spot", return_value=None),
            patch("routes.fundamental._attach_profit_yoy"),
        ):
            out = main.fundamental("600519")

        self.assertEqual(out["latest_close"], 88.8)
        self.assertIn(
            "latest_close is latest daily close from AkShare stock_value_em, not realtime",
            out["warnings"],
        )

    def test_missing_latest_close_has_no_non_realtime_warning(self) -> None:
        stock_value = {
            "pe_ttm": 12.5,
            "pb": 2.1,
            "market_cap": 500.0,
            "latest_close": None,
            "latest_date": "2026-08-01",
            "change_pct": 1.2,
        }
        with (
            patch("routes.fundamental.MOCK_MODE", False),
            patch("routes.fundamental.cache_get", return_value=None),
            patch("routes.fundamental.cache_put"),
            patch("routes.fundamental._ak_stock_value_row", return_value=stock_value),
            patch("routes.fundamental._ak_a_spot", return_value=None),
            patch("routes.fundamental._attach_profit_yoy"),
        ):
            out = main.fundamental("600519")

        self.assertIsNone(out.get("latest_close"))
        self.assertNotIn(
            "latest_close is latest daily close from AkShare stock_value_em, not realtime",
            out["warnings"],
        )


if __name__ == "__main__":
    unittest.main()
