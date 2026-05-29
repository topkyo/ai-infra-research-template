"""Unit tests for Sina hq.sinajs spot fallback (no network)."""
from __future__ import annotations

import unittest
from unittest.mock import patch

from main import (
    _QUOTE_SOURCE_KEY,
    _ak_a_spot,
    _spot_api_source_from_row,
    _spot_warnings_from_row,
    parse_sina_hq_text,
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

    def test_rejects_empty_body(self) -> None:
        self.assertIsNone(parse_sina_hq_text('var hq_str_sh688256="";', "688256"))


class SpotMetadataTest(unittest.TestCase):
    def test_sina_source_no_warning(self) -> None:
        row = {"最新价": 1.0, _QUOTE_SOURCE_KEY: "sina_hq_sinajs"}
        self.assertEqual(_spot_api_source_from_row(row), "sina-hq-realtime")
        self.assertEqual(_spot_warnings_from_row(row), [])

    def test_eastmoney_no_warning(self) -> None:
        row = {"最新价": 1.0, _QUOTE_SOURCE_KEY: "akshare_eastmoney"}
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


if __name__ == "__main__":
    unittest.main()
