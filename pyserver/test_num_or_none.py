"""Unit tests for _num_or_none (no network)."""
from __future__ import annotations

import unittest

import main


class NumOrNoneTest(unittest.TestCase):
    def test_none_returns_none(self) -> None:
        self.assertIsNone(main._num_or_none(None))

    def test_float_passthrough(self) -> None:
        self.assertEqual(main._num_or_none(3.14), 3.14)

    def test_int_becomes_float(self) -> None:
        self.assertEqual(main._num_or_none(123), 123.0)

    def test_thousand_separator_comma(self) -> None:
        self.assertEqual(main._num_or_none("1,234.5"), 1234.5)

    def test_na_string_returns_none_with_warning(self) -> None:
        with self.assertLogs(main.log, level="WARNING") as logs:
            self.assertIsNone(main._num_or_none("N/A"))
        self.assertTrue(any("_num_or_none" in msg for msg in logs.output))

    def test_empty_string_returns_none_with_warning(self) -> None:
        with self.assertLogs(main.log, level="WARNING") as logs:
            self.assertIsNone(main._num_or_none(""))
        self.assertTrue(any("_num_or_none" in msg for msg in logs.output))

    def test_multiple_numbers_returns_none_with_warning(self) -> None:
        with self.assertLogs(main.log, level="WARNING") as logs:
            self.assertIsNone(main._num_or_none("12.3 (was 45.6)"))
        self.assertTrue(any("found 2" in msg for msg in logs.output))


if __name__ == "__main__":
    unittest.main()
