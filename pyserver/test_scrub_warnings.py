"""Unit tests for scrubbing upstream exception text from client warnings."""
from __future__ import annotations

import re
import unittest
from unittest.mock import patch

import main
import analyst as analyst_mod
from analyst import analyst


_URL_OR_PATH = re.compile(
    r"https?://|/Users/|/var/|/tmp/|\.eastmoney\.|push2\.|sinajs\.cn",
    re.IGNORECASE,
)


def _warnings_contain_url_or_path(warnings: list[str]) -> str | None:
    joined = " ".join(warnings)
    for warning in warnings:
        if _URL_OR_PATH.search(warning):
            return f"warning leaked upstream detail: {joined!r}"
        if "secret-token" in warning:
            return f"warning leaked upstream detail: {joined!r}"
    return None


class ScrubWarningsTest(unittest.TestCase):
    def _assert_warnings_scrubbed(self, warnings: list[str]) -> None:
        leak = _warnings_contain_url_or_path(warnings)
        if leak is not None:
            self.fail(leak)

    def test_attach_profit_yoy_warning_scrubs_exception_body(self) -> None:
        secret_err = RuntimeError(
            "GET https://api.tushare.pro/data failed /Users/ht/.env secret-token"
        )
        out: dict = {"warnings": []}
        with (
            patch.object(main, "_baostock_growth_yoy", return_value=None),
            patch.object(main, "MARKET_ENABLE_TUSHARE_SECONDARY", True),
            patch.object(main, "_latest_profit_yoy", side_effect=secret_err),
            patch.object(main.log, "exception"),
        ):
            main._attach_profit_yoy(out, "600519.SH", "sh")

        self.assertEqual(len(out["warnings"]), 1)
        self.assertEqual(
            out["warnings"][0],
            "tushare fina_indicator unavailable: RuntimeError",
        )
        self._assert_warnings_scrubbed(out["warnings"])

    def test_analyst_daily_basic_warning_scrubs_exception_body(self) -> None:
        secret_err = OSError("/tmp/leaked-path https://hq.sinajs.cn/list=sh600519")
        with (
            patch.object(analyst_mod, "cache_get", return_value=None),
            patch.object(analyst_mod, "cache_put"),
            patch.object(main, "_ak_a_spot", return_value=None),
            patch.object(main, "_ak_stock_value_row", return_value=None),
            patch.object(main, "_ak_a_spot_from_hist", return_value=None),
            patch.object(main, "_ak_research_consensus", return_value={}),
            patch.object(main, "_ak_consensus_eps", return_value=(None, None)),
            patch.object(main, "_pro", object()),
            patch.object(main, "MARKET_ENABLE_TUSHARE_SECONDARY", True),
            patch.object(main, "_with_retries", side_effect=secret_err),
            patch.object(main.log, "exception"),
        ):
            out = analyst("600519")

        daily_basic_warnings = [
            w for w in out["warnings"] if w.startswith("tushare daily_basic unavailable:")
        ]
        self.assertEqual(len(daily_basic_warnings), 1)
        self.assertEqual(
            daily_basic_warnings[0],
            "tushare daily_basic unavailable: OSError",
        )
        self._assert_warnings_scrubbed(out["warnings"])

    def test_analyst_report_rc_warning_scrubs_exception_body(self) -> None:
        secret_err = RuntimeError(
            "report_rc https://api.tushare.pro secret-token /Users/ht/.env"
        )
        with (
            patch.object(analyst_mod, "cache_get", return_value=None),
            patch.object(analyst_mod, "cache_put"),
            patch.object(main, "_ak_a_spot", return_value={"最新价": 10.0}),
            patch.object(main, "_spot_price_from_ak", return_value=10.0),
            patch.object(main, "_ak_stock_value_row", return_value={"pe_ttm": 5.0}),
            patch.object(main, "_ak_research_consensus", return_value={}),
            patch.object(main, "_ak_consensus_eps", return_value=(None, None)),
            patch.object(main, "_pro", object()),
            patch.object(main, "MARKET_ENABLE_TUSHARE_SECONDARY", True),
            patch.object(main, "_with_retries", side_effect=secret_err),
            patch.object(main.log, "exception"),
        ):
            out = analyst("600519")

        report_rc_warnings = [
            w for w in out["warnings"] if w.startswith("tushare report_rc unavailable:")
        ]
        self.assertEqual(len(report_rc_warnings), 1)
        self.assertEqual(
            report_rc_warnings[0],
            f"tushare report_rc unavailable: {type(secret_err).__name__}",
        )
        self._assert_warnings_scrubbed(out["warnings"])


if __name__ == "__main__":
    unittest.main()
