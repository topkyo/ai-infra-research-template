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

// Override for Docker: compose mounts ./private → /app/private and sets
// HOLDINGS_FILE so atomic tmp+rename works (single-file binds break rename).
export const HOLDINGS_FILE = (process.env.HOLDINGS_FILE?.trim()
  || path.join(process.cwd(), "data", "holdings.local.json"));
const HOLDINGS_FILE_DISPLAY = process.env.HOLDINGS_FILE?.trim()
  || "web/data/holdings.local.json";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function universeSymbolSet(entries?: UniverseEntry[]): Set<string> | undefined {
  return entries ? new Set(entries.map((entry) => entry.symbol)) : undefined;
}

export function validateHoldings(value: unknown, entries?: UniverseEntry[]): HoldingsFile {
  const universeSymbols = universeSymbolSet(entries);
  if (!isRecord(value)) {
    throw new Error("holdings.local.json must be a JSON object");
  }
  const cash = finiteNumber(value.cash);
  if (cash == null || cash < 0) {
    throw new Error("holdings.local.json cash must be a non-negative number");
  }
  if (!Array.isArray(value.positions)) {
    throw new Error("holdings.local.json positions must be an array");
  }

  const seen = new Set<string>();
  const positions = value.positions.map((item, index): HoldingPosition => {
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
    updated_at: typeof value.updated_at === "string" ? value.updated_at : undefined,
    cash,
    positions,
  };
}

export function writeHoldings(value: unknown, entries?: UniverseEntry[]): LoadedHoldings {
  const validated = validateHoldings(value, entries);
  fs.mkdirSync(path.dirname(HOLDINGS_FILE), { recursive: true });
  const withDate: HoldingsFile = {
    ...validated,
    updated_at: validated.updated_at ?? new Date().toISOString().slice(0, 10),
  };
  const tmpFile = `${HOLDINGS_FILE}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmpFile, `${JSON.stringify(withDate, null, 2)}\n`, "utf-8");
  fs.renameSync(tmpFile, HOLDINGS_FILE);
  return {
    fileFound: true,
    filePath: HOLDINGS_FILE,
    updated_at: withDate.updated_at,
    cash: withDate.cash,
    positions: withDate.positions,
    warnings: [],
  };
}

export function holdingsFileDisplayPath(): string {
  return HOLDINGS_FILE_DISPLAY;
}

export function readHoldings(entries?: UniverseEntry[]): LoadedHoldings {
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

  const holdings = validateHoldings(parsed, entries);

  return {
    fileFound: true,
    filePath: HOLDINGS_FILE,
    updated_at: holdings.updated_at,
    cash: holdings.cash,
    positions: holdings.positions,
    warnings: [],
  };
}
