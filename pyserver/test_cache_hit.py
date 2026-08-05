"""Endpoint-level cache hit tests: second call must not reach upstream mocks."""
from __future__ import annotations

import tempfile
import unittest
from datetime import date
from pathlib import Path
from unittest.mock import patch

import cache as cache_mod
import main
import pandas as pd
from analyst import analyst


class EndpointCacheHitTest(unittest.TestCase):
    def setUp(self) -> None:
        self._tmpdir = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmpdir.cleanup)
        self._cache_patch = patch.object(cache_mod, "DB_PATH", Path(self._tmpdir.name) / "cache.db")
        self._cache_patch.start()
        self.addCleanup(self._cache_patch.stop)
        cache_mod._init_db()

    def test_spot_second_call_hits_cache(self) -> None:
        ak_row = {
            "代码": "600519",
            "名称": "贵州茅台",
            "最新价": 1800.0,
            "涨跌幅": 1.0,
            "成交量": 100.0,
            "成交额": 200.0,
            main._QUOTE_SOURCE_KEY: "akshare_eastmoney",
        }
        with patch("routes.spot.MOCK_MODE", False), patch(
            "routes.spot._ak_a_spot", side_effect=[ak_row, AssertionError("upstream called twice")],
        ) as mock_ak:
            main.spot("600519")
            main.spot("600519")
        self.assertEqual(mock_ak.call_count, 1)

    def test_fundamental_second_call_hits_cache(self) -> None:
        stock_value = {
            "pe_ttm": 30.0,
            "pb": 5.0,
            "market_cap": 1000.0,
            "latest_close": 1800.0,
            "latest_date": "2026-08-01",
            "change_pct": 1.0,
        }
        with patch("routes.fundamental.MOCK_MODE", False), patch(
            "routes.fundamental._ak_stock_value_row", side_effect=[stock_value, AssertionError("upstream called twice")],
        ) as mock_sv, patch("routes.fundamental._ak_a_spot", return_value=None), patch(
            "routes.fundamental._attach_profit_yoy",
        ):
            main.fundamental("600519")
            main.fundamental("600519")
        self.assertEqual(mock_sv.call_count, 1)

    def test_klines_second_call_hits_cache(self) -> None:
        df = pd.DataFrame(
            [
                {
                    "日期": "2026-08-01",
                    "开盘": 1.0,
                    "最高": 2.0,
                    "最低": 0.5,
                    "收盘": 1.5,
                    "成交量": 100.0,
                },
            ],
        )
        with patch("routes.klines.MOCK_MODE", False), patch(
            "routes.klines._ak_a_hist_df", side_effect=[df, AssertionError("upstream called twice")],
        ) as mock_hist:
            main.klines(symbol="600519", start="20260801", end="20260801", adjust="qfq")
            main.klines(symbol="600519", start="20260801", end="20260801", adjust="qfq")
        self.assertEqual(mock_hist.call_count, 1)

    def test_analyst_second_call_hits_cache(self) -> None:
        ak_spot = {
            "最新价": 10.0,
            main._QUOTE_SOURCE_KEY: "akshare_eastmoney",
        }
        research = {"buy_count": 3, "total_count": 5, "consensus_eps_next": 1.0}
        with patch.object(main, "MOCK_MODE", False), patch.object(
            main, "_ak_a_spot", side_effect=[ak_spot, AssertionError("upstream called twice")],
        ) as mock_spot, patch.object(main, "_ak_stock_value_row", return_value=None), patch.object(
            main, "_ak_a_spot_from_hist", return_value=None,
        ), patch.object(main, "_ak_research_consensus", return_value=research), patch.object(
            main, "_ak_consensus_eps", return_value=(1.0, 5),
        ):
            analyst("600519")
            analyst("600519")
        self.assertEqual(mock_spot.call_count, 1)

    def test_benchmark_klines_second_call_hits_cache(self) -> None:
        df = pd.DataFrame(
            [
                {
                    "date": "2026-08-01",
                    "open": 4000.0,
                    "high": 4010.0,
                    "low": 3990.0,
                    "close": 4005.0,
                    "volume": 1e9,
                },
            ],
        )
        with patch("routes.benchmarks.MOCK_MODE", False), patch(
            "routes.benchmarks._ak_call", side_effect=[df, AssertionError("upstream called twice")],
        ) as mock_ak:
            main.benchmark_klines(index="csi300", start="20260801", end="20260801")
            main.benchmark_klines(index="csi300", start="20260801", end="20260801")
        self.assertEqual(mock_ak.call_count, 1)


if __name__ == "__main__":
    unittest.main()
