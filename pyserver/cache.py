"""SQLite write-through cache for market data (WAL + busy_timeout).

Extracted from main.py. Importing this module resolves DB_PATH and runs
_init_db() once, so the schema and WAL journal mode are in place before any
connection is opened (main.py imports cache after loading .env, so a
PYSERVER_CACHE_DB set in .env is honored).
"""
from __future__ import annotations

import json
import logging
import os
import sqlite3
import threading
import time
from contextlib import contextmanager
from pathlib import Path
from typing import Any

log = logging.getLogger("pyserver")

DB_PATH = Path(os.environ.get("PYSERVER_CACHE_DB", Path(__file__).parent / "cache.db"))
DB_PATH.parent.mkdir(parents=True, exist_ok=True)

SCHEMA = """
CREATE TABLE IF NOT EXISTS cache (
  key TEXT PRIMARY KEY,
  payload TEXT NOT NULL,
  fetched_at INTEGER NOT NULL,
  ttl_seconds INTEGER NOT NULL
);
"""

# main.py reassigns this module global after import based on MOCK_MODE
# ("mock" vs "live"); cache_get/cache_put read it dynamically at call time,
# so the reassignment takes effect without restarting.
CACHE_NAMESPACE = "live"


def _init_db() -> None:
    # Switch to WAL once at startup. Changing journal mode needs an exclusive
    # lock that the busy handler does not cover when other connections hold
    # read locks, so doing it per-connection races under concurrent first hits.
    conn = sqlite3.connect(DB_PATH, timeout=10)
    try:
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute(SCHEMA)
        conn.commit()
    finally:
        conn.close()


_init_db()


@contextmanager
def db():
    # WAL lets readers proceed alongside the single writer, and busy_timeout
    # makes concurrent writers wait instead of failing with "database is locked".
    conn = sqlite3.connect(DB_PATH, timeout=10)
    try:
        conn.execute("PRAGMA busy_timeout=10000")
        conn.execute("PRAGMA synchronous=NORMAL")
        conn.execute(SCHEMA)
        yield conn
        conn.commit()
    finally:
        conn.close()


CACHE_MAX_ROWS = int(os.environ.get("PYSERVER_CACHE_MAX_ROWS", "20000"))
_PRUNE_INTERVAL_S = 600
_last_prune_at = 0.0
_prune_lock = threading.Lock()


def cache_get(key: str) -> Any | None:
    scoped_key = f"{CACHE_NAMESPACE}:{key}"
    with db() as conn:
        row = conn.execute(
            "SELECT payload, fetched_at, ttl_seconds FROM cache WHERE key = ?",
            (scoped_key,),
        ).fetchone()
        if row is None:
            return None
        payload, fetched_at, ttl = row
        if ttl > 0 and time.time() - fetched_at > ttl:
            # Delete expired rows eagerly so the cache does not grow stale
            # entries. Conditional on fetched_at so a concurrent cache_put
            # that just refreshed this key is not deleted.
            conn.execute(
                "DELETE FROM cache WHERE key = ? AND fetched_at = ?",
                (scoped_key, fetched_at),
            )
            return None
        return json.loads(payload)


def cache_prune(max_rows: int = CACHE_MAX_ROWS) -> dict[str, int]:
    """Delete expired rows, then evict oldest rows beyond `max_rows`."""
    now = time.time()
    with db() as conn:
        expired = conn.execute(
            "DELETE FROM cache WHERE ttl_seconds > 0 AND ? - fetched_at > ttl_seconds",
            (now,),
        ).rowcount
        total = conn.execute("SELECT COUNT(*) FROM cache").fetchone()[0]
        evicted = 0
        if total > max_rows:
            evicted = conn.execute(
                "DELETE FROM cache WHERE key IN ("
                "  SELECT key FROM cache ORDER BY fetched_at ASC LIMIT ?"
                ")",
                (total - max_rows,),
            ).rowcount
    if expired or evicted:
        log.info("cache_prune removed rows: expired=%d evicted=%d", expired, evicted)
    return {"expired": expired, "evicted": evicted}


def cache_put(key: str, value: Any, ttl_seconds: int) -> None:
    global _last_prune_at
    scoped_key = f"{CACHE_NAMESPACE}:{key}"
    with db() as conn:
        conn.execute(
            "REPLACE INTO cache (key, payload, fetched_at, ttl_seconds) VALUES (?, ?, ?, ?)",
            (scoped_key, json.dumps(value, ensure_ascii=False), int(time.time()), ttl_seconds),
        )
    now = time.monotonic()
    with _prune_lock:
        if now - _last_prune_at <= _PRUNE_INTERVAL_S:
            return
        _last_prune_at = now
    try:
        cache_prune()
    except Exception:
        log.exception("cache_prune failed")
