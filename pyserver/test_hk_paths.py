"""Unit tests for HK klines/spot paths (mocked AkShare, no network)."""
from __future__ import annotations

import unittest
from unittest.mock import patch

import pandas as pd
from fastapi import HTTPException

import main


def _hk_hist_df() -> pd.DataFrame:
    return pd.DataFrame({
        "日期": ["2024-01-02", "2024-01-03"],
        "开盘": [300.0, 305.0],
        "最高": [310.0, 312.0],
        "最低": [295.0, 300.0],
        "收盘": [308.0, 311.0],
        "成交量": [1_000_000.0, 1_100_000.0],
        "成交额": [3.0e8, 3.2e8],
        "涨跌幅": [1.2, 0.97],
    })


class HkKlinesPathTest(unittest.TestCase):
    def test_hk_success_renames_columns_and_returns_rows(self) -> None:
        with (
            patch("routes.klines.MOCK_MODE", False),
            patch("routes.klines.cache_get", return_value=None),
            patch("routes.klines.cache_put") as cache_put,
            patch("routes.klines._with_retries", return_value=_hk_hist_df()),
        ):
            rows = main.klines(symbol="hk00700", start="20240101", end="20240131", adjust="qfq")
        self.assertEqual(len(rows), 2)
        self.assertEqual(rows[0]["date"], "2024-01-02")
        self.assertEqual(rows[0]["close"], 308.0)
        self.assertEqual(rows[1]["date"], "2024-01-03")
        cache_put.assert_called()

    def test_hk_empty_window_returns_empty_list(self) -> None:
        with (
            patch("routes.klines.MOCK_MODE", False),
            patch("routes.klines.cache_get", return_value=None),
            patch("routes.klines.cache_put") as cache_put,
            patch("routes.klines._with_retries", return_value=pd.DataFrame()),
        ):
            rows = main.klines(symbol="hk00700", start="20240101", end="20240131", adjust="")
        self.assertEqual(rows, [])
        cache_put.assert_called()

    def test_hk_upstream_failure_returns_502(self) -> None:
        with (
            patch("routes.klines.MOCK_MODE", False),
            patch("routes.klines.cache_get", return_value=None),
            patch("routes.klines.cache_put"),
            patch("routes.klines._with_retries", side_effect=RuntimeError("akshare down")),
        ):
            with self.assertRaises(HTTPException) as ctx:
                main.klines(symbol="hk00700", start="20240101", end="20240131", adjust="")
        self.assertEqual(ctx.exception.status_code, 502)


class HkSpotPathTest(unittest.TestCase):
    def test_hk_spot_uses_hist_close_without_ashare_realtime_warning(self) -> None:
        with (
            patch("routes.spot.MOCK_MODE", False),
            patch("routes.spot.cache_get", return_value=None),
            patch("routes.spot.cache_put"),
            patch("routes.spot._with_retries", return_value=_hk_hist_df()),
            patch("routes.spot._resolve_name", return_value="腾讯控股"),
        ):
            out = main.spot(symbol="hk00700")
        self.assertEqual(out["symbol"], "hk00700")
        self.assertEqual(out["price"], 311.0)
        self.assertEqual(out["source"], "akshare-hk-hist")
        self.assertNotIn(
            "Eastmoney realtime unavailable; returned Tushare latest daily close, not realtime",
            out["warnings"],
        )

    def test_hk_spot_empty_hist_returns_404(self) -> None:
        with (
            patch("routes.spot.MOCK_MODE", False),
            patch("routes.spot.cache_get", return_value=None),
            patch("routes.spot.cache_put"),
            patch("routes.spot._with_retries", return_value=pd.DataFrame()),
        ):
            with self.assertRaises(HTTPException) as ctx:
                main.spot(symbol="hk00700")
        self.assertEqual(ctx.exception.status_code, 404)


if __name__ == "__main__":
    unittest.main()
