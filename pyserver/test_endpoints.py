"""FastAPI TestClient integration tests for success, warning, and error paths."""
from __future__ import annotations

import json
import sqlite3
import tempfile
import unittest
from datetime import date, timedelta
from pathlib import Path
from unittest.mock import patch

import cache as cache_mod
import main
import pandas as pd
from fastapi.testclient import TestClient

client = TestClient(main.app)


def _cache_rows(db_path: Path) -> list[tuple[str, str, int]]:
    conn = sqlite3.connect(db_path)
    try:
        return conn.execute(
            "SELECT key, payload, ttl_seconds FROM cache ORDER BY key",
        ).fetchall()
    finally:
        conn.close()


class EndpointIntegrationTest(unittest.TestCase):
    def setUp(self) -> None:
        self._tmpdir = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmpdir.cleanup)
        self._db_path = Path(self._tmpdir.name) / "cache.db"
        self._cache_patch = patch.object(cache_mod, "DB_PATH", self._db_path)
        self._cache_patch.start()
        self.addCleanup(self._cache_patch.stop)
        cache_mod._init_db()

    def test_klines_success_returns_bars(self) -> None:
        df = pd.DataFrame(
            [
                {
                    "日期": "2026-08-01",
                    "开盘": 100.0,
                    "最高": 101.0,
                    "最低": 99.0,
                    "收盘": 100.5,
                    "成交量": 1000.0,
                },
            ],
        )
        with patch("routes.klines.MOCK_MODE", False), patch("routes.klines._ak_a_hist_df", return_value=df):
            resp = client.get(
                "/klines",
                params={"symbol": "600519", "start": "20260801", "end": "20260801"},
            )
        self.assertEqual(resp.status_code, 200)
        body = resp.json()
        self.assertEqual(len(body), 1)
        self.assertEqual(body[0]["close"], 100.5)

    def test_klines_all_sources_fail_returns_502_without_empty_cache(self) -> None:
        with (
            patch("routes.klines.MOCK_MODE", False),
            patch("routes.klines._ak_a_hist_df", return_value=None),
            patch("routes.klines._baostock_hist_df", return_value=None),
            patch("routes.klines._pro", None),
            patch("routes.klines.MARKET_ENABLE_TUSHARE_SECONDARY", False),
        ):
            resp = client.get(
                "/klines",
                params={"symbol": "600519", "start": "20230101", "end": "20240101"},
            )
        self.assertEqual(resp.status_code, 502)
        rows = _cache_rows(self._db_path)
        for _key, payload, _ttl in rows:
            self.assertNotEqual(json.loads(payload), [])

    def test_klines_genuine_empty_returns_200_with_empty_bars_ttl(self) -> None:
        past_end = (date.today() - timedelta(days=30)).strftime("%Y%m%d")
        expected_ttl = main._empty_bars_ttl(past_end)
        with (
            patch("routes.klines.MOCK_MODE", False),
            patch("routes.klines._ak_a_hist_df", return_value=pd.DataFrame()),
            patch("routes.klines._baostock_hist_df", return_value=pd.DataFrame()),
            patch("routes.klines._pro", None),
            patch("routes.klines.MARKET_ENABLE_TUSHARE_SECONDARY", False),
        ):
            resp = client.get(
                "/klines",
                params={"symbol": "600519", "start": "20230101", "end": past_end},
            )
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(resp.json(), [])
        rows = _cache_rows(self._db_path)
        self.assertEqual(len(rows), 1)
        _key, payload, ttl = rows[0]
        self.assertEqual(json.loads(payload), [])
        self.assertEqual(ttl, expected_ttl)

    def test_fundamental_missing_core_fields_returns_502(self) -> None:
        stock_value = {
            "pe_ttm": None,
            "pb": None,
            "market_cap": None,
            "latest_close": 88.8,
            "latest_date": "2026-08-01",
            "change_pct": 1.2,
        }
        with (
            patch("routes.fundamental.MOCK_MODE", False),
            patch("routes.fundamental._ak_stock_value_row", return_value=stock_value),
            patch("routes.fundamental._ak_a_spot", return_value=None),
            patch("routes.fundamental._attach_profit_yoy"),
            patch("routes.fundamental.MARKET_ENABLE_TUSHARE_SECONDARY", False),
        ):
            resp = client.get("/fundamental", params={"symbol": "600519"})
        self.assertEqual(resp.status_code, 502)
        self.assertIn("missing", resp.json()["detail"].lower())

    def test_spot_fallback_ladder_includes_sina(self) -> None:
        sina_row = {
            "代码": "688256",
            "名称": "寒武纪-U",
            "最新价": 1310.0,
            "涨跌幅": 1.5,
            "成交量": 100.0,
            "成交额": 200.0,
            main._QUOTE_SOURCE_KEY: "sina_hq_sinajs",
        }
        with (
            patch("routes.spot.MOCK_MODE", False),
            patch("providers.akshare_spot._ak_a_spot_rows", return_value=None),
            patch("providers.akshare_spot._sina_a_spot_rows", return_value=sina_row),
            patch("routes.spot._resolve_name", return_value="寒武纪-U"),
        ):
            resp = client.get("/spot", params={"symbol": "sh688256"})
        self.assertEqual(resp.status_code, 200)
        body = resp.json()
        self.assertEqual(body["source"], "sina-hq-realtime")
        self.assertEqual(body["price"], 1310.0)

    def test_health_fields(self) -> None:
        resp = client.get("/health")
        self.assertEqual(resp.status_code, 200)
        body = resp.json()
        self.assertTrue(body["ok"])
        self.assertIn("time", body)
        self.assertIn("source", body)
        self.assertIn("mock", body)
        self.assertIn("a_share_quotes", body)
        self.assertIn("tushare_secondary_enabled", body)


if __name__ == "__main__":
    unittest.main()
