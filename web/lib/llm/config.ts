export type LlmProvider = "deepseek" | "opencode-go" | "mock";

export interface LlmConfig {
  provider: LlmProvider;
  apiKey: string;
  baseUrl: string;
  chatCompletionsUrl: string;
  model: string;
  backtestModel: string;
}

const OPENCODE_GO_DEFAULT_BASE = "https://opencode.ai/zen/go/v1";
const DEEPSEEK_DEFAULT_BASE = "https://api.deepseek.com";

export function isMockApiKey(key: string | undefined): boolean {
  return !key || key === "mock" || key.startsWith("sk-xxxx");
}

function normalizeBase(url: string): string {
  return url.replace(/\/$/, "");
}

function resolveProvider(): LlmProvider {
  const explicit = process.env.LLM_PROVIDER?.trim().toLowerCase();
  if (explicit === "mock") {
    // Deterministic offline provider for e2e/tests; never a data source.
    return "mock";
  }
  if (explicit === "opencode-go" || explicit === "opencode_go" || explicit === "go") {
    return "opencode-go";
  }
  if (explicit === "deepseek" || explicit === "direct") {
    return "deepseek";
  }
  // Prefer direct DeepSeek when both keys exist; OpenCode Go is an explicit opt-in.
  const deepseekKey = process.env.DEEPSEEK_API_KEY;
  if (deepseekKey && !isMockApiKey(deepseekKey)) return "deepseek";
  const goKey = process.env.OPENCODE_GO_API_KEY;
  if (goKey && !isMockApiKey(goKey)) return "opencode-go";
  return "deepseek";
}

/** Resolve LLM endpoint + credentials (direct DeepSeek recommended, or OpenCode Go). */
export function resolveLlmConfig(): LlmConfig {
  const provider = resolveProvider();
  const model =
    process.env.LLM_MODEL ?? process.env.DEEPSEEK_MODEL ?? "deepseek-v4-flash";
  const backtestModel =
    process.env.LLM_MODEL_BACKTEST
    ?? process.env.DEEPSEEK_MODEL_BACKTEST
    ?? "deepseek-v4-flash";

  if (provider === "mock") {
    return {
      provider,
      apiKey: "",
      baseUrl: "",
      chatCompletionsUrl: "",
      model: "mock-llm",
      backtestModel: "mock-llm",
    };
  }

  if (provider === "opencode-go") {
    const apiKey = process.env.OPENCODE_GO_API_KEY ?? "";
    const baseUrl = normalizeBase(
      process.env.OPENCODE_GO_BASE_URL ?? OPENCODE_GO_DEFAULT_BASE,
    );
    return {
      provider,
      apiKey,
      baseUrl,
      chatCompletionsUrl: `${baseUrl}/chat/completions`,
      model,
      backtestModel,
    };
  }

  const apiKey = process.env.DEEPSEEK_API_KEY ?? "";
  const baseUrl = normalizeBase(
    process.env.DEEPSEEK_BASE_URL ?? DEEPSEEK_DEFAULT_BASE,
  );
  return {
    provider,
    apiKey,
    baseUrl,
    chatCompletionsUrl: `${baseUrl}/chat/completions`,
    model,
    backtestModel,
  };
}

export function llmApiKeyConfigured(cfg: LlmConfig = resolveLlmConfig()): boolean {
  return !isMockApiKey(cfg.apiKey);
}
