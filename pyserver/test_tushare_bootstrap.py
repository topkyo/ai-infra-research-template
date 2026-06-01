"""Bootstrap tests for optional Tushare initialization."""
from __future__ import annotations

import importlib
import os
import sys
import unittest
from unittest.mock import patch

import tushare as ts


def import_main_with_env(*, token: str, secondary: str):
    sys.modules.pop("main", None)
    os.environ["TUSHARE_TOKEN"] = token
    os.environ["MARKET_ENABLE_TUSHARE_SECONDARY"] = secondary
    os.environ["PYSERVER_CACHE_DB"] = ":memory:"
    os.environ.pop("STRICT_LIVE_DATA", None)
    return importlib.import_module("main")


class TushareBootstrapTest(unittest.TestCase):
    def tearDown(self) -> None:
        sys.modules.pop("main", None)

    def test_token_does_not_initialize_tushare_when_secondary_disabled(self) -> None:
        with (
            patch.object(ts, "set_token") as set_token,
            patch.object(ts, "pro_api") as pro_api,
        ):
            main = import_main_with_env(token="x" * 56, secondary="0")

        set_token.assert_not_called()
        pro_api.assert_not_called()
        self.assertIsNone(main._pro)

    def test_secondary_source_passes_token_without_writing_tk_csv(self) -> None:
        with (
            patch.object(ts, "set_token") as set_token,
            patch.object(ts, "pro_api", return_value=object()) as pro_api,
        ):
            main = import_main_with_env(token="y" * 56, secondary="1")

        set_token.assert_not_called()
        pro_api.assert_called_once_with("y" * 56)
        self.assertIsNotNone(main._pro)


if __name__ == "__main__":
    unittest.main()
