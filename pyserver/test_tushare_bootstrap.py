"""Bootstrap tests for optional Tushare initialization."""
from __future__ import annotations

import importlib
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import tushare as ts


class TushareBootstrapTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.cache_db = str(Path(self.tmp.name) / "cache.db")

    def tearDown(self) -> None:
        for mod in ("main", "cache", "config"):
            sys.modules.pop(mod, None)
        self.tmp.cleanup()

    def _import_main(self, *, token: str, secondary: str) -> object:
        for mod in ("main", "cache", "config"):
            sys.modules.pop(mod, None)
        os.environ.pop("STRICT_LIVE_DATA", None)
        return importlib.import_module("main")

    def test_token_does_not_initialize_tushare_when_secondary_disabled(self) -> None:
        env = {
            "TUSHARE_TOKEN": "x" * 56,
            "MARKET_ENABLE_TUSHARE_SECONDARY": "0",
            "PYSERVER_CACHE_DB": self.cache_db,
        }
        with patch.dict(os.environ, env, clear=False):
            with (
                patch.object(ts, "set_token") as set_token,
                patch.object(ts, "pro_api") as pro_api,
            ):
                main = self._import_main(token=env["TUSHARE_TOKEN"], secondary="0")

        set_token.assert_not_called()
        pro_api.assert_not_called()
        self.assertIsNone(main._pro)

    def test_secondary_source_passes_token_without_writing_tk_csv(self) -> None:
        env = {
            "TUSHARE_TOKEN": "y" * 56,
            "MARKET_ENABLE_TUSHARE_SECONDARY": "1",
            "PYSERVER_CACHE_DB": self.cache_db,
        }
        with patch.dict(os.environ, env, clear=False):
            with (
                patch.object(ts, "set_token") as set_token,
                patch.object(ts, "pro_api", return_value=object()) as pro_api,
            ):
                main = self._import_main(token=env["TUSHARE_TOKEN"], secondary="1")

        set_token.assert_not_called()
        pro_api.assert_called_once_with("y" * 56)
        self.assertIsNotNone(main._pro)


if __name__ == "__main__":
    unittest.main()
