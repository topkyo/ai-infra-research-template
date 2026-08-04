"""Unit tests for provider helper exception logging (no network)."""
from __future__ import annotations

import unittest
from unittest.mock import patch

import main


class ProviderExceptionLoggingTest(unittest.TestCase):
    def test_ak_stock_value_row_logs_warning_on_failure(self) -> None:
        boom = RuntimeError("upstream timeout")
        with (
            patch.object(main, "cache_get", return_value=None),
            patch.object(main, "cache_put"),
            patch.object(main, "_with_retries", side_effect=boom),
            patch.object(main.log, "warning") as mock_warning,
        ):
            result = main._ak_stock_value_row("600519.SH")

        self.assertIsNone(result)
        mock_warning.assert_called_once_with(
            "provider %s failed: %s",
            "akshare_stock_value_em",
            boom,
        )


if __name__ == "__main__":
    unittest.main()
