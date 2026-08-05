"""Unit tests for _TokenBucket rate limiting (no network)."""
from __future__ import annotations

import unittest
from unittest.mock import MagicMock, patch

from http_util import _TokenBucket


class _FakeClock:
    def __init__(self) -> None:
        self.t = 0.0

    def monotonic(self) -> float:
        return self.t

    def sleep(self, seconds: float) -> None:
        self.t += float(seconds)


class TokenBucketTest(unittest.TestCase):
    def test_allows_n_acquires_without_sleep(self) -> None:
        clock = _FakeClock()
        bucket = _TokenBucket(n=2, window_s=10.0)
        sleep = MagicMock(side_effect=clock.sleep)
        with (
            patch("http_util.time.monotonic", clock.monotonic),
            patch("http_util.time.sleep", sleep),
        ):
            bucket.acquire()
            bucket.acquire()
        sleep.assert_not_called()
        self.assertEqual(len(bucket.calls), 2)

    def test_blocks_when_capacity_exhausted_then_admits_after_window(self) -> None:
        clock = _FakeClock()
        bucket = _TokenBucket(n=2, window_s=1.0)
        sleep = MagicMock(side_effect=clock.sleep)
        with (
            patch("http_util.time.monotonic", clock.monotonic),
            patch("http_util.time.sleep", sleep),
        ):
            bucket.acquire()
            bucket.acquire()
            t_before = clock.t
            bucket.acquire()
            # Third acquire must wait until the oldest call falls out of the window.
            self.assertGreater(clock.t, t_before)
            self.assertGreaterEqual(clock.t, 1.0)
            sleep.assert_called()
            # Both prior stamps expire once the clock advances past the window.
            self.assertEqual(len(bucket.calls), 1)
            self.assertAlmostEqual(bucket.calls[0], clock.t)

    def test_expired_calls_are_evicted(self) -> None:
        clock = _FakeClock()
        bucket = _TokenBucket(n=1, window_s=1.0)
        sleep = MagicMock(side_effect=clock.sleep)
        with (
            patch("http_util.time.monotonic", clock.monotonic),
            patch("http_util.time.sleep", sleep),
        ):
            bucket.acquire()
            clock.t = 2.0  # advance past window without sleeping
            bucket.acquire()
        sleep.assert_not_called()
        self.assertEqual(len(bucket.calls), 1)
        self.assertAlmostEqual(bucket.calls[0], 2.0)


if __name__ == "__main__":
    unittest.main()
