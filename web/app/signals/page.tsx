import { loadEntries } from "@/lib/universe";
import { fetchKlines, fetchFundamental } from "@/lib/pyserver";
import { scoreSymbols, type SymbolSnapshot } from "@/lib/deepseek";
import Link from "next/link";

export const dynamic = "force-dynamic";

async function loadSignals() {
  const universe = loadEntries();
  const start = (() => {
    const d = new Date();
    d.setDate(d.getDate() - 90);
    return d.toISOString().slice(0, 10).replaceAll("-", "");
  })();

  const snapshots: SymbolSnapshot[] = await Promise.all(
    universe.map(async (e) => {
      const [klines, fund] = await Promise.all([
        fetchKlines(e.symbol, start).catch(() => []),
        fetchFundamental(e.symbol).catch(() => undefined),
      ]);
      return {
        symbol: e.symbol,
        name: e.name,
        theme: e.theme,
        closes: klines.map((k) => k.close),
        fundamental: fund
          ? { pe_ttm: fund.pe_ttm, pb: fund.pb, market_cap: fund.market_cap }
          : undefined,
      };
    }),
  );

  const usable = snapshots.filter((s) => s.closes.length >= 10);
  const signals = await scoreSymbols(usable);
  const byId = new Map(signals.map((s) => [s.symbol, s]));

  return universe.map((e) => ({
    entry: e,
    snapshot: snapshots.find((s) => s.symbol === e.symbol),
    signal: byId.get(e.symbol),
  }));
}

export default async function SignalsPage() {
  let rows: Awaited<ReturnType<typeof loadSignals>> = [];
  let error: string | null = null;
  try {
    rows = await loadSignals();
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }

  return (
    <div className="container">
      <Link href="/">← 返回</Link>
      <h1>实时信号</h1>
      {error && (
        <div className="card" style={{ borderColor: "var(--danger)" }}>
          <strong>加载失败：</strong> {error}
          <p style={{ color: "var(--muted)" }}>
            请确认 pyserver 运行在 <code>{process.env.PYSERVER_URL ?? "http://localhost:8001"}</code>，
            且 <code>DEEPSEEK_API_KEY</code> 已配置。
          </p>
        </div>
      )}
      {!error && (
        <table className="card" style={{ marginTop: 16 }}>
          <thead>
            <tr>
              <th>代码</th>
              <th>名称</th>
              <th>主题</th>
              <th>动作</th>
              <th>置信度</th>
              <th>仓位</th>
              <th>PE(TTM)</th>
              <th>理由</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ entry, signal, snapshot }) => (
              <tr key={entry.symbol}>
                <td style={{ color: "var(--muted)" }}>{entry.symbol}</td>
                <td>{entry.name}</td>
                <td>{entry.theme}</td>
                <td>
                  {signal ? (
                    <span className={`badge ${signal.action}`}>{signal.action}</span>
                  ) : (
                    <span className="badge">n/a</span>
                  )}
                </td>
                <td>{signal ? (signal.confidence * 100).toFixed(0) + "%" : "—"}</td>
                <td>{signal ? (signal.size * 100).toFixed(0) + "%" : "—"}</td>
                <td>{snapshot?.fundamental?.pe_ttm?.toFixed(1) ?? "—"}</td>
                <td style={{ color: "var(--muted)", maxWidth: 320 }}>
                  {signal?.rationale ?? "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
