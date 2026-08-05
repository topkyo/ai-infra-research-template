"""Unit tests for _ak_a_spot_from_hist empty hist DataFrame (no network)."""
from __future__ import annotations

import unittest
from unittest.mock import patch

import pandas as pd

from providers.akshare_spot import _ak_a_spot_from_hist


class AkASpotFromHistEmptyTest(unittest.TestCase):
    def test_empty_hist_returns_none_without_index_error(self) -> None:
        with patch("providers.akshare_spot._ak_a_hist_df", return_value=pd.DataFrame()):
            result = _ak_a_spot_from_hist("600519.SH", "sh", "sh600519")
        self.assertIsNone(result)

    def test_none_hist_returns_none(self) -> None:
        with patch("providers.akshare_spot._ak_a_hist_df", return_value=None):
            result = _ak_a_spot_from_hist("600519.SH", "sh", "sh600519")
        self.assertIsNone(result)


if __name__ == "__main__":
    unittest.main()
