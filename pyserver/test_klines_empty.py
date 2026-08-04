"""Unit tests for klines empty-window vs upstream-failure semantics (no network)."""
from __future__ import annotations

import unittest
from datetime import date, timedelta
from unittest.mock import patch

import pandas as pd
from fastapi import HTTPException

import main


class EmptyBarsTtlTest(unittest.TestCase):
    def test_open_window_short_ttl(self) -> None:
        today = date.today().strftime("%Y%m%d")
        self.assertEqual(main._empty_bars_ttl(today), 60)

    def test_closed_window_long_ttl(self) -> None:
        past = (date.today() - timedelta(days=30)).strftime("%Y%m%d")
        self.assertEqual(main._empty_bars_ttl(past), 24 * 3600)


class AkAHistDfEmptyTest(unittest.TestCase):
    def test_both_paths_empty_returns_empty_df_not_none(self) -> None:
        with patch("main._with_retries", side_effect=[pd.DataFrame(), pd.DataFrame()]):
            result = main._ak_a_hist_df("600519", "20230101", "20240101")
        self.assertIsNotNone(result)
        assert result is not None
        self.assertTrue(result.empty)

    def test_first_nonempty_skips_second(self) -> None:
        first = pd.DataFrame({"date": ["2024-01-02"], "open": [1.0]})
        with patch("main._with_retries", return_value=first) as mock_retries:
            result = main._ak_a_hist_df("600519", "20230101", "20240101")
        self.assertIs(result, first)
        mock_retries.assert_called_once()

    def test_first_empty_second_none_returns_empty_df(self) -> None:
        with patch("main._with_retries", side_effect=[pd.DataFrame(), None]):
            result = main._ak_a_hist_df("600519", "20230101", "20240101")
        self.assertIsNotNone(result)
        assert result is not None
        self.assertTrue(result.empty)

    def test_both_fail_returns_none(self) -> None:
        with patch("main._with_retries", side_effect=Exception("upstream")):
            result = main._ak_a_hist_df("600519", "20230101", "20240101")
        self.assertIsNone(result)


class KlinesEmptyResultTest(unittest.TestCase):
    def test_a_share_empty_df_returns_empty_list(self) -> None:
        with (
            patch.object(main, "MOCK_MODE", False),
            patch("main.cache_get", return_value=None),
            patch("main.cache_put"),
            patch("main._ak_a_hist_df", return_value=pd.DataFrame()),
        ):
            rows = main.klines(symbol="600519", start="20230101", end="20240101", adjust="qfq")
        self.assertEqual(rows, [])

    def test_a_share_all_none_returns_502(self) -> None:
        with (
            patch.object(main, "MOCK_MODE", False),
            patch("main.cache_get", return_value=None),
            patch("main._ak_a_hist_df", return_value=None),
            patch("main._baostock_hist_df", return_value=None),
            patch.object(main, "_pro", None),
            patch.object(main, "MARKET_ENABLE_TUSHARE_SECONDARY", False),
        ):
            with self.assertRaises(HTTPException) as ctx:
                main.klines(symbol="600519", start="20230101", end="20240101", adjust="qfq")
        self.assertEqual(ctx.exception.status_code, 502)


if __name__ == "__main__":
    unittest.main()
