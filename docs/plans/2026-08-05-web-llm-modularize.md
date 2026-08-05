# web LLM modularize Implementation Plan

> **For agentic workers:** Load `executing-plans`（2+ tasks）+ `git-worktrees`（在 main 上开分支）。共享 `deepseek.ts` 抽出面 → **串行**。符号定位，禁止依赖行号。完成后 `finishing`。Checkbox 跟踪进度。

**Goal:** 行为 Freeze 下将 `web/lib/deepseek.ts` 拆到 `web/lib/llm/*`，保留薄桶入口。  
**Spec:** `docs/specs/2026-08-05-web-llm-modularize.md`  
**Architecture:** `deepseek.ts` 仅 re-export；`llm/{types,transport,prompts,strict,mock,score-symbols,score-portfolio}.ts` 承载实现。不做 D2。  
**Tech stack:** Next.js 15 / TypeScript；`cd web && npm test`；`./node_modules/.bin/tsc --noEmit`

**Commit 风格:** 祈使句；每 Task Verify 绿后 commit。

**Patch / dynamic-import 纪律:** 测试多用 `await import("../lib/deepseek")`。搬家后若内部 `fetch`/helpers 被测方直接绑定到子模块，按**实际绑定模块**更新 mock；优先让桶 re-export 保持 `deepseek` 入口可用，减少测试改动。

---

## Files touched

| File | Action | Responsibility |
|------|--------|----------------|
| `web/lib/llm/types.ts` | create | Chat*、Snapshot、Signal、portfolio types |
| `web/lib/llm/transport.ts` | create | LlmHttpError、retry、`chatDetailed`、`chat` |
| `web/lib/llm/prompts.ts` | create | STRATEGY_SYSTEM、PORTFOLIO_STRATEGY_SYSTEM |
| `web/lib/llm/strict.ts` | create | normalize / strictWeight / repair / env helpers |
| `web/lib/llm/mock.ts` | create | mockSignal*、mockProviderActive |
| `web/lib/llm/score-symbols.ts` | create | scoreSymbols + batch |
| `web/lib/llm/score-portfolio.ts` | create | scorePortfolioTargets + batch |
| `web/lib/deepseek.ts` | modify | 最终仅 re-export |
| `web/test/*.ts` | modify | 仅当 patch/动态 import 需要时 |
| `docs/plans/2026-08-04-quality-remediation.md` | modify | D1 行指向本计划 / done |

---

## Task 1: 抽出 types / transport / prompts

**Depends on:** none

**Files:**
- Create: `web/lib/llm/types.ts`, `transport.ts`, `prompts.ts`
- Modify: `web/lib/deepseek.ts`（改为 import + re-export 这三块；评分逻辑暂留）
- Test: `web/test/deepseek.test.ts`（transport / chatDetailed 相关）

- [x] **Step 1:** 迁入全部 export 的 types/interfaces/type aliases 到 `types.ts`。
- [x] **Step 2:** 迁入 `LlmHttpError`、retry helpers、`chatDetailed`、`chat` 到 `transport.ts`（从 `types` import 消息类型）。
- [x] **Step 3:** 迁入两个 STRATEGY 系统提示到 `prompts.ts`。
- [x] **Step 4:** `deepseek.ts` 删除已迁定义，`export type` / `export { ... } from "./llm/..."`，其余评分代码暂留并改 import。
- [ ] **Verify:**  
  ```bash
  cd web && npm test -- --test-name-pattern='chatDetailed|retry|LlmHttpError|isRetryable' 2>/dev/null || \
  cd web && npm test
  ```  
  若 name-pattern 不被 node:test 支持，直接：  
  ```bash
  cd web && npm test && ./node_modules/.bin/tsc --noEmit
  ```  
  期望：PASS。

---

## Task 2: 抽出 strict + mock

**Depends on:** Task 1（types/transport 已稳定）

**Files:**
- Create: `web/lib/llm/strict.ts`, `mock.ts`
- Modify: `web/lib/deepseek.ts`
- Test: `web/test/deepseek.test.ts`, `web/test/llm-mock.test.ts`

- [x] **Step 1:** 迁入 normalize*、strictWeight/strictSignalField、isStrictLlmOutputError、repair、chunks/sleep/signalSource、env helpers、VALID_ACTIONS / MIN_SCORABLE / batch 常量中**仅被 strict/mock/score 共享**的部分到 `strict.ts`（或 score 旁局部常量——Freeze 下保持同一数值来源，避免双份默认值）。
- [x] **Step 2:** 迁入 mock 三函数到 `mock.ts`。
- [x] **Step 3:** `deepseek.ts` re-export 任何仍被外部需要的符号；评分函数暂留。
- [ ] **Verify:**  
  ```bash
  cd web && npm test && ./node_modules/.bin/tsc --noEmit
  ```  
  期望：PASS。

---

## Task 3: 抽出 score-symbols / score-portfolio；深seek 变纯桶

**Depends on:** Task 2

**Files:**
- Create: `web/lib/llm/score-symbols.ts`, `score-portfolio.ts`
- Modify: `web/lib/deepseek.ts` → **仅** re-export（无业务函数体）
- Test: 全量 web tests + 依赖 deepseek 的 lib 编译

- [x] **Step 1:** 迁入 `scoreSymbols` / batch / 相关私有 helper 到 `score-symbols.ts`。
- [x] **Step 2:** 迁入 `scorePortfolioTargets` / batch 到 `score-portfolio.ts`。
- [x] **Step 3:** `deepseek.ts` 清成薄桶，显式导出对外 API 清单（至少：`chat`, `chatDetailed`, `scoreSymbols`, `scorePortfolioTargets`, `LlmHttpError`, `isRetryableTransportError`, `retryDelayMs`，以及所有被 web/lib 与 tests 使用的 types）。用 `rg "from [\"'].*deepseek" web` 核对清单。
- [x] **Step 4:** 确认无循环：score → strict/transport/prompts/types/mock；桶不反向被 llm 内部 import（llm 内部互 import 允许）。
- [ ] **Verify:**  
  ```bash
  cd web && npm test && ./node_modules/.bin/tsc --noEmit
  ```  
  期望：PASS。另：  
  ```bash
  rg -n '^(export )?(async )?function |^const STRATEGY' web/lib/deepseek.ts || true
  ```  
  期望：无业务函数/STRATEGY 常量（仅 re-export 语句）。

---

## Task 4: 文档锚点 + Final verify

**Depends on:** Task 3

**Files:**
- Modify: `docs/plans/2026-08-04-quality-remediation.md`（D1 行 → 本计划 / done）
- Modify: 本计划 checkbox 勾选

- [x] **Step 1:** 更新质量计划外置表 D1 指向 `docs/plans/2026-08-05-web-llm-modularize.md` 并标注落地分支/完成。
- [x] **Step 2:** Final gate：  
  ```bash
  cd web && npm test && ./node_modules/.bin/tsc --noEmit
  wc -l web/lib/deepseek.ts   # 应为短桶（量级数十行）
  ```
- [ ] **Verify:** 同上全部 PASS。

---

## Final verify

```bash
cd web && npm test && ./node_modules/.bin/tsc --noEmit
# deepseek.ts 无业务实现，仅 re-export
rg -n 'from ["'\'']\./llm/' web/lib/deepseek.ts
```

成功标准对照 spec：薄桶、`llm/*` 承载实现、测试+tsc 绿、Freeze。

---

## Out of scope

- D2 泛型评分编排  
- 改 API routes 业务逻辑  
- pyserver 变更  
- 强制测试改直 import `llm/*`
