"""Threaded cache stress test: WAL + busy_timeout must absorb concurrent writers.

No network. Redirects the cache module's DB_PATH at a temp database, then
hammers cache_put/cache_get from multiple threads on one shared key plus
per-thread disjoint keys. Asserts no OperationalError ("database is locked")
escapes, the final row count matches expectation, and a value written before
the storm survives intact.
"""
from __future__ import annotations

import tempfile
import threading
import unittest
from pathlib import Path

import cache as cache_mod

THREADS = 8
ITERATIONS = 25


class CacheConcurrencyTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.old_path = cache_mod.DB_PATH
        cache_mod.DB_PATH = Path(self.tmp.name) / "cache.db"
        cache_mod._init_db()

    def tearDown(self) -> None:
        cache_mod.DB_PATH = self.old_path
        self.tmp.cleanup()

    def test_concurrent_put_get_storm(self) -> None:
        cache_mod.cache_put("anchor", {"v": "intact"}, 3600)
        errors: list[Exception] = []

        def worker(tid: int) -> None:
            try:
                for i in range(ITERATIONS):
                    # One contended key every thread writes, plus disjoint
                    # per-thread keys; interleave reads of both.
                    cache_mod.cache_put("shared", {"tid": tid, "i": i}, 3600)
                    cache_mod.cache_put(f"t{tid}:k{i}", {"i": i}, 3600)
                    cache_mod.cache_get("shared")
                    cache_mod.cache_get("anchor")
            except Exception as e:  # noqa: BLE001 - collected and asserted below
                errors.append(e)

        threads = [threading.Thread(target=worker, args=(t,)) for t in range(THREADS)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()

        self.assertEqual(errors, [])
        with cache_mod.db() as conn:
            mode = conn.execute("PRAGMA journal_mode").fetchone()[0]
            rows = conn.execute("SELECT COUNT(*) FROM cache").fetchone()[0]
        self.assertEqual(mode, "wal")
        # 1 anchor + 1 shared (REPLACE-collapsed) + THREADS * ITERATIONS disjoint.
        self.assertEqual(rows, 2 + THREADS * ITERATIONS)
        self.assertEqual(cache_mod.cache_get("anchor"), {"v": "intact"})


if __name__ == "__main__":
    unittest.main()
