import type { PortfolioAction } from "./useSignalStream";

export function calcPeg(pe?: number | null, profitYoyPct?: number | null) {
  if (pe == null || profitYoyPct == null || pe <= 0 || profitYoyPct <= 0) return null;
  return pe / profitYoyPct;
}

export function formatFieldSources(sources?: Record<string, string> | null): string {
  if (!sources || Object.keys(sources).length === 0) return "—";
  return Object.entries(sources)
    .filter(([field]) => ["pe_ttm", "pb", "market_cap", "profit_yoy"].includes(field))
    .map(([field, source]) => `${field}:${source}`)
    .join("; ") || "—";
}

export function formatPct(value: number | null | undefined, digits = 1): string {
  if (value == null || !Number.isFinite(value)) return "—";
  return `${(value * 100).toFixed(digits)}%`;
}

export function formatSignedPct(value: number | null | undefined, digits = 1): string {
  if (value == null || !Number.isFinite(value)) return "—";
  const pct = value * 100;
  return `${pct > 0 ? "+" : ""}${pct.toFixed(digits)}%`;
}

export function formatMoney(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "—";
  return value.toLocaleString("zh-CN", { maximumFractionDigits: 0 });
}

export const ACTION_LABEL: Record<PortfolioAction, string> = {
  open: "建仓",
  add: "加仓",
  hold: "持有",
  trim: "减仓",
  exit: "清仓",
  watch: "观望",
};
