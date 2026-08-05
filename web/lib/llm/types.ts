export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatOptions {
  model?: string;
  temperature?: number;
  responseFormat?: "json_object" | "text";
  ttlSeconds?: number;
  bypassCache?: boolean;
  timeoutMs?: number;
  transportMaxAttempts?: number;
}

export interface ChatResult {
  content: string;
  cacheHit: boolean;
}

export interface SymbolSnapshot {
  symbol: string;
  name?: string | null;
  theme?: string;
  closes: number[];      // last ~60 daily closes, oldest first
  fundamental?: {
    pe_ttm?: number | null;
    pb?: number | null;
    market_cap?: number | null;
    profit_yoy?: number | null;
  };
}

export type SignalSource = "llm-live" | "llm-cache" | "llm-mock";

export interface Signal {
  symbol: string;
  action: "buy" | "hold" | "sell";
  confidence: number;    // 0..1
  size: number;          // 0..1 fraction of available capital
  rationale: string;
  source?: SignalSource;
  dataQuality?: string[];
}

export interface PortfolioPositionInput {
  shares: number;
  costBasis: number;
  currentWeight: number;
  unrealizedPnlPct: number | null;
}

export interface PortfolioScoringSnapshot extends SymbolSnapshot {
  position?: PortfolioPositionInput | null;
}

export interface PortfolioTargetSignal {
  symbol: string;
  targetWeight: number;
  confidence: number;
  rationale: string;
  evidence: string[];
  risks: string[];
  invalidation: string;
  source?: SignalSource;
  dataQuality?: string[];
}
