"""Cache maintenance tests: WAL/busy-timeout, eager expiry delete, prune.

No network. Each test points main.DB_PATH at a temp database.
"""
from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

import main


class CacheMaintenanceTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.old_path = main.DB_PATH
        main.DB_PATH = Path(self.tmp.name) / "cache.db"

    def tearDown(self) -> None:
        main.DB_PATH = self.old_path
        self.tmp.cleanup()

    def _row_count(self) -> int:
        with main.db() as conn:
            return conn.execute("SELECT COUNT(*) FROM cache").fetchone()[0]

    def test_db_uses_wal_and_busy_timeout(self) -> None:
        with main.db() as conn:
            mode = conn.execute("PRAGMA journal_mode").fetchone()[0]
            busy = conn.execute("PRAGMA busy_timeout").fetchone()[0]
        self.assertEqual(mode, "wal")
        self.assertGreaterEqual(busy, 5000)

    def test_cache_get_deletes_expired_row(self) -> None:
        main.cache_put("k", {"v": 1}, 60)
        with main.db() as conn:
            conn.execute("UPDATE cache SET fetched_at = fetched_at - 120")
        self.assertIsNone(main.cache_get("k"))
        self.assertEqual(self._row_count(), 0)

    def test_cache_get_keeps_fresh_row(self) -> None:
        main.cache_put("k", {"v": 2}, 60)
        self.assertEqual(main.cache_get("k"), {"v": 2})
        self.assertEqual(self._row_count(), 1)

    def test_cache_prune_removes_expired_and_evicts_oldest(self) -> None:
        main.cache_put("old", 1, 1000)
        main.cache_put("new", 2, 1000)
        main.cache_put("gone", 3, 10)
        with main.db() as conn:
            conn.execute("UPDATE cache SET fetched_at = fetched_at - 100 WHERE key LIKE '%gone'")
            conn.execute("UPDATE cache SET fetched_at = fetched_at - 50 WHERE key LIKE '%old'")
        stats = main.cache_prune(max_rows=1)
        self.assertEqual(stats["expired"], 1)
        self.assertEqual(stats["evicted"], 1)
        self.assertIsNotNone(main.cache_get("new"))
        self.assertIsNone(main.cache_get("old"))
        self.assertEqual(self._row_count(), 1)

    def test_cache_prune_noop_when_within_limits(self) -> None:
        main.cache_put("a", 1, 1000)
        stats = main.cache_prune(max_rows=100)
        self.assertEqual(stats, {"expired": 0, "evicted": 0})
        self.assertEqual(self._row_count(), 1)


if __name__ == "__main__":
    unittest.main()
