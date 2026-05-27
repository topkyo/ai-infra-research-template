import { test } from "node:test";
import assert from "node:assert/strict";

test("resolveLlmConfig picks opencode-go when LLM_PROVIDER set", async () => {
  process.env.LLM_PROVIDER = "opencode-go";
  process.env.OPENCODE_GO_API_KEY = "sk-test-key";
  process.env.OPENCODE_GO_BASE_URL = "https://opencode.ai/zen/go/v1";
  const { resolveLlmConfig } = await import("../lib/llm/config");
  const cfg = resolveLlmConfig();
  assert.equal(cfg.provider, "opencode-go");
  assert.equal(cfg.chatCompletionsUrl, "https://opencode.ai/zen/go/v1/chat/completions");
  assert.equal(cfg.model, "deepseek-v4-flash");
  delete process.env.LLM_PROVIDER;
  delete process.env.OPENCODE_GO_API_KEY;
  delete process.env.OPENCODE_GO_BASE_URL;
});

test("resolveLlmConfig picks direct deepseek when LLM_PROVIDER=deepseek", async () => {
  process.env.LLM_PROVIDER = "deepseek";
  process.env.DEEPSEEK_API_KEY = "sk-direct";
  process.env.DEEPSEEK_BASE_URL = "https://api.deepseek.com";
  const { resolveLlmConfig } = await import("../lib/llm/config");
  const cfg = resolveLlmConfig();
  assert.equal(cfg.provider, "deepseek");
  assert.equal(cfg.chatCompletionsUrl, "https://api.deepseek.com/chat/completions");
  delete process.env.LLM_PROVIDER;
  delete process.env.DEEPSEEK_API_KEY;
  delete process.env.DEEPSEEK_BASE_URL;
});
