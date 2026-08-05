"""HTTP session helpers, rate limiters, and retry wrapper."""
from __future__ import annotations

import threading
import time
from collections import deque
from typing import Any

import requests

from config import MARKET_HTTP_PROXY

_MARKET_HTTP_SESSION: requests.Session | None = None


def _market_http_session() -> requests.Session:
    global _MARKET_HTTP_SESSION
    if _MARKET_HTTP_SESSION is None:
        _MARKET_HTTP_SESSION = requests.Session()
        _MARKET_HTTP_SESSION.trust_env = False
        if MARKET_HTTP_PROXY:
            _MARKET_HTTP_SESSION.proxies = {
                "http": MARKET_HTTP_PROXY,
                "https": MARKET_HTTP_PROXY,
            }
    return _MARKET_HTTP_SESSION


def _market_http_get(
    url: str,
    *,
    params: dict[str, Any] | None = None,
    headers: dict[str, str] | None = None,
    timeout: float = 3,
) -> requests.Response:
    return _market_http_session().get(url, params=params, headers=headers, timeout=timeout)


class _TokenBucket:
    """Simple token bucket — at most `n` calls per `window_s` seconds."""

    def __init__(self, n: int, window_s: float) -> None:
        self.n = n
        self.window = window_s
        self.calls: deque[float] = deque()
        self.lock = threading.Lock()

    def acquire(self) -> None:
        while True:
            with self.lock:
                now = time.monotonic()
                while self.calls and now - self.calls[0] > self.window:
                    self.calls.popleft()
                if len(self.calls) < self.n:
                    self.calls.append(now)
                    return
                wait = self.window - (now - self.calls[0]) + 0.05
            time.sleep(wait)


# Tushare free tier caps hk_daily at 2/minute. Self-throttle to avoid 502s.
_REPORT_RC_LIMITER = _TokenBucket(n=2, window_s=65)
_DAILY_BASIC_LIMITER = _TokenBucket(n=2, window_s=65)
_FINA_INDICATOR_LIMITER = _TokenBucket(n=2, window_s=65)
_AK_LOCK = threading.Lock()
_BS_LOCK = threading.Lock()


def _ak_call(fn, *args, **kwargs):
    # Some AkShare paths use native JavaScript runtimes that are not safe when
    # entered concurrently from FastAPI's worker threads.
    with _AK_LOCK:
        return fn(*args, **kwargs)


def _with_retries(
    fn,
    *args,
    attempts: int = 3,
    base_delay: float = 0.5,
    _sleep=None,
    **kwargs,
):
    sleep = _sleep or time.sleep
    last: Exception | None = None
    for i in range(attempts):
        try:
            return fn(*args, **kwargs)
        except Exception as e:  # noqa: BLE001
            last = e
            if i < attempts - 1:
                sleep(base_delay * (2 ** i))
    assert last is not None
    raise last
