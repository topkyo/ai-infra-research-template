"""Unit tests for BaoStock provider paths (_baostock_hist_df / _baostock_growth_yoy)."""
from __future__ import annotations

import unittest
from unittest.mock import MagicMock, patch

import pandas as pd

import main


def _mock_login_result(error_code: str = "0", error_msg: str = "") -> MagicMock:
    lg = MagicMock()
    lg.error_code = error_code
    lg.error_msg = error_msg
    return lg


class _MockResultSet:
    """Minimal BaoStock result-set stub with iterable rows."""

    def __init__(
        self,
        *,
        error_code: str = "0",
        fields: list[str] | None = None,
        rows: list[list[str]] | None = None,
    ) -> None:
        self.error_code = error_code
        self.fields = fields or [
            "date",
            "code",
            "open",
            "high",
            "low",
            "close",
            "volume",
            "amount",
            "pctChg",
        ]
        self._rows = list(rows or [])
        self._idx = 0

    def next(self) -> bool:
        if self._idx >= len(self._rows):
            return False
        self._idx += 1
        return True

    def get_row_data(self) -> list[str]:
        return self._rows[self._idx - 1]


class BaostockHistDfTest(unittest.TestCase):
    def test_hk_code_returns_none_without_query(self) -> None:
        with patch("providers.baostock_api._baostock_login") as login, patch(
            "providers.baostock_api._baostock_logout"
        ) as logout, patch("providers.baostock_api.bs.query_history_k_data_plus") as query:
            result = main._baostock_hist_df("00700.HK", "20240101", "20240131", "qfq")
        self.assertIsNone(result)
        login.assert_not_called()
        logout.assert_not_called()
        query.assert_not_called()

    def test_error_code_nonzero_returns_none_and_logout(self) -> None:
        rs = _MockResultSet(error_code="10001001")
        with patch("providers.baostock_api._baostock_login", return_value=_mock_login_result()), patch(
            "providers.baostock_api._baostock_logout"
        ) as logout, patch("providers.baostock_api.bs.query_history_k_data_plus", return_value=rs) as query:
            result = main._baostock_hist_df("600519.SH", "20240101", "20240131", "qfq")
        self.assertIsNone(result)
        logout.assert_called_once()
        query.assert_called_once_with(
            "sh.600519",
            "date,code,open,high,low,close,volume,amount,pctChg",
            start_date="2024-01-01",
            end_date="2024-01-31",
            frequency="d",
            adjustflag="2",
        )

    def test_empty_data_returns_empty_df_and_logout(self) -> None:
        rs = _MockResultSet(rows=[])
        with patch("providers.baostock_api._baostock_login", return_value=_mock_login_result()), patch(
            "providers.baostock_api._baostock_logout"
        ) as logout, patch("providers.baostock_api.bs.query_history_k_data_plus", return_value=rs):
            result = main._baostock_hist_df("600519.SH", "20240101", "20240131", "qfq")
        self.assertIsNotNone(result)
        assert result is not None
        self.assertTrue(result.empty)
        logout.assert_called_once()

    def test_all_invalid_rows_returns_empty_df_and_logout(self) -> None:
        rows = [
            ["2024-01-02", "sh.600519", "", "", "", "", "1000", "0", "0"],
            ["2024-01-03", "sh.600519", "bad", "bad", "bad", "bad", "1000", "0", "0"],
        ]
        rs = _MockResultSet(rows=rows)
        with patch("providers.baostock_api._baostock_login", return_value=_mock_login_result()), patch(
            "providers.baostock_api._baostock_logout"
        ) as logout, patch("providers.baostock_api.bs.query_history_k_data_plus", return_value=rs):
            result = main._baostock_hist_df("600519.SH", "20240101", "20240131", "qfq")
        self.assertIsNotNone(result)
        assert result is not None
        self.assertTrue(result.empty)
        logout.assert_called_once()

    def test_happy_path_returns_rows_and_logout(self) -> None:
        rows = [
            ["2024-01-02", "sh.600519", "1700.0", "1720.0", "1690.0", "1710.0", "100000", "0", "0.5"],
            ["2024-01-03", "sh.600519", "1710.0", "1730.0", "1705.0", "1725.0", "120000", "0", "0.9"],
        ]
        rs = _MockResultSet(rows=rows)
        with patch("providers.baostock_api._baostock_login", return_value=_mock_login_result()), patch(
            "providers.baostock_api._baostock_logout"
        ) as logout, patch("providers.baostock_api.bs.query_history_k_data_plus", return_value=rs):
            result = main._baostock_hist_df("600519.SH", "20240101", "20240131", "hfq")
        self.assertIsNotNone(result)
        assert result is not None
        self.assertFalse(result.empty)
        self.assertEqual(len(result), 2)
        self.assertEqual(list(result.columns), rs.fields)
        self.assertAlmostEqual(result.iloc[0]["close"], 1710.0)
        logout.assert_called_once()


class BaostockGrowthYoyTest(unittest.TestCase):
    def test_hk_code_returns_none_without_query(self) -> None:
        with patch("providers.baostock_api.cache_get", return_value=None), patch("providers.baostock_api._baostock_login") as login, patch(
            "providers.baostock_api._baostock_logout"
        ) as logout, patch("providers.baostock_api.bs.query_growth_data") as query:
            result = main._baostock_growth_yoy("00700.HK")
        self.assertIsNone(result)
        login.assert_not_called()
        logout.assert_not_called()
        query.assert_not_called()

    def test_returns_latest_yoy_and_logout(self) -> None:
        # BaoStock returns YOYNI as a decimal fraction (0.155 == 15.5%); code *100 → percent.
        rows = [["2024", "4", "0.155"]]
        rs = _MockResultSet(fields=["year", "quarter", "YOYNI"], rows=rows)
        with (
            patch("providers.baostock_api.cache_get", return_value=None),
            patch("providers.baostock_api.cache_put") as cache_put,
            patch("providers.baostock_api._baostock_login", return_value=_mock_login_result()),
            patch("providers.baostock_api._baostock_logout") as logout,
            patch("providers.baostock_api.bs.query_growth_data", return_value=rs),
        ):
            result = main._baostock_growth_yoy("600519.SH")
        self.assertAlmostEqual(result, 15.5)
        logout.assert_called_once()
        cache_put.assert_called_once()

    def test_no_data_returns_none_after_logout(self) -> None:
        rs = _MockResultSet(fields=["year", "quarter", "YOYNI"], rows=[])
        with (
            patch("providers.baostock_api.cache_get", return_value=None),
            patch("providers.baostock_api.cache_put"),
            patch("providers.baostock_api._baostock_login", return_value=_mock_login_result()),
            patch("providers.baostock_api._baostock_logout") as logout,
            patch("providers.baostock_api.bs.query_growth_data", return_value=rs),
        ):
            result = main._baostock_growth_yoy("600519.SH")
        self.assertIsNone(result)
        logout.assert_called_once()


if __name__ == "__main__":
    unittest.main()
