"""Unit tests for _with_retries backoff behavior."""
from __future__ import annotations

import unittest
from unittest.mock import patch

import main


class WithRetriesBackoffTest(unittest.TestCase):
    def test_final_failure_does_not_sleep(self) -> None:
        boom = RuntimeError("upstream down")

        def always_fail() -> None:
            raise boom

        with (
            patch("http_util.time.sleep") as mock_sleep,
            self.assertRaises(RuntimeError) as ctx,
        ):
            main._with_retries(always_fail, attempts=3, base_delay=0.5)

        self.assertIs(ctx.exception, boom)
        self.assertEqual(mock_sleep.call_count, 2)
        mock_sleep.assert_any_call(0.5)
        mock_sleep.assert_any_call(1.0)

    def test_success_on_last_attempt_sleeps_before_retry(self) -> None:
        calls = {"n": 0}

        def fail_twice() -> str:
            calls["n"] += 1
            if calls["n"] < 3:
                raise RuntimeError("transient")
            return "ok"

        with patch("http_util.time.sleep") as mock_sleep:
            result = main._with_retries(fail_twice, attempts=3, base_delay=0.25)

        self.assertEqual(result, "ok")
        self.assertEqual(mock_sleep.call_count, 2)


if __name__ == "__main__":
    unittest.main()
