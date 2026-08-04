"""Cache key normalization: aliases share ts_code keys; symbol echoes request."""
from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import cache as cache_mod
import main
import pandas as pd
from analyst import analyst


class CacheAliasTest(unittest.TestCase):
    def setUp(self) -> None:
        self._tmpdir = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmpdir.cleanup)
        self._cache_patch = patch.object(cache_mod, "DB_PATH", Path(self._tmpdir.name) / "cache.db")
        self._cache_patch.start()
        self.addCleanup(self._cache_patch.stop)

    def test_spot_alias_hits_same_cache_and_echoes_symbol(self) -> None:
        ak_row = {
            "代码": "600519",
            "名称": "贵州茅台",
            "最新价": 1800.0,
            "涨跌幅": 1.0,
            "成交量": 100.0,
            "成交额": 200.0,
            main._QUOTE_SOURCE_KEY: "akshare_eastmoney",
        }
        with patch.object(main, "MOCK_MODE", False), patch.object(
            main, "_ak_a_spot", side_effect=[ak_row, AssertionError("upstream called twice")],
        ) as mock_ak:
            first = main.spot("sh600519")
            second = main.spot("600519.SH")
        self.assertEqual(mock_ak.call_count, 1)
        self.assertEqual(first["symbol"], "sh600519")
        self.assertEqual(second["symbol"], "600519.SH")
        self.assertEqual(first["price"], second["price"])

    def test_fundamental_alias_hits_same_cache_and_echoes_symbol(self) -> None:
        stock_value = {
            "pe_ttm": 30.0,
            "pb": 5.0,
            "market_cap": 1000.0,
            "latest_close": 1800.0,
            "latest_date": "2026-08-01",
            "change_pct": 1.0,
        }
        with patch.object(main, "MOCK_MODE", False), patch.object(
            main, "_ak_stock_value_row", side_effect=[stock_value, AssertionError("upstream called twice")],
        ), patch.object(main, "_ak_a_spot", return_value=None), patch.object(
            main, "_attach_profit_yoy",
        ):
            first = main.fundamental("600519")
            second = main.fundamental("sh600519")
        self.assertEqual(first["symbol"], "600519")
        self.assertEqual(second["symbol"], "sh600519")
        self.assertEqual(first["pe_ttm"], second["pe_ttm"])

    def test_klines_alias_hits_same_cache(self) -> None:
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
        with patch.object(main, "MOCK_MODE", False), patch.object(
            main, "_ak_a_hist_df", side_effect=[df, AssertionError("upstream called twice")],
        ) as mock_hist:
            first = main.klines(symbol="600519", start="20260801", end="20260801", adjust="qfq")
            second = main.klines(symbol="sh600519", start="20260801", end="20260801", adjust="qfq")
        self.assertEqual(mock_hist.call_count, 1)
        self.assertEqual(first, second)

    def test_analyst_alias_hits_same_cache_and_echoes_symbol(self) -> None:
        ak_spot = {
            "最新价": 10.0,
            main._QUOTE_SOURCE_KEY: "akshare_eastmoney",
        }
        research = {"buy_count": 3, "total_count": 5, "consensus_eps_next": 1.0}
        with patch.object(main, "MOCK_MODE", False), patch.object(
            main, "_ak_a_spot", side_effect=[ak_spot, AssertionError("upstream called twice")],
        ), patch.object(main, "_ak_stock_value_row", return_value=None), patch.object(
            main, "_ak_a_spot_from_hist", return_value=None,
        ), patch.object(main, "_ak_research_consensus", return_value=research), patch.object(
            main, "_ak_consensus_eps", return_value=(1.0, 5),
        ):
            first = analyst("600519")
            second = analyst("sh600519")
        self.assertEqual(first["symbol"], "600519")
        self.assertEqual(second["symbol"], "sh600519")
        self.assertEqual(first["current_price"], second["current_price"])


if __name__ == "__main__":
    unittest.main()
