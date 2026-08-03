"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { readNdjsonStream } from "@/lib/ndjson";

const TOKEN_STORAGE_KEY = "topkyo.universeRefreshToken";

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
  tokenConfigured = true,
}: {
  disabled?: boolean;
  /** Server knows UNIVERSE_REFRESH_TOKEN is set; UI still needs the operator to paste it. */
  tokenConfigured?: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [token, setToken] = useState("");
  const [logs, setLogs] = useState<string[]>([]);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [result, setResult] = useState<RefreshResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    try {
      setToken(sessionStorage.getItem(TOKEN_STORAGE_KEY) ?? "");
    } catch {
      // sessionStorage may be unavailable; operator can still paste per click.
    }
  }, []);

  async function run() {
    setBusy(true);
    setLogs([]);
    setProgress(null);
    setResult(null);
    setError(null);
    const trimmed = token.trim();
    if (!trimmed) {
      setError("请填写与环境变量 UNIVERSE_REFRESH_TOKEN 相同的刷新令牌");
      setBusy(false);
      return;
    }
    try {
      try {
        sessionStorage.setItem(TOKEN_STORAGE_KEY, trimmed);
      } catch {
        // ignore quota / private-mode failures
      }
      const r = await fetch("/api/universe/refresh", {
        method: "POST",
        headers: { "x-universe-refresh-token": trimmed },
      });
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
      {!disabled && (
        <label className="toolbar-status" style={{ display: "inline-flex", alignItems: "center", gap: 8, marginRight: 8 }}>
          <span>刷新令牌</span>
          <input
            type="password"
            autoComplete="off"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder="UNIVERSE_REFRESH_TOKEN"
            disabled={busy}
            style={{ width: 180 }}
          />
        </label>
      )}
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
      {!disabled && !tokenConfigured && (
        <span className="toolbar-status">服务端未配置 UNIVERSE_REFRESH_TOKEN，刷新会被拒绝</span>
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
                  background: "var(--accent)", transition: "width 0.2s ease",
                }} />
              </div>
            </>
          )}
          <div style={{ marginTop: 8, color: "var(--muted)", maxHeight: 200, overflow: "auto" }}>
            {logs.map((l, i) => <div key={i}>· {l}</div>)}
          </div>
          {error && <div style={{ color: "var(--danger)", marginTop: 8 }}>{error}</div>}
          {result && (
            <div style={{ marginTop: 10 }}>
              <strong>刷新完成</strong> · 当前 {result.finalCount} 只
              <div style={{ marginTop: 4 }}>
                新增 {result.applied.added.length} · 移除 {result.applied.removed.length} · 改类 {result.applied.reclassified.length} · 拒绝 {result.applied.rejected.length}
              </div>
              {result.applied.added.length > 0 && (
                <div style={{ marginTop: 6, color: "var(--accent)" }}>
                  + {result.applied.added.map((a) => `${a.symbol} ${a.name}(${a.theme})`).join("、")}
                </div>
              )}
              {result.applied.rejected.length > 0 && (
                <div style={{ marginTop: 6, color: "var(--danger)" }}>
                  拒绝：{result.applied.rejected.map((r) => `${r.symbol}: ${r.reason}`).join("; ")}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
