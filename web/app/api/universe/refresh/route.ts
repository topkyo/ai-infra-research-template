import { NextRequest } from "next/server";
import { readUniverse } from "@/lib/universe";
import { proposeRefresh, applyRefresh } from "@/lib/universe-refresh";
import { refreshAuthError } from "@/lib/universe-refresh-auth";

export const runtime = "nodejs";
// proposeRefresh is one full-universe LLM call (same order of magnitude as /api/signals).
export const maxDuration = 900;

// NDJSON: progress / log / result / error
export async function POST(req: NextRequest) {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (obj: unknown) => {
        controller.enqueue(encoder.encode(JSON.stringify(obj) + "\n"));
      };
      try {
        // Frozen deployments (UNIVERSE_REFRESH_ENABLED=0, e.g. demos):
        // fail explicitly instead of silently accepting a refresh the caller
        // did not intend. Default is enabled — compose bind-mounts
        // data/ to the host git checkout so writes persist.
        if (process.env.UNIVERSE_REFRESH_ENABLED === "0") {
          send({
            type: "error",
            message: "当前部署为只读股票池：请在本地运行 cd web && npx tsx scripts/refresh-universe.ts，审查 diff 后提交部署",
          });
          controller.close();
          return;
        }
        const authError = refreshAuthError(req);
        if (authError) {
          send({ type: "error", message: authError });
          controller.close();
          return;
        }
        const current = readUniverse();
        send({ type: "log", message: `当前股票池 ${current.entries.length} 只，请求 LLM 提议变更…` });

        const proposal = await proposeRefresh(current);
        send({
          type: "log",
          message: `提议: +${proposal.adds.length} / -${proposal.removes.length} / 改类 ${proposal.reclassifies.length}`,
        });
        send({ type: "log", message: proposal.rationale });

        let validated = 0;
        const total = proposal.adds.filter(
          (a) => a.symbol && !current.entries.some((e) => e.symbol === a.symbol),
        ).length;
        send({ type: "progress", done: 0, total });

        const result = await applyRefresh(current, proposal, {
          onValidate: (symbol, ok) => {
            validated++;
            send({
              type: "log",
              message: `${ok ? "✓" : "✗"} 验证 ${symbol}`,
            });
            send({ type: "progress", done: validated, total });
          },
        });

        send({ type: "result", result });
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
