// Shared NDJSON stream reader for the streaming API routes
// (/api/signals, /api/backtest, /api/universe/refresh).
//
// A single malformed line (proxy truncation, injected error page) is skipped
// and reported via onBadLine instead of aborting the whole stream and losing
// events already received. Skips are never silent: callers should surface
// onBadLine in the UI log.
export async function readNdjsonStream<T>(
  body: ReadableStream<Uint8Array>,
  onEvent: (evt: T) => void,
  onBadLine?: (line: string) => void,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  const handleLine = (line: string) => {
    if (!line) return;
    let evt: T;
    try {
      evt = JSON.parse(line) as T;
    } catch {
      onBadLine?.(line);
      return;
    }
    // Handler errors are bugs, not bad data — let them propagate to the
    // caller's catch instead of being misreported as unparseable lines.
    onEvent(evt);
  };
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        handleLine(line);
      }
    }
    // Flush any incomplete multibyte sequence held by the streaming decoder,
    // then handle trailing bytes without a newline (still a full event if it
    // parses; otherwise reported via onBadLine).
    buf += decoder.decode();
    if (buf.trim()) handleLine(buf);
  } finally {
    reader.releaseLock();
  }
}
