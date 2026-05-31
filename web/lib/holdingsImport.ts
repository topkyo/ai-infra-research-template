import type { HoldingPosition } from "./holdings";

export interface HoldingsImportResult {
  cash?: number;
  positions: HoldingPosition[];
  errors: string[];
}

const SYMBOL_HEADERS = new Set(["symbol", "证券代码", "代码", "股票代码"]);
const SHARES_HEADERS = new Set(["shares", "持仓数量", "数量", "股份数量", "可用数量"]);
const COST_HEADERS = new Set(["cost_basis", "cost basis", "成本价", "持仓成本", "成本"]);
const CASH_HEADERS = new Set(["cash", "现金", "可用资金", "可用金额"]);

function splitDelimitedLine(line: string, delimiter: string): string[] {
  const cells: string[] = [];
  let current = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === "\"") {
      if (quoted && line[i + 1] === "\"") {
        current += "\"";
        i++;
      } else {
        quoted = !quoted;
      }
    } else if (char === delimiter && !quoted) {
      cells.push(current.trim());
      current = "";
    } else {
      current += char;
    }
  }
  cells.push(current.trim());
  return cells.map((cell) => cell.replace(/^"(.*)"$/s, "$1").trim());
}

function parseRows(text: string): string[][] {
  const lines = text
    .replaceAll("\r\n", "\n")
    .replaceAll("\r", "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) return [];
  const first = lines[0];
  const delimiter = first.includes("\t") ? "\t" : ",";
  if (!first.includes(delimiter)) {
    return lines.map((line) => line.split(/\s+/).map((cell) => cell.trim()).filter(Boolean));
  }
  return lines.map((line) => splitDelimitedLine(line, delimiter));
}

function normalizeHeader(value: string): string {
  return value.trim().toLowerCase();
}

function findHeader(headers: string[], aliases: Set<string>): number {
  return headers.findIndex((header) => aliases.has(normalizeHeader(header)));
}

function normalizeSymbol(value: string): string {
  const trimmed = value.trim().toUpperCase();
  const sixDigits = trimmed.match(/\d{6}/)?.[0];
  if (sixDigits) return sixDigits;
  if (/^\d{1,5}$/.test(trimmed)) return trimmed.padStart(6, "0");
  return trimmed;
}

function parseNumber(value: string): number | null {
  const normalized = value.replaceAll(",", "").replaceAll("%", "").trim();
  if (!normalized) return null;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

export function parseHoldingsText(text: string): HoldingsImportResult {
  const rows = parseRows(text);
  if (rows.length === 0) {
    return { positions: [], errors: ["请粘贴包含表头的持仓明细"] };
  }

  const headers = rows[0];
  const symbolIndex = findHeader(headers, SYMBOL_HEADERS);
  const sharesIndex = findHeader(headers, SHARES_HEADERS);
  const costIndex = findHeader(headers, COST_HEADERS);
  const cashIndex = findHeader(headers, CASH_HEADERS);
  const errors: string[] = [];

  if (symbolIndex < 0) errors.push("缺少证券代码列");
  if (sharesIndex < 0) errors.push("缺少持仓数量列");
  if (costIndex < 0) errors.push("缺少成本价列");
  if (errors.length > 0) return { positions: [], errors };

  const positions: HoldingPosition[] = [];
  let cash: number | undefined;
  const seen = new Set<string>();
  rows.slice(1).forEach((row, offset) => {
    const rowNumber = offset + 2;
    const symbol = normalizeSymbol(row[symbolIndex] ?? "");
    const shares = parseNumber(row[sharesIndex] ?? "");
    const costBasis = parseNumber(row[costIndex] ?? "");
    if (!symbol) {
      errors.push(`第 ${rowNumber} 行缺少证券代码`);
      return;
    }
    if (seen.has(symbol)) {
      errors.push(`第 ${rowNumber} 行重复证券代码 ${symbol}`);
      return;
    }
    seen.add(symbol);
    if (shares == null || shares <= 0) {
      errors.push(`第 ${rowNumber} 行 ${symbol} 持仓数量无效`);
      return;
    }
    if (costBasis == null || costBasis < 0) {
      errors.push(`第 ${rowNumber} 行 ${symbol} 成本价无效`);
      return;
    }
    positions.push({ symbol, shares, cost_basis: costBasis });

    if (cashIndex >= 0 && cash == null) {
      const parsedCash = parseNumber(row[cashIndex] ?? "");
      if (parsedCash != null) cash = parsedCash;
    }
  });

  if (positions.length === 0 && errors.length === 0) {
    errors.push("没有可导入的持仓行");
  }
  if (cash != null && cash < 0) {
    errors.push("现金不能为负数");
    cash = undefined;
  }
  return { cash, positions, errors };
}
