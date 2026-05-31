import { NextRequest, NextResponse } from "next/server";
import { holdingsFileDisplayPath, readHoldings, writeHoldings } from "@/lib/holdings";
import { loadEntries } from "@/lib/universe";

export const runtime = "nodejs";

function errorResponse(message: string, status = 400) {
  return NextResponse.json({ ok: false, error: message }, { status });
}

export async function GET() {
  try {
    const universe = loadEntries();
    const holdings = readHoldings(universe);
    return NextResponse.json({
      ok: true,
      fileFound: holdings.fileFound,
      filePath: holdingsFileDisplayPath(),
      holdings: holdings.fileFound
        ? {
            updated_at: holdings.updated_at,
            cash: holdings.cash,
            positions: holdings.positions,
          }
        : undefined,
      warnings: holdings.warnings,
    });
  } catch (e) {
    return errorResponse(e instanceof Error ? e.message : String(e));
  }
}

export async function PUT(req: NextRequest) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return errorResponse("request body must be JSON");
  }

  try {
    const universe = loadEntries();
    const holdings = writeHoldings(body, universe);
    return NextResponse.json({
      ok: true,
      holdings: {
        updated_at: holdings.updated_at,
        cash: holdings.cash,
        positions: holdings.positions,
      },
    });
  } catch (e) {
    return errorResponse(e instanceof Error ? e.message : String(e));
  }
}
