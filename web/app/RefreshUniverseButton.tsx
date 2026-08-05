"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { readNdjsonStream } from "@/lib/ndjson";

interface RefreshResult {
  proposal: { rationale: string };
  applied: {
    added: { symbol: string; name: string; theme: string }[];
    rejected: { symbol: string; reason: string }[];
    removed: string[];
    reclassified: { symbol: string; from: string; to: string }[];
  };
  finalCount: number;
}

export default function RefreshUniverseButton({
  disabled = false,
}: {
  disabled?: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [logs, setLogs] = useState<string[]>([]);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [result, setResult] = useState<RefreshResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    setBusy(true);
    setLogs([]);
    setProgress(null);
    setResult(null);
    setError(null);
    try {
      const r = await fetch("/api/universe/refresh", { method: "POST" });
      if (!r.ok || !r.body) throw new Error(`HTTP ${r.status}`);
      let changed = false;
      type Evt =
        | { type: "log"; message: string }
        | { type: "progress"; done: number; total: number }
        | { type: "result"; result: RefreshResult }
        | { type: "error"; message: string };
      await readNdjsonStream<Evt>(r.body, (evt) => {
        if (evt.type === "log") setLogs((p) => [...p, evt.message]);
        else if (evt.type === "progress") setProgress({ done: evt.done, total: evt.total });
        else if (evt.type === "result") {
          setResult(evt.result);
          changed = (
            evt.result.applied.added.length > 0
            || evt.result.applied.removed.length > 0
            || evt.result.applied.reclassified.length > 0
          );
        }
        else if (evt.type === "error") setError(evt.message);
      }, (line) => {
        setLogs((p) => [...p, `跳过无法解析的响应行（${line.length} 字符）`]);
      });
      if (changed) router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const pct = progress && progress.total > 0 ? progress.done / progress.total : 0;

  return (
    <div>
      <button
        onClick={run}
        disabled={busy || disabled}
        title={disabled ? "生产部署为只读股票池：请在本地刷新，审查后提交部署" : undefined}
      >
        {busy ? "刷新中…" : "DeepSeek 刷新股票池"}
      </button>
      {disabled && (
        <span className="toolbar-status">只读部署：股票池刷新请在本地进行并提交</span>
      )}

      {(busy || logs.length > 0 || result || error) && (
        <div className="card" style={{ marginTop: 12, fontSize: 12 }}>
          {progress && progress.total > 0 && (
            <>
              <div style={{ display: "flex", justifyContent: "space-between" }}>
                <span>校验新增标的 {progress.done} / {progress.total}</span>
                <span style={{ color: "var(--muted)" }}>{(pct * 100).toFixed(0)}%</span>
              </div>
              <div style={{
                height: 6, marginTop: 6, background: "var(--subtle)",
                borderRadius: 3, overflow: "hidden", border: "1px solid var(--border)",
              }}>
                <div style={{
                  height: "100%", width: `${pct * 100}%`,
                  background: "var(--accent)", transition: "width 0.2s",
                }} />
              </div>
            </>
          )}
          {logs.length > 0 && (
            <pre style={{ marginTop: 8, whiteSpace: "pre-wrap", maxHeight: 160, overflow: "auto" }}>
              {logs.join("\n")}
            </pre>
          )}
          {error && <p style={{ color: "var(--danger)", marginTop: 8 }}>{error}</p>}
          {result && (
            <div style={{ marginTop: 8 }}>
              <p>{result.proposal.rationale}</p>
              <p style={{ color: "var(--muted)" }}>
                +{result.applied.added.length}
                {" / -"}{result.applied.removed.length}
                {" / 改类 "}{result.applied.reclassified.length}
                {" → 共 "}{result.finalCount} 只
              </p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
