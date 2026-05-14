import { test, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// Redirect the cache to a temp dir BEFORE importing the module.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "scc-cache-"));
process.chdir(tmp);

let cached: typeof import("../lib/cache").cached;
let cacheGet: typeof import("../lib/cache").cacheGet;
let cachePut: typeof import("../lib/cache").cachePut;
let hashKey: typeof import("../lib/cache").hashKey;

before(async () => {
  const mod = await import("../lib/cache");
  cached = mod.cached;
  cacheGet = mod.cacheGet;
  cachePut = mod.cachePut;
  hashKey = mod.hashKey;
});

test("hashKey is deterministic and order-sensitive on objects", () => {
  const a = hashKey({ a: 1, b: 2 });
  const b = hashKey({ a: 1, b: 2 });
  const c = hashKey({ b: 2, a: 1 });
  assert.equal(a, b);
  // JSON.stringify preserves insertion order, so different orderings hash differently.
  assert.notEqual(a, c);
});

test("cacheGet returns null for missing key", () => {
  assert.equal(cacheGet("nonexistent-key"), null);
});

test("cachePut + cacheGet round-trips", () => {
  cachePut("k1", { hello: "world", n: 42 }, 60);
  const v = cacheGet<{ hello: string; n: number }>("k1");
  assert.deepEqual(v, { hello: "world", n: 42 });
});

test("cache expires after ttl", async () => {
  cachePut("k-expire", "x", 1);
  // Backdate fetched_at by 2s by reopening DB directly.
  const Database = (await import("better-sqlite3")).default;
  const db = new Database(path.join(tmp, ".cache", "web.db"));
  db.prepare("UPDATE cache SET fetched_at = fetched_at - 2 WHERE key = ?").run("k-expire");
  db.close();
  assert.equal(cacheGet("k-expire"), null);
});

test("cached() calls fetcher only on miss", async () => {
  let calls = 0;
  const fetcher = async () => {
    calls++;
    return { v: calls };
  };
  const a = await cached(["k-once", 1], 60, fetcher);
  const b = await cached(["k-once", 1], 60, fetcher);
  assert.deepEqual(a, { v: 1 });
  assert.deepEqual(b, { v: 1 });
  assert.equal(calls, 1);
});
