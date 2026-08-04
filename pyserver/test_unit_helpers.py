"""Unit tests for pure helpers in main.py (no network)."""
from __future__ import annotations

import unittest
from datetime import datetime, timedelta
from unittest.mock import patch

import main


class ToTsCodeTest(unittest.TestCase):
    def test_a_share_sh_prefix(self) -> None:
        self.assertEqual(main._to_ts_code("600519"), ("600519.SH", "sh"))
        self.assertEqual(main._to_ts_code("688981"), ("688981.SH", "sh"))

    def test_a_share_sz_prefix(self) -> None:
        self.assertEqual(main._to_ts_code("000858"), ("000858.SZ", "sz"))
        self.assertEqual(main._to_ts_code("300750"), ("300750.SZ", "sz"))

    def test_bj_prefix(self) -> None:
        self.assertEqual(main._to_ts_code("830799"), ("830799.BJ", "bj"))

    def test_hk_prefix(self) -> None:
        self.assertEqual(main._to_ts_code("hk00700"), ("00700.HK", "hk"))

    def test_exchange_prefix_stripped(self) -> None:
        self.assertEqual(main._to_ts_code("SH600519"), ("600519.SH", "sh"))


class SecondsUntilNextTradingCloseTest(unittest.TestCase):
    def test_before_close_same_day(self) -> None:
        now = datetime(2026, 8, 4, 10, 0, 0)
        expected = int((now.replace(hour=15, minute=30) - now).total_seconds())
        with patch.object(main, "datetime") as mock_dt:
            mock_dt.now.return_value = now
            mock_dt.side_effect = lambda *a, **kw: datetime(*a, **kw)
            self.assertEqual(main.seconds_until_next_trading_close(), expected)

    def test_after_close_next_day(self) -> None:
        now = datetime(2026, 8, 4, 16, 0, 0)
        target = now.replace(hour=15, minute=30) + timedelta(days=1)
        expected = int((target - now).total_seconds())
        with patch.object(main, "datetime") as mock_dt:
            mock_dt.now.return_value = now
            mock_dt.side_effect = lambda *a, **kw: datetime(*a, **kw)
            self.assertEqual(main.seconds_until_next_trading_close(), expected)

    def test_exactly_at_close_rolls_to_next_day(self) -> None:
        now = datetime(2026, 8, 4, 15, 30, 0)
        target = now.replace(hour=15, minute=30) + timedelta(days=1)
        expected = int((target - now).total_seconds())
        with patch.object(main, "datetime") as mock_dt:
            mock_dt.now.return_value = now
            mock_dt.side_effect = lambda *a, **kw: datetime(*a, **kw)
            self.assertEqual(main.seconds_until_next_trading_close(), expected)


class SourceSummaryTest(unittest.TestCase):
    def test_empty_returns_unknown(self) -> None:
        self.assertEqual(main._source_summary({}), "unknown")

    def test_akshare_only(self) -> None:
        self.assertEqual(
            main._source_summary({"price": "akshare_spot"}),
            "akshare_primary",
        )

    def test_tushare_only(self) -> None:
        self.assertEqual(
            main._source_summary({"pe": "tushare_daily_basic"}),
            "tushare_only",
        )

    def test_baostock_only(self) -> None:
        self.assertEqual(
            main._source_summary({"close": "baostock_kline"}),
            "baostock_only",
        )

    def test_all_three_providers(self) -> None:
        self.assertEqual(
            main._source_summary(
                {
                    "price": "akshare_spot",
                    "close": "baostock_kline",
                    "pe": "tushare_daily_basic",
                }
            ),
            "akshare+baostock+tushare",
        )

    def test_akshare_and_tushare(self) -> None:
        self.assertEqual(
            main._source_summary(
                {"price": "akshare_spot", "pe": "tushare_daily_basic"}
            ),
            "akshare+tushare",
        )

    def test_akshare_and_baostock(self) -> None:
        self.assertEqual(
            main._source_summary(
                {"price": "akshare_spot", "close": "baostock_kline"}
            ),
            "akshare+baostock",
        )

    def test_baostock_and_tushare(self) -> None:
        self.assertEqual(
            main._source_summary(
                {"close": "baostock_kline", "pe": "tushare_daily_basic"}
            ),
            "baostock+tushare",
        )

    def test_derived_sources_ignored(self) -> None:
        self.assertEqual(
            main._source_summary(
                {"price": "akshare_spot", "ratio": "derived_pe_pb"}
            ),
            "akshare_primary",
        )

    def test_unrecognized_combo_returns_unknown(self) -> None:
        self.assertEqual(
            main._source_summary({"x": "other_provider_field"}),
            "unknown",
        )


if __name__ == "__main__":
    unittest.main()
