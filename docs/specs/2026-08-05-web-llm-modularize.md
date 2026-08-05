# web LLM modularize（Wave 3 切片 B）

**Date:** 2026-08-05  
**Status:** Draft (pending user review)  
**Product:** topkyo AI 基建研究台  
**Program:** Wave 3 = 切片 A（pyserver，已落地）→ 切片 B（本 spec）

## Goal

在**行为 Freeze** 前提下，将 `web/lib/deepseek.ts`（~816 行）按职责拆到 `web/lib/llm/*`，保留 `deepseek.ts` 为薄桶 re-export，使现有 `@/lib/deepseek` / `../lib/deepseek` 入口不变。不做 D2 泛型评分编排。

## Constraints

- **B1 薄桶：** `web/lib/deepseek.ts` 仍是唯一对外稳定路径；实现迁入 `web/lib/llm/`。
- **行为 Freeze：** 严格模式失败语义、batch/env 默认、mock 门控、`chat` / `scoreSymbols` / `scorePortfolioTargets` 契约、`SignalSource` 规则、repair 触发条件均不变。只改文件位置与 import。
- **不做 D2：** 不抽象统一 symbols/portfolio 评分编排。
- **严肃看盘规则不变：** LLM 失败不得合成 hold/目标仓位；失败须显式暴露。
- **依赖单向：** `score-*` → `strict` / `prompts` / `transport` / `types` / `mock`；`transport` 不依赖 score；桶文件只 re-export。

## Design

### Architecture

- 消费者继续从 `deepseek.ts` import。
- 新代码写入 `llm/*`，禁止再往桶文件堆业务。
- 不改 LLM provider 协议、route `maxDuration`、默认模型名（除非仅随文件移动而引用同一 env）。

### Components

| 模块 | 职责 |
|------|------|
| `web/lib/llm/types.ts` | Chat*、Snapshot、Signal、portfolio 相关类型 |
| `web/lib/llm/transport.ts` | `LlmHttpError`、retry、`chatDetailed`、`chat` |
| `web/lib/llm/prompts.ts` | 系统提示常量 |
| `web/lib/llm/strict.ts` | 严格 normalize / weight / repair / 相关 env helpers |
| `web/lib/llm/mock.ts` | mock 信号与 `mockProviderActive` |
| `web/lib/llm/score-symbols.ts` | `scoreSymbols` 与 batch |
| `web/lib/llm/score-portfolio.ts` | `scorePortfolioTargets` 与 batch |
| `web/lib/deepseek.ts` | 显式 `export` / `export type` re-export |

文件名可微调，职责边界（transport / strict / score-symbols / score-portfolio / mock）必须可识别。

### Data flow

```
API / backtest / universe-refresh
  → deepseek.ts
  → score* / chat
       → mock 或 transport + strict normalize
       → Signal / PortfolioTargetSignal
```

### Error handling

- 严格失败与 transport 错误语义 Freeze。
- 缺 re-export / 错误 mock 路径必须在 test/tsc 失败，不得静默降级。

### Testing

1. `cd web && npm test` 全绿  
2. `cd web && ./node_modules/.bin/tsc --noEmit` 通过  
3. 现有从 `deepseek` 的 import 路径无需批量修改  
4. 若测试 mock/patch 模块路径，按绑定处更新（对齐 pyserver patch 纪律）

## Success criteria

- [ ] `deepseek.ts` 仅为 re-export 桶  
- [ ] 实现位于 `web/lib/llm/*`  
- [ ] web 测试 + tsc 绿  
- [ ] 严格模式 / mock / batch / SignalSource 语义与拆分前一致  

## Out of scope

- D2 泛型评分编排  
- 改 signals/backtest/universe-refresh 业务逻辑或 LLM 协议  
- 强制全体测试改为 `llm/*` 直 import  
- pyserver 侧变更  

## Open questions

(none)
