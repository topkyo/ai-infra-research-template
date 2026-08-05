// DeepSeek v4 client — public barrel re-exporting llm/* modules.
export type {
  ChatMessage,
  ChatOptions,
  ChatResult,
  PortfolioPositionInput,
  PortfolioScoringSnapshot,
  PortfolioTargetSignal,
  Signal,
  SignalSource,
  SymbolSnapshot,
} from "./llm/types";

export {
  chat,
  chatDetailed,
  isRetryableTransportError,
  LlmHttpError,
  retryDelayMs,
} from "./llm/transport";

export { scorePortfolioTargets } from "./llm/score-portfolio";
export { scoreSymbols } from "./llm/score-symbols";
