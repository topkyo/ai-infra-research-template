import { NextRequest } from "next/server";
import { scorePortfolioTargets, type PortfolioScoringSnapshot, type SymbolSnapshot } from "@/lib/deepseek";
import { mapPool } from "@/lib/concurrent";
import { fetchKlines, fetchFundamental } from "@/lib/pyserver";
import { loadEntries } from "@/lib/universe";
import { readHoldings } from "@/lib/holdings";
import { buildPortfolioContext, buildPortfolioRows, DEFAULT_MAX_POSITIONS } from "@/lib/portfolio";

export const runtime = "nodejs";
// Batched scoring: ~ceil(pool/batchSize) serial LLM calls; allow up to ~1h on large pools.
export const maxDuration = 3600;

function envPositiveInt(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

const LOAD_CONCURRENCY = Number(process.env.SIGNALS_LOAD_CONCURRENCY ?? 3);
const SIGNALS_PYSERVER_TIMEOUT_MS = Number(process.env.SIGNALS_PYSERVER_TIMEOUT_MS ?? 120_000);
const SIGNALS_FUNDAMENTAL_TIMEOUT_MS = Number(process.env.SIGNALS_FUNDAMENTAL_TIMEOUT_MS ?? 8_000);
const SIGNALS_LLM_SCORE_BATCH_SIZE = envPositiveInt(
  "SIGNALS_LLM_SCORE_BATCH_SIZE",
  envPositiveInt("LLM_SCORE_BATCH_SIZE", 10),
);
const DEFAULT_PAPER_CASH = 1_000_000;

type PortfolioMode = "real" | "paper";

function parsePaperCash(value: unknown): number {
  if (value == null) return DEFAULT_PAPER_CASH;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new Error("paperCash must be a positive number");
  }
  return value;
}

function setupRequiredMessage() {
  return "未找到真实持仓文件。可以先用模拟资金运行，或配置本地持仓后生成真实调仓差额。";
}

type LiveSnapshot = SymbolSnapshot & {
  latestDate?: string | null;
  dataErrors?: string[];
  fundamentalSource?: string | null;
  fundamentalFieldSources?: Record<string, string> | null;
};

function startDate90d(): string {
  const d = new Date();
  d.setDate(d.getDate() - 90);
  return d.toISOString().slice(0, 10).replaceAll("-", "");
}

export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as { mode?: unknown; paperCash?: unknown };
  const mode: PortfolioMode = body.mode === "paper" ? "paper" : "real";
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (obj: unknown) => {
        controller.enqueue(encoder.encode(JSON.stringify(obj) + "\n"));
      };
      try {
        const universe = loadEntries();
        const paperCash = mode === "paper" ? parsePaperCash(body.paperCash) : DEFAULT_PAPER_CASH;
        const holdings = mode === "paper"
          ? {
              fileFound: false,
              filePath: "web/data/holdings.local.json",
              cash: paperCash,
              positions: [],
              warnings: ["模拟资金模式：目标金额仅用于人工推演，不代表真实持仓。"],
            }
          : readHoldings(universe);
        if (mode === "real" && !holdings.fileFound) {
          send({
            type: "setup_required",
            code: "holdings_missing",
            message: setupRequiredMessage(),
            filePath: "web/data/holdings.local.json",
          });
          controller.close();
          return;
        }
        const start = startDate90d();
        let loaded = 0;
        send({ type: "progress", phase: "loading", done: 0, total: universe.length });
        const snapshots: LiveSnapshot[] = await mapPool(universe, LOAD_CONCURRENCY, async (entry) => {
          const [klinesRes, fundRes] = await Promise.allSettled([
            fetchKlines(entry.symbol, start, undefined, SIGNALS_PYSERVER_TIMEOUT_MS),
            fetchFundamental(entry.symbol, SIGNALS_FUNDAMENTAL_TIMEOUT_MS),
          ]);
          loaded++;
          send({ type: "progress", phase: "loading", done: loaded, total: universe.length });
          if (klinesRes.status !== "fulfilled") {
            throw new Error(`${entry.symbol} kline failed: ${klinesRes.reason instanceof Error ? klinesRes.reason.message : String(klinesRes.reason)}`);
          }
          const klines = klinesRes.value;
          const fund = fundRes.status === "fulfilled" ? fundRes.value : undefined;
          return {
            symbol: entry.symbol,
            name: entry.name,
            theme: entry.theme,
            latestDate: klines.at(-1)?.date ?? null,
            closes: klines.map((k) => k.close),
            fundamentalSource: fund?.source ?? null,
            fundamentalFieldSources: fund?.field_sources ?? null,
            dataErrors: [
              fundRes.status === "rejected"
                ? `fundamental failed: ${fundRes.reason instanceof Error ? fundRes.reason.message : String(fundRes.reason)}`
                : undefined,
              ...(fund?.warnings ?? []).map((warning) => `fundamental warning: ${warning}`),
            ].filter((message): message is string => Boolean(message)),
            fundamental: fund
              ? {
                  pe_ttm: fund.pe_ttm,
                  pb: fund.pb,
                  market_cap: fund.market_cap,
                  profit_yoy: fund.profit_yoy,
                }
              : undefined,
          };
        });

        const missingKlines = snapshots.filter((s) => s.closes.length < 10);
        if (missingKlines.length > 0) {
          throw new Error(`live kline data insufficient: ${missingKlines.map((s) => s.symbol).join(",")}`);
        }

        const asOf = snapshots
          .map((snapshot) => snapshot.latestDate)
          .filter((date): date is string => Boolean(date))
          .sort()
          .at(-1) ?? new Date().toISOString().slice(0, 10);
        const { portfolio, positions } = buildPortfolioContext(
          holdings,
          snapshots,
          asOf,
          DEFAULT_MAX_POSITIONS,
          mode,
        );
        const scoringSnapshots: PortfolioScoringSnapshot[] = snapshots.map((snapshot) => ({
          ...snapshot,
          position: positions.get(snapshot.symbol) ?? null,
        }));
        send({ type: "progress", phase: "scoring", done: 0, total: snapshots.length });
        const targets = await scorePortfolioTargets(scoringSnapshots, {
          asOf,
          batchSize: SIGNALS_LLM_SCORE_BATCH_SIZE,
          onBatchProgress: (done, total) => send({ type: "progress", phase: "scoring", done, total }),
        });
        send({ type: "progress", phase: "scoring", done: snapshots.length, total: snapshots.length });
        const rows = buildPortfolioRows(universe, snapshots, targets, positions, portfolio);
        send({ type: "result", portfolio, rows });
        controller.close();
      } catch (e) {
        send({ type: "error", message: e instanceof Error ? e.message : String(e) });
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Accel-Buffering": "no",
    },
  });
}
