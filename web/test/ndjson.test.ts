// NDJSON stream reader: chunk boundaries, malformed lines, truncation.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readNdjsonStream } from "../lib/ndjson";

function streamFrom(text: string): ReadableStream<Uint8Array> {
  const encoded = new TextEncoder().encode(text);
  return new ReadableStream<Uint8Array>({
    start(controller) {
      // Feed in small chunks to exercise buffering across reads.
      const chunk = 7;
      for (let i = 0; i < encoded.length; i += chunk) {
        controller.enqueue(encoded.slice(i, i + chunk));
      }
      controller.close();
    },
  });
}

test("readNdjsonStream delivers events across chunk boundaries", async () => {
  const events: unknown[] = [];
  await readNdjsonStream(streamFrom('{"a":1}\n{"b":2}\n'), (e) => events.push(e));
  assert.deepEqual(events, [{ a: 1 }, { b: 2 }]);
});

test("readNdjsonStream skips malformed lines and reports them via onBadLine", async () => {
  const events: unknown[] = [];
  const bad: string[] = [];
  await readNdjsonStream(
    streamFrom('{"ok":1}\n<html>502 Bad Gateway</html>\n{"ok":2}\n'),
    (e) => events.push(e),
    (line) => bad.push(line),
  );
  assert.deepEqual(events, [{ ok: 1 }, { ok: 2 }]);
  assert.deepEqual(bad, ["<html>502 Bad Gateway</html>"]);
});

test("readNdjsonStream reassembles multibyte characters split across chunks", async () => {
  // 7-byte chunks will split 3-byte UTF-8 characters; the streaming decoder
  // must reassemble them (this app's streams are mostly Chinese text).
  const events: Array<{ message: string }> = [];
  await readNdjsonStream<{ message: string }>(
    streamFrom('{"message":"调仓日 2025-01-08 停牌"}\n{"message":"完成"}\n'),
    (e) => events.push(e),
  );
  assert.deepEqual(events, [{ message: "调仓日 2025-01-08 停牌" }, { message: "完成" }]);
});

test("readNdjsonStream parses a trailing line without a newline", async () => {
  const events: unknown[] = [];
  await readNdjsonStream(streamFrom('{"a":1}\n{"b":2}'), (e) => events.push(e));
  assert.deepEqual(events, [{ a: 1 }, { b: 2 }]);
});

test("readNdjsonStream reports a truncated trailing line instead of throwing", async () => {
  const events: unknown[] = [];
  const bad: string[] = [];
  await readNdjsonStream(
    streamFrom('{"a":1}\n{"b":'),
    (e) => events.push(e),
    (line) => bad.push(line),
  );
  assert.deepEqual(events, [{ a: 1 }]);
  assert.equal(bad.length, 1);
});
