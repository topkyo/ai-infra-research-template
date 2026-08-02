"""Input validation whitelist tests (no network).

_validate_symbol/_validate_date are pure functions tested directly. Endpoint
checks call the route functions with invalid input and assert HTTPException
400 is raised before any cache-key construction or upstream access.
"""
from __future__ import annotations

import tempfile
import unittest
from datetime import date, timedelta
from pathlib import Path

from fastapi import HTTPException

import main


def _assert_400(testcase: unittest.TestCase, fn, *args, **kwargs) -> None:
    with testcase.assertRaises(HTTPException) as ctx:
        fn(*args, **kwargs)
    testcase.assertEqual(ctx.exception.status_code, 400)


class ValidateSymbolTest(unittest.TestCase):
    def test_accepts_prefixed_a_share(self) -> None:
        self.assertEqual(main._validate_symbol("sh600519"), "sh600519")
        self.assertEqual(main._validate_symbol("sz000858"), "sz000858")
        self.assertEqual(main._validate_symbol("bj830799"), "bj830799")

    def test_accepts_prefixed_hk(self) -> None:
        self.assertEqual(main._validate_symbol("hk00700"), "hk00700")

    def test_accepts_bare_digits(self) -> None:
        self.assertEqual(main._validate_symbol("600519"), "600519")
        self.assertEqual(main._validate_symbol("000858"), "000858")
        self.assertEqual(main._validate_symbol("00700"), "00700")

    def test_accepts_ts_code_case_insensitive(self) -> None:
        self.assertEqual(main._validate_symbol("600519.SH"), "600519.SH")
        self.assertEqual(main._validate_symbol("000858.sz"), "000858.sz")
        self.assertEqual(main._validate_symbol("830799.BJ"), "830799.BJ")
        self.assertEqual(main._validate_symbol("00700.HK"), "00700.HK")
        self.assertEqual(main._validate_symbol("00700.hk"), "00700.hk")
        self.assertEqual(main._validate_symbol("SH600519"), "SH600519")

    def test_strips_surrounding_whitespace(self) -> None:
        self.assertEqual(main._validate_symbol("  600519 \n"), "600519")

    def test_rejects_invalid_symbols(self) -> None:
        bad = [
            "",  # empty
            "   ",  # whitespace only
            "../etc/passwd",  # path traversal
            "..\\..\\win.ini",  # windows path traversal
            "600519;DROP TABLE cache",  # injection
            "sh60051",  # prefix + 5 digits
            "sh6005199",  # prefix + 7 digits
            "hk0070",  # hk + 4 digits
            "hk007000",  # hk + 6 digits
            "6005199",  # bare 7 digits
            "600519.XY",  # unknown suffix
            "600519.SHH",  # overlong suffix
            "600519.SH.BAK",  # second dot
            "sh 600519",  # inner space
            "600519\n600519",  # embedded newline
            "600519$IFS",  # shell metachar
            "x" * 64,  # overlong
            "6" * 13,  # overlong digits
        ]
        for symbol in bad:
            with self.subTest(symbol=symbol):
                _assert_400(self, main._validate_symbol, symbol)


class ValidateDateTest(unittest.TestCase):
    def test_accepts_compact_and_dashed(self) -> None:
        self.assertEqual(main._validate_date("20240105", "start"), "20240105")
        self.assertEqual(main._validate_date("2024-01-05", "end"), "20240105")
        self.assertEqual(main._validate_date("1990-01-01", "start"), "19900101")

    def test_accepts_today_and_tomorrow(self) -> None:
        today = date.today().strftime("%Y%m%d")
        tomorrow = (date.today() + timedelta(days=1)).strftime("%Y-%m-%d")
        self.assertEqual(main._validate_date(today, "end"), today)
        self.assertEqual(main._validate_date(tomorrow, "end"), tomorrow.replace("-", ""))

    def test_strips_surrounding_whitespace(self) -> None:
        self.assertEqual(main._validate_date(" 20240101 \n", "start"), "20240101")

    def test_rejects_malformed(self) -> None:
        bad = ["", "   ", "2024-1-5", "2024015", "202401055", "2024/01/05", "abcd0105", "2024--01--05", "2024 0101"]
        for s in bad:
            with self.subTest(s=s):
                _assert_400(self, main._validate_date, s, "start")

    def test_rejects_nonexistent_calendar_date(self) -> None:
        bad = ["20230229", "2023-02-29", "20231301", "20230001", "20230431", "20231131"]
        for s in bad:
            with self.subTest(s=s):
                _assert_400(self, main._validate_date, s, "start")

    def test_rejects_out_of_range(self) -> None:
        _assert_400(self, main._validate_date, "19891231", "start")
        day_after_tomorrow = (date.today() + timedelta(days=2)).strftime("%Y%m%d")
        _assert_400(self, main._validate_date, day_after_tomorrow, "end")
        _assert_400(self, main._validate_date, "20990101", "end")


class EndpointValidationTest(unittest.TestCase):
    """Route functions raise 400 on invalid input before touching cache/network."""

    def test_klines_rejects_bad_symbol(self) -> None:
        _assert_400(self, main.klines, symbol="../etc/passwd", start="20230101", end="20240101", adjust="qfq")

    def test_klines_rejects_bad_start(self) -> None:
        _assert_400(self, main.klines, symbol="600519", start="2023-13-01", end="20240101", adjust="qfq")

    def test_klines_rejects_bad_end(self) -> None:
        _assert_400(self, main.klines, symbol="600519", start="20230101", end="not-a-date", adjust="qfq")

    def test_fundamental_rejects_bad_symbol(self) -> None:
        _assert_400(self, main.fundamental, symbol="x" * 64)

    def test_analyst_rejects_bad_symbol(self) -> None:
        _assert_400(self, main.analyst, symbol="bad/symbol")

    def test_analysts_rejects_single_bad_symbol_in_batch(self) -> None:
        _assert_400(self, main.analysts, symbols="600519,bad/symbol,000858")

    def test_spot_rejects_bad_symbol(self) -> None:
        _assert_400(self, main.spot, symbol="")

    def test_benchmark_klines_rejects_bad_start(self) -> None:
        _assert_400(self, main.benchmark_klines, index="csi300", start="20230229", end=None)

    def test_benchmark_klines_rejects_bad_end(self) -> None:
        _assert_400(self, main.benchmark_klines, index="csi300", start="20230101", end="20990101")

    def test_benchmark_klines_rejects_unknown_index(self) -> None:
        _assert_400(self, main.benchmark_klines, index="nope", start="20230101", end="20240101")


class ValidationBeforeCacheTest(unittest.TestCase):
    """A rejected request must not write any cache key."""

    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.old_path = main.DB_PATH
        main.DB_PATH = Path(self.tmp.name) / "cache.db"

    def tearDown(self) -> None:
        main.DB_PATH = self.old_path
        self.tmp.cleanup()

    def _row_count(self) -> int:
        with main.db() as conn:
            return conn.execute("SELECT COUNT(*) FROM cache").fetchone()[0]

    def test_invalid_symbol_writes_no_cache_row(self) -> None:
        _assert_400(self, main.spot, symbol="../../etc")
        _assert_400(self, main.klines, symbol="600519;rm", start="20230101", end="20240101", adjust="qfq")
        _assert_400(self, main.klines, symbol="600519", start="20230229", end="20240101", adjust="qfq")
        self.assertEqual(self._row_count(), 0)


if __name__ == "__main__":
    unittest.main()
