"""Unit tests for benchmark klines empty-window vs upstream-failure semantics (no network)."""
from __future__ import annotations

import unittest
from unittest.mock import MagicMock, patch

import pandas as pd
from fastapi import HTTPException

import main


def _mock_pro() -> MagicMock:
    pro = MagicMock()
    pro.index_daily = MagicMock()
    return pro


class BenchmarkKlinesEmptyResultTest(unittest.TestCase):
    def test_akshare_filtered_empty_tushare_fail_returns_empty_list(self) -> None:
        """N3: non-empty AkShare filtered to empty, then Tushare fails → 200 [] not 502."""
        ak_df = pd.DataFrame({
            "date": ["2019-01-02", "2019-01-03"],
            "open": [3000.0, 3010.0],
            "high": [3010.0, 3020.0],
            "low": [2990.0, 3000.0],
            "close": [3005.0, 3015.0],
            "volume": [1e9, 1.1e9],
        })
        with (
            patch("routes.benchmarks.MOCK_MODE", False),
            patch("routes.benchmarks.cache_get", return_value=None),
            patch("routes.benchmarks.cache_put") as mock_cache_put,
            patch(
                "routes.benchmarks._with_retries",
                side_effect=[ak_df, RuntimeError("tushare down")],
            ),
            patch("routes.benchmarks._pro", _mock_pro()),
            patch("routes.benchmarks.MARKET_ENABLE_TUSHARE_SECONDARY", True),
        ):
            rows = main.benchmark_klines(index="csi300", start="20230101", end="20240101")
        self.assertEqual(rows, [])
        mock_cache_put.assert_called_once()
        self.assertEqual(mock_cache_put.call_args[0][1], [])

    def test_all_sources_none_returns_502(self) -> None:
        with (
            patch("routes.benchmarks.MOCK_MODE", False),
            patch("routes.benchmarks.cache_get", return_value=None),
            patch("routes.benchmarks._with_retries", return_value=None),
            patch("routes.benchmarks._pro", _mock_pro()),
            patch("routes.benchmarks.MARKET_ENABLE_TUSHARE_SECONDARY", True),
        ):
            with self.assertRaises(HTTPException) as ctx:
                main.benchmark_klines(index="csi300", start="20230101", end="20240101")
        self.assertEqual(ctx.exception.status_code, 502)

    def test_akshare_empty_no_tushare_returns_empty_list(self) -> None:
        with (
            patch("routes.benchmarks.MOCK_MODE", False),
            patch("routes.benchmarks.cache_get", return_value=None),
            patch("routes.benchmarks.cache_put"),
            patch("routes.benchmarks._with_retries", return_value=pd.DataFrame()),
            patch("routes.benchmarks._pro", None),
            patch("routes.benchmarks.MARKET_ENABLE_TUSHARE_SECONDARY", False),
        ):
            rows = main.benchmark_klines(index="csi300", start="20230101", end="20240101")
        self.assertEqual(rows, [])

    def test_akshare_exception_tushare_fail_returns_502(self) -> None:
        with (
            patch("routes.benchmarks.MOCK_MODE", False),
            patch("routes.benchmarks.cache_get", return_value=None),
            patch(
                "routes.benchmarks._with_retries",
                side_effect=[RuntimeError("akshare down"), RuntimeError("tushare down")],
            ),
            patch("routes.benchmarks._pro", _mock_pro()),
            patch("routes.benchmarks.MARKET_ENABLE_TUSHARE_SECONDARY", True),
        ):
            with self.assertRaises(HTTPException) as ctx:
                main.benchmark_klines(index="csi300", start="20230101", end="20240101")
        self.assertEqual(ctx.exception.status_code, 502)


if __name__ == "__main__":
    unittest.main()
