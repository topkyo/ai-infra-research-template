"use client";
import { useEffect, useMemo, useState } from "react";
import type { UniverseEntry } from "@/lib/universe";

interface Analyst {
  buy_count?: number;
  total_count?: number;
  buy_ratio?: number | null;
  consensus_eps_next?: number | null;
  implied_target?: number | null;
  current_price?: number | null;
  upside_pct?: number | null;
}

type Row = UniverseEntry & { analyst?: Analyst | null; loading?: boolean };

const CONCURRENCY = 4;

async function fetchAnalystFor(symbol: string): Promise<Analyst | null> {
  try {
    const r = await fetch(`/api/analyst?symbol=${encodeURIComponent(symbol)}`);
    if (!r.ok) return null;
    return (await r.json()) as Analyst;
  } catch {
    return null;
  }
}

export default function UniverseTable({ entries }: { entries: UniverseEntry[] }) {
  const [rows, setRows] = useState<Row[]>(() =>
    entries.map((e) => ({ ...e, loading: true })),
  );
  const [onlyGlobal, setOnlyGlobal] = useState(false);
  const [onlyUpside, setOnlyUpside] = useState(false);
  const [query, setQuery] = useState("");
  const [theme, setTheme] = useState("all");

  // Re-seed when entries prop changes (after refresh).
  useEffect(() => {
    setRows(entries.map((e) => ({ ...e, loading: true })));
  }, [entries]);

  // Fetch analyst data in a small concurrency pool.
  useEffect(() => {
    let cancelled = false;
    const queue = [...entries];
    let active = 0;
    function pump() {
      while (active < CONCURRENCY && queue.length > 0) {
        const e = queue.shift()!;
        active++;
        fetchAnalystFor(e.symbol).then((a) => {
          if (cancelled) return;
          setRows((prev) =>
            prev.map((r) =>
              r.symbol === e.symbol ? { ...r, analyst: a, loading: false } : r,
            ),
          );
          active--;
          pump();
        });
      }
    }
    pump();
    return () => {
      cancelled = true;
    };
  }, [entries]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return rows.filter((r) => {
      if (onlyGlobal && !r.global_supply) return false;
      if (theme !== "all" && r.theme !== theme) return false;
      if (q && !`${r.symbol} ${r.name} ${r.theme} ${r.note ?? ""}`.toLowerCase().includes(q)) return false;
      if (onlyUpside) {
        const u = r.analyst?.upside_pct;
        if (u === undefined || u === null || u <= 0) return false;
      }
      return true;
    });
  }, [rows, onlyGlobal, onlyUpside, query, theme]);

  const loadedCount = rows.filter((r) => !r.loading).length;
  const ratedCount = rows.filter((r) => r.analyst?.buy_count != null && r.analyst?.total_count).length;
  const upsideCount = rows.filter((r) => (r.analyst?.upside_pct ?? 0) > 0).length;
  const themes = useMemo(() => [...new Set(entries.map((e) => e.theme))].sort(), [entries]);
  const grouped = filtered.reduce<Record<string, Row[]>>((acc, r) => {
    (acc[r.theme] ??= []).push(r);
    return acc;
  }, {});

  return (
    <>
      <div className="toolbar">
        <div className="field">
          <span>搜索</span>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="代码、名称、主题"
          />
        </div>
        <div className="field">
          <span>主题</span>
          <select value={theme} onChange={(e) => setTheme(e.target.value)}>
            <option value="all">全部主题</option>
            {themes.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
        </div>
        <label className="check">
          <input type="checkbox" checked={onlyGlobal} onChange={(e) => setOnlyGlobal(e.target.checked)} />
          <span>全球供应链</span>
        </label>
        <label className="check">
          <input type="checkbox" checked={onlyUpside} onChange={(e) => setOnlyUpside(e.target.checked)} />
          <span>目标价高于现价</span>
        </label>
        <div className="toolbar-status">
          显示 {filtered.length}/{rows.length} · 价格 {loadedCount}/{rows.length} · 评级 {ratedCount} · 上行 {upsideCount}
        </div>
      </div>

      <div className="theme-grid">
        {Object.entries(grouped).map(([theme, items]) => (
          <div key={theme} className="theme-panel">
            <div className="theme-title">
              <strong>{theme}</strong>
              <span>{items.length} 只</span>
            </div>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>代码</th>
                    <th>名称</th>
                    <th>全球链</th>
                    <th className="num">现价</th>
                    <th className="num">目标价</th>
                    <th className="num">上行</th>
                    <th className="num">买入评级</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((r) => {
                    const u = r.analyst?.upside_pct;
                    return (
                      <tr key={r.symbol}>
                        <td className="mono">{r.symbol}</td>
                        <td>
                          <div className="stock-name">{r.name}</div>
                          {r.note && <div className="stock-note">{r.note}</div>}
                        </td>
                        <td>{r.global_supply ? <span className="pill good">是</span> : <span className="pill">否</span>}</td>
                        <td className="num">{r.analyst?.current_price?.toFixed(2) ?? (r.loading ? "…" : "无")}</td>
                        <td className="num">{r.analyst?.implied_target?.toFixed(2) ?? (r.loading ? "…" : "无")}</td>
                        <td className={`num ${u == null ? "muted" : u > 0 ? "pos" : "neg"}`}>
                          {u == null ? (r.loading ? "…" : "无") : `${u > 0 ? "+" : ""}${u.toFixed(0)}%`}
                        </td>
                        <td className="num muted">
                          {r.analyst?.buy_count != null && r.analyst?.total_count
                            ? `${r.analyst.buy_count}/${r.analyst.total_count}`
                            : r.loading ? "…" : "无"}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        ))}
      </div>
    </>
  );
}
