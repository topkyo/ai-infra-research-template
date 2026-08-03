"use client";

import { useRef, useState } from "react";
import { readNdjsonStream } from "@/lib/ndjson";
import type { UniverseEntry } from "@/lib/universe";

export type Phase = "loading" | "scoring";
export type PortfolioAction = "open" | "add" | "hold" | "trim" | "exit" | "watch";
export type PortfolioMode = "real" | "paper";

export interface Progress {
  phase: Phase;
  done: number;
  total: number;
}

export interface SignalRow {
  entry: UniverseEntry;
  snapshot: {
    symbol: string;
    name?: string | null;
    theme?: string;
    latestDate?: string | null;
    closes: number[];
    dataErrors?: string[];
    fundamentalSource?: string | null;
    fundamentalFieldSources?: Record<string, string> | null;
    fundamental?: {
      pe_ttm?: number | null;
      pb?: number | null;
      market_cap?: number | null;
      profit_yoy?: number | null;
    };
  };
  position: {
    symbol: string;
    shares: number;
    costBasis: number;
    currentPrice: number;
    currentValue: number;
    currentWeight: number;
    unrealizedPnlPct: number | null;
  } | null;
  recommendation: {
    action: PortfolioAction;
    targetWeight: number;
    adjustedTargetWeight: number;
    deltaWeight: number;
    targetValue: number;
    deltaValue: number;
    confidence: number;
    rationale: string;
    evidence: string[];
    risks: string[];
    invalidation: string;
    source?: "llm-live" | "llm-cache" | "llm-mock";
    dataQuality?: string[];
    constraintWarnings: string[];
  };
}

export interface PortfolioContext {
  mode: PortfolioMode;
  cash: number;
  equity: number;
  maxPositions: number;
  asOf: string;
  holdingsUpdatedAt?: string;
  holdingsFileFound: boolean;
  warnings: string[];
}

export interface SetupRequired {
  code: "holdings_missing" | "holdings_invalid";
  message: string;
  filePath: string;
}

interface UseSignalStreamOptions {
  mode: PortfolioMode;
  paperCash: number;
}

export function useSignalStream({ mode, paperCash }: UseSignalStreamOptions) {
  const [rows, setRows] = useState<SignalRow[]>([]);
  const [portfolio, setPortfolio] = useState<PortfolioContext | null>(null);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [setupRequired, setSetupRequired] = useState<SetupRequired | null>(null);
  const [notices, setNotices] = useState<string[]>([]);

  const abortRef = useRef<AbortController | null>(null);
  const runTokenRef = useRef(0);

  function resetOutput() {
    setError(null);
    setRows([]);
    setPortfolio(null);
    setProgress(null);
    setSetupRequired(null);
    setNotices([]);
  }

  async function run(requestedMode = mode) {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    runTokenRef.current += 1;
    const token = runTokenRef.current;
    setLoading(true);
    resetOutput();
    try {
      const response = await fetch("/api/signals", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mode: requestedMode,
          paperCash: requestedMode === "paper" ? paperCash : undefined,
        }),
        signal: controller.signal,
      });
      if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);
      type Evt =
        | { type: "progress"; phase: Phase; done: number; total: number }
        | { type: "result"; portfolio: PortfolioContext; rows: SignalRow[] }
        | { type: "setup_required"; code: "holdings_missing" | "holdings_invalid"; message: string; filePath: string }
        | { type: "error"; message: string };
      await readNdjsonStream<Evt>(response.body, (evt) => {
        if (token !== runTokenRef.current) return;
        if (evt.type === "progress") {
          setProgress({ phase: evt.phase, done: evt.done, total: evt.total });
        } else if (evt.type === "result") {
          setRows(evt.rows);
          setPortfolio(evt.portfolio);
        } else if (evt.type === "setup_required") {
          setRows([]);
          setPortfolio(null);
          setSetupRequired({
            code: evt.code,
            message: evt.message,
            filePath: evt.filePath,
          });
        } else {
          setRows([]);
          setPortfolio(null);
          setError(evt.message);
        }
      }, (line) => {
        if (token !== runTokenRef.current) return;
        setNotices((prev) => [...prev, `跳过无法解析的响应行（${line.length} 字符）`]);
      });
    } catch (e) {
      if (e instanceof Error && e.name === "AbortError") return;
      if (token !== runTokenRef.current) return;
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (token === runTokenRef.current) setLoading(false);
    }
  }

  return {
    rows,
    portfolio,
    progress,
    loading,
    error,
    setupRequired,
    notices,
    setError,
    setSetupRequired,
    run,
    resetOutput,
  };
}
