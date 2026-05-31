// Local manual portfolio loader. holdings.local.json is intentionally ignored
// because it may contain private position and cash information.
import fs from "node:fs";
import path from "node:path";
import type { UniverseEntry } from "./universe";

export interface HoldingPosition {
  symbol: string;
  shares: number;
  cost_basis: number;
}

export interface HoldingsFile {
  $schema_note?: string;
  updated_at?: string;
  cash: number;
  positions: HoldingPosition[];
}

export interface LoadedHoldings {
  fileFound: boolean;
  filePath: string;
  updated_at?: string;
  cash: number;
  positions: HoldingPosition[];
  warnings: string[];
}

export const HOLDINGS_FILE = path.join(process.cwd(), "data", "holdings.local.json");

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function readHoldings(entries?: UniverseEntry[]): LoadedHoldings {
  const universeSymbols = entries ? new Set(entries.map((entry) => entry.symbol)) : undefined;
  if (!fs.existsSync(HOLDINGS_FILE)) {
    return {
      fileFound: false,
      filePath: HOLDINGS_FILE,
      cash: 0,
      positions: [],
      warnings: ["holdings.local.json not found; treating portfolio as empty"],
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(HOLDINGS_FILE, "utf-8")) as unknown;
  } catch (e) {
    throw new Error(`holdings.local.json invalid JSON: ${e instanceof Error ? e.message : String(e)}`);
  }

  if (!isRecord(parsed)) {
    throw new Error("holdings.local.json must be a JSON object");
  }
  const cash = finiteNumber(parsed.cash);
  if (cash == null || cash < 0) {
    throw new Error("holdings.local.json cash must be a non-negative number");
  }
  if (!Array.isArray(parsed.positions)) {
    throw new Error("holdings.local.json positions must be an array");
  }

  const seen = new Set<string>();
  const positions = parsed.positions.map((item, index): HoldingPosition => {
    if (!isRecord(item)) {
      throw new Error(`holdings.local.json positions[${index}] must be an object`);
    }
    const symbol = typeof item.symbol === "string" ? item.symbol.trim() : "";
    if (!symbol) {
      throw new Error(`holdings.local.json positions[${index}].symbol is required`);
    }
    if (seen.has(symbol)) {
      throw new Error(`holdings.local.json duplicate position symbol ${symbol}`);
    }
    seen.add(symbol);
    if (universeSymbols && !universeSymbols.has(symbol)) {
      throw new Error(`holdings.local.json position ${symbol} is not in universe`);
    }

    const shares = finiteNumber(item.shares);
    if (shares == null || shares <= 0) {
      throw new Error(`holdings.local.json ${symbol} shares must be a positive number`);
    }
    const costBasis = finiteNumber(item.cost_basis);
    if (costBasis == null || costBasis < 0) {
      throw new Error(`holdings.local.json ${symbol} cost_basis must be a non-negative number`);
    }
    return {
      symbol,
      shares,
      cost_basis: costBasis,
    };
  });

  return {
    fileFound: true,
    filePath: HOLDINGS_FILE,
    updated_at: typeof parsed.updated_at === "string" ? parsed.updated_at : undefined,
    cash,
    positions,
    warnings: [],
  };
}
