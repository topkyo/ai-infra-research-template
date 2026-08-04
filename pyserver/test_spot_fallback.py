"""Unit tests for Sina hq.sinajs spot fallback (no network)."""
from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from unittest import mock
from unittest.mock import patch

import pandas as pd
from fastapi import HTTPException

import cache as cache_mod
from main import (
    Spot,
    _QUOTE_SOURCE_KEY,
    _ak_a_spot,
    _spot_api_source_from_row,
    _spot_warnings_from_row,
    parse_sina_hq_text,
    spot,
)


class ParseSinaHqTextTest(unittest.TestCase):
    def test_parses_price_and_change_pct(self) -> None:
        text = 'var hq_str_sh688256="寒武纪-U,100.0,1100.0,1310.0,1320.0,1300.0,0,0,5000000,1000000000";'
        row = parse_sina_hq_text(text, "688256")
        self.assertIsNotNone(row)
        assert row is not None
        self.assertEqual(row["最新价"], 1310.0)
        self.assertAlmostEqual(row["涨跌幅"], (1310.0 - 1100.0) / 1100.0 * 100, places=4)
        self.assertEqual(row["成交量"], 5000000.0)

    def test_missing_prev_close_yields_none_change_pct(self) -> None:
        text = 'var hq_str_sh688256="寒武纪-U,100.0,,1310.0,1320.0,1300.0,0,0,5000000,1000000000";'
        row = parse_sina_hq_text(text, "688256")
        self.assertIsNotNone(row)
        assert row is not None
        self.assertEqual(row["最新价"], 1310.0)
        self.assertIsNone(row["涨跌幅"])

    def test_rejects_empty_body(self) -> None:
        self.assertIsNone(parse_sina_hq_text('var hq_str_sh688256="";', "688256"))


class SpotMetadataTest(unittest.TestCase):
    def test_sina_source_no_warning_when_fields_present(self) -> None:
        row = {
            "最新价": 1.0,
            "涨跌幅": 1.5,
            "成交量": 100.0,
            "成交额": 200.0,
            _QUOTE_SOURCE_KEY: "sina_hq_sinajs",
        }
        self.assertEqual(_spot_api_source_from_row(row), "sina-hq-realtime")
        self.assertEqual(_spot_warnings_from_row(row), [])

    def test_missing_change_pct_adds_warning(self) -> None:
        row = {
            "最新价": 1.0,
            "涨跌幅": None,
            "成交量": 100.0,
            "成交额": 200.0,
            _QUOTE_SOURCE_KEY: "sina_hq_sinajs",
        }
        warnings = _spot_warnings_from_row(row)
        self.assertIn("change_pct unavailable from upstream", warnings)
        self.assertNotIn("volume unavailable from upstream", warnings)

    def test_eastmoney_no_warning(self) -> None:
        row = {
            "最新价": 1.0,
            "涨跌幅": 0.5,
            "成交量": 1.0,
            "成交额": 2.0,
            _QUOTE_SOURCE_KEY: "akshare_eastmoney",
        }
        self.assertEqual(_spot_api_source_from_row(row), "eastmoney")
        self.assertEqual(_spot_warnings_from_row(row), [])


class AkASpotFallbackTest(unittest.TestCase):
    def test_push2_then_sina(self) -> None:
        sina_row = {
            "代码": "688256",
            "名称": "寒武纪-U",
            "最新价": 1310.0,
            "涨跌幅": 1.5,
            "成交量": 0,
            "成交额": 0,
            _QUOTE_SOURCE_KEY: "sina_hq_sinajs",
        }
        with patch("main._ak_a_spot_rows", return_value=None), patch(
            "main._sina_a_spot_rows",
            return_value=sina_row,
        ):
            row = _ak_a_spot("688256.SH", "sh")
        self.assertIsNotNone(row)
        assert row is not None
        self.assertEqual(row[_QUOTE_SOURCE_KEY], "sina_hq_sinajs")


class SpotEndpointContractTest(unittest.TestCase):
    def setUp(self) -> None:
        self._tmpdir = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmpdir.cleanup)
        self._cache_patch = patch.object(cache_mod, "DB_PATH", Path(self._tmpdir.name) / "cache.db")
        self._cache_patch.start()
        self.addCleanup(self._cache_patch.stop)

    def test_missing_price_returns_502(self) -> None:
        ak_row = {
            "代码": "688256",
            "名称": "寒武纪-U",
            "最新价": None,
            "涨跌幅": 1.5,
            "成交量": 100.0,
            "成交额": 200.0,
            _QUOTE_SOURCE_KEY: "akshare_eastmoney",
        }
        with patch("main.MOCK_MODE", False), patch("main._ak_a_spot", return_value=ak_row), patch(
            "main._ak_stock_value_row",
            return_value=None,
        ), patch("main._ak_a_spot_from_hist", return_value=None), patch(
            "main._pro",
            None,
        ), patch("main.MARKET_ENABLE_TUSHARE_SECONDARY", False):
            with self.assertRaises(HTTPException) as ctx:
                spot("sh688256")
            self.assertEqual(ctx.exception.status_code, 502)

    def test_missing_change_pct_returns_null_with_warning(self) -> None:
        ak_row = {
            "代码": "688256",
            "名称": "寒武纪-U",
            "最新价": 1310.0,
            "涨跌幅": None,
            "成交量": 100.0,
            "成交额": 200.0,
            _QUOTE_SOURCE_KEY: "sina_hq_sinajs",
        }
        with patch("main.MOCK_MODE", False), patch("main._ak_a_spot", return_value=ak_row), patch(
            "main._resolve_name",
            return_value="寒武纪-U",
        ):
            out = spot("sh688256")
        validated = Spot.model_validate(out)
        self.assertEqual(validated.price, 1310.0)
        self.assertIsNone(validated.change_pct)
        self.assertNotEqual(validated.change_pct, 0)
        self.assertIn("change_pct unavailable from upstream", validated.warnings or [])

    def test_terminal_path_missing_close_returns_502(self) -> None:
        df = pd.DataFrame(
            [{"trade_date": "20260801", "close": None, "pct_chg": 1.0, "vol": 100.0, "amount": 200.0}],
        )
        mock_pro = mock.MagicMock()
        with patch("main.MOCK_MODE", False), patch("main._ak_a_spot", return_value=None), patch(
            "main._ak_stock_value_row",
            return_value=None,
        ), patch("main._ak_a_spot_from_hist", return_value=None), patch(
            "main._with_retries",
            return_value=df,
        ), patch("main._pro", mock_pro), patch("main.MARKET_ENABLE_TUSHARE_SECONDARY", True):
            with self.assertRaises(HTTPException) as ctx:
                spot("sh688256")
            self.assertEqual(ctx.exception.status_code, 502)
            self.assertIn("unavailable", str(ctx.exception.detail).lower())


if __name__ == "__main__":
    unittest.main()
