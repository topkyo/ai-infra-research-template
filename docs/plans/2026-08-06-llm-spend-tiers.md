# LLM 花费档位与发布链路 Implementation Plan

> **For agentic workers:** Load `executing-plans`（2+ tasks）+ `git-worktrees`（在 main 上开分支）。完成后 `finishing`。Checkbox 跟踪进度。

**Goal:** 日常公开一键默认「刷池 + 信号、跳过回测并标注沿用」；体检走私有 `/backtest` 或 `SNAPSHOT_INCLUDE_BACKTEST=1`。  
**Spec:** `docs/specs/2026-08-06-llm-spend-tiers.md`  
**Architecture:** `buildSnapshotMeta` 统一写出可审计 `meta.json`；VPS 脚本编排刷池/跳过回测；公开 `docs/app.js` 与私有 `/backtest` 文案对齐花费档位。  
**Tech stack:** bash；Node/tsx snapshot；纯 JS 静态页；Next.js `/backtest`；`cd web && npm test` + `tsc --noEmit`

**Commit 风格:** 祈使句；每 Task Verify 绿后 commit。

---

## Files touched

| File | Action | Responsibility |
|------|--------|----------------|
| `web/lib/snapshot-meta.ts` | create | `buildSnapshotMeta` + types + notes |
| `web/test/snapshot-meta.test.ts` | create | skip/include/retain 用例 |
| `web/scripts/snapshot.ts` | modify | 读 env 步骤标志；跳过时不改 backtest.json；写扩展 meta |
| `scripts/vps-refresh-public-snapshot.sh` | modify | 默认刷池；默认 skip backtest；`INCLUDE` opt-in |
| `docs/app.js` | modify | meta 行展示回测沿用 |
| `web/app/backtest/page.tsx` | modify | 「策略体检」文案与按钮 |
| `docs/OPERATIONS.md` | modify | 花费档位 + 两命令 |
| `README.md` | modify | LLM/快照节指向档位 |
| `docs/COMBO_A_RUNBOOK.md` | modify | 日常 vs 体检命令 |

---

## Task 1: `buildSnapshotMeta` + 单测

**Depends on:** none

**Files:**
- Create: `web/lib/snapshot-meta.ts`
- Create: `web/test/snapshot-meta.test.ts`

- [ ] **Step 1:** 新增 `web/lib/snapshot-meta.ts`：

```ts
export type SnapshotMetaSteps = {
  universe_refresh: boolean;
  analyst: boolean;
  signals: boolean;
  backtest: boolean;
};

export type SnapshotMetaBacktest = {
  included: boolean;
  retained_generated_at: string | null;
};

export type SnapshotMeta = {
  generated_at: string;
  universe_count: number;
  steps: SnapshotMetaSteps;
  backtest: SnapshotMetaBacktest;
  notes: string;
};

export function buildSnapshotMeta(input: {
  universeCount: number;
  generatedAt?: string;
  steps: SnapshotMetaSteps;
  /** ISO from existing docs/data/backtest.json when not included */
  retainedBacktestGeneratedAt?: string | null;
  notes?: string;
}): SnapshotMeta {
  const generated_at = input.generatedAt ?? new Date().toISOString();
  const included = input.steps.backtest;
  const retained = included
    ? null
    : (input.retainedBacktestGeneratedAt ?? null);
  const notes = input.notes ?? defaultNotes(input.steps, retained);
  return {
    generated_at,
    universe_count: input.universeCount,
    steps: { ...input.steps },
    backtest: { included, retained_generated_at: retained },
    notes,
  };
}

function defaultNotes(steps: SnapshotMetaSteps, retained: string | null): string {
  const parts: string[] = [];
  if (steps.universe_refresh) parts.push("universe refresh attempted");
  if (steps.analyst) parts.push("analyst");
  if (steps.signals) parts.push("signals");
  if (steps.backtest) parts.push("backtest included");
  else if (retained) parts.push(`backtest retained (${retained})`);
  else parts.push("backtest skipped (none retained)");
  return parts.join("; ");
}
```

- [ ] **Step 2:** 测试至少覆盖：
  1. `steps.backtest=false` + retained ISO → `included=false`，`retained_generated_at` 原样，notes 含 retained  
  2. `steps.backtest=true` → `included=true`，`retained_generated_at=null`（忽略传入 retained）  
  3. 自定义 `notes` 覆盖 default  

- [ ] **Verify:**

```bash
cd web && node --test --import tsx test/snapshot-meta.test.ts && ./node_modules/.bin/tsc --noEmit
```

期望：PASS。Commit：`Add snapshot meta builder for spend-tier audits`

---

## Task 2: `snapshot.ts` 写入扩展 meta；跳过不碰 backtest

**Depends on:** Task 1（`buildSnapshotMeta`）

**Files:**
- Modify: `web/scripts/snapshot.ts`
- Test: 沿用 Task 1（本 task 以脚本接线为主）

- [ ] **Step 1:** 在写 `meta.json` 前，若存在 `docs/data/backtest.json`，安全解析其 `generated_at`（非法/缺失 → `null`）。

- [ ] **Step 2:** 解析步骤 env（缺省如下）：
  - `SNAPSHOT_STEP_UNIVERSE_REFRESH` — `"1"` → true，否则 false（由 VPS 脚本在刷池后导出）
  - analyst：始终 true（本脚本总会写 analyst）
  - signals：`!process.env.SNAPSHOT_SKIP_SIGNALS`
  - backtest：`!process.env.SNAPSHOT_SKIP_BACKTEST`

- [ ] **Step 3:** 回测分支保持：仅当未设置 `SNAPSHOT_SKIP_BACKTEST` 时 `write("backtest.json", …)`；skip 时只 log，**不**删除/改写已有文件。回测抛错时让 `main` 失败退出（现有行为），且因 write 在成功后，旧文件自然保留。

- [ ] **Step 4:** 替换末尾 `write("meta.json", …)` 为：

```ts
import { buildSnapshotMeta } from "../lib/snapshot-meta";
// ...
write(
  "meta.json",
  buildSnapshotMeta({
    universeCount: u.entries.length,
    steps: {
      universe_refresh: process.env.SNAPSHOT_STEP_UNIVERSE_REFRESH === "1",
      analyst: true,
      signals: !process.env.SNAPSHOT_SKIP_SIGNALS,
      backtest: !process.env.SNAPSHOT_SKIP_BACKTEST,
    },
    retainedBacktestGeneratedAt: retainedGeneratedAt,
  }),
);
```

注意：若本次 **included** backtest 成功，`steps.backtest=true`，retained 应为 `null`（builder 已处理）。读 retained 应在可能覆盖 `backtest.json` **之前**完成。

- [ ] **Verify:**

```bash
cd web && node --test --import tsx test/snapshot-meta.test.ts && ./node_modules/.bin/tsc --noEmit
```

期望：PASS。Commit：`Wire snapshot script to spend-tier meta`

---

## Task 3: VPS 一键默认刷池 + 跳过回测

**Depends on:** Task 2（依赖 `SNAPSHOT_STEP_UNIVERSE_REFRESH` 语义）

**Files:**
- Modify: `scripts/vps-refresh-public-snapshot.sh`

- [ ] **Step 1:** 更新脚本头部 Usage，写明两命令：

```bash
# 日常（默认：刷池 + 信号，跳过回测）
./scripts/vps-refresh-public-snapshot.sh

# 体检并更新公开回测
SNAPSHOT_INCLUDE_BACKTEST=1 ./scripts/vps-refresh-public-snapshot.sh

# 跳过刷池
SNAPSHOT_SKIP_UNIVERSE_REFRESH=1 ./scripts/vps-refresh-public-snapshot.sh
```

- [ ] **Step 2:** 在跑 `snapshot.ts` **之前**：
  - 若未设置 `SNAPSHOT_SKIP_UNIVERSE_REFRESH=1`：于 `web/` 执行 `npx tsx scripts/refresh-universe.ts`；失败则 `exit` 非 0（不继续 snapshot/deploy）。成功（含空 proposal）后 `export SNAPSHOT_STEP_UNIVERSE_REFRESH=1`。
  - 若跳过刷池：`export SNAPSHOT_STEP_UNIVERSE_REFRESH=0`（或不设，snapshot 视为 false）。

- [ ] **Step 3:** 回测默认跳过：
  - 若 `SNAPSHOT_INCLUDE_BACKTEST=1`：`unset SNAPSHOT_SKIP_BACKTEST` 或显式确保未跳过。
  - 否则：`export SNAPSHOT_SKIP_BACKTEST=1`。
  - 保留调用方已设的 `SNAPSHOT_SKIP_SIGNALS` 等现有旋钮。

- [ ] **Step 4:** 确认仍 pin `docs/.vercel/project.json`（已有逻辑勿删）；snapshot 失败不 deploy。

- [ ] **Verify:**

```bash
# 语法 + 默认导出逻辑（不跑 LLM）
bash -n scripts/vps-refresh-public-snapshot.sh
# 抽查关键分支出现：
rg -n 'SNAPSHOT_INCLUDE_BACKTEST|SNAPSHOT_SKIP_BACKTEST|SNAPSHOT_SKIP_UNIVERSE_REFRESH|SNAPSHOT_STEP_UNIVERSE_REFRESH|refresh-universe' scripts/vps-refresh-public-snapshot.sh
```

期望：`bash -n` 退出 0；上述符号均存在。Commit：`Default VPS snapshot to refresh universe and skip backtest`

---

## Task 4: 公开页 meta 行展示回测沿用

**Depends on:** Task 1（meta 字段约定；可与 Task 2/3 并行实现 UI）

**Files:**
- Modify: `docs/app.js`（`renderKpis` / `$("#meta-line")` 附近）

- [ ] **Step 1:** 在设置 `meta-line` 时组装字符串：
  - 基础：`数据生成时间：${stampStr} · 股票池更新：${universe.updated_at} (${universe.updated_by})`
  - 若 `meta.backtest && meta.backtest.included === false && meta.backtest.retained_generated_at`：追加  
    ` · 回测沿用至 ${formatBeijingDateTime(meta.backtest.retained_generated_at)}`
  - 缺字段时行为与现网一致（不抛错）。

- [ ] **Verify:**

```bash
# 无自动化单测时：确认分支与 formatBeijingDateTime 复用
rg -n 'retained_generated_at|回测沿用至|meta\.backtest' docs/app.js
node --check docs/app.js
```

期望：命中文案；`node --check` 退出 0。Commit：`Show retained backtest timestamp on public meta line`

---

## Task 5: 私有 `/backtest` 策略体检文案

**Depends on:** none

**Files:**
- Modify: `web/app/backtest/page.tsx`

- [ ] **Step 1:** 将 `h1`「策略回测」改为「策略体检」（或主标题体检、副标题保留回测语义）。
- [ ] **Step 2:** 页头 `p` 增加 1–2 句：费用高、非每日必跑；建议在股票池或策略规则大变后使用；日常看盘用 `/signals`。保留现有方法论说明（close-to-close、无静态基本面等）。
- [ ] **Step 3:** 主按钮文案：`运行回测` → `运行体检`（loading 可改为 `体检运行中…`）。
- [ ] **Step 4:** 可选一行小字：公开快照需另跑  
  `SNAPSHOT_INCLUDE_BACKTEST=1 ./scripts/vps-refresh-public-snapshot.sh`（勿做自动部署）。

- [ ] **Verify:**

```bash
cd web && ./node_modules/.bin/tsc --noEmit
rg -n '策略体检|运行体检|SNAPSHOT_INCLUDE_BACKTEST' web/app/backtest/page.tsx
```

期望：tsc PASS；文案命中。Commit：`Frame private backtest page as strategy health check`

---

## Task 6: 文档花费档位

**Depends on:** Task 3（命令与 env 名已定）

**Files:**
- Modify: `docs/OPERATIONS.md`（「静态快照」节）
- Modify: `README.md`（LLM 工作流 / 快照相关表或列表）
- Modify: `docs/COMBO_A_RUNBOOK.md`（公开快照勾选项）

- [ ] **Step 1:** OPERATIONS：增加「花费档位」小节表（日常 / 研究日 / 体检），并写明：
  - 默认一键 = 刷池 + analyst/signals，**跳过回测**，公开页显示回测沿用
  - `SNAPSHOT_INCLUDE_BACKTEST=1` = 体检写回测
  - `SNAPSHOT_SKIP_UNIVERSE_REFRESH=1` = 跳过刷池
  - 私有体检入口：`/backtest`
- [ ] **Step 2:** README：在静态快照或 LLM 工作流行补一句指向 OPERATIONS 档位；命令与上一致。
- [ ] **Step 3:** COMBO_A_RUNBOOK：把「日常更新公开快照」标为默认无回测；另列体检命令。

- [ ] **Verify:**

```bash
rg -n 'SNAPSHOT_INCLUDE_BACKTEST|花费档位|策略体检|SNAPSHOT_SKIP_UNIVERSE_REFRESH' \
  docs/OPERATIONS.md README.md docs/COMBO_A_RUNBOOK.md
```

期望：三文件均有档位/命令说明。Commit：`Document LLM spend tiers for research and publish`

---

## Final verify

```bash
cd web && npm test && ./node_modules/.bin/tsc --noEmit
bash -n scripts/vps-refresh-public-snapshot.sh
node --check docs/app.js
rg -n 'buildSnapshotMeta|SNAPSHOT_INCLUDE_BACKTEST|回测沿用至|策略体检' \
  web/lib/snapshot-meta.ts web/scripts/snapshot.ts \
  scripts/vps-refresh-public-snapshot.sh docs/app.js \
  web/app/backtest/page.tsx docs/OPERATIONS.md
```

期望：测试与 tsc PASS；脚本/语法检查通过；关键符号齐全。

---

## Spec coverage

| Spec 要求 | Task |
|-----------|------|
| 默认一键跳过回测 + INCLUDE opt-in | 3 |
| 默认刷池 + SKIP_UNIVERSE_REFRESH | 3 |
| meta steps/backtest/notes | 1, 2 |
| skip 时保留 backtest.json | 2 |
| 公开 UI 沿用提示 | 4 |
| `/backtest` 体检文案 + 命令提示 | 5 |
| OPERATIONS/README/COMBO_A | 6 |
| 严格失败语义不放宽 | 2, 3（失败 exit；空 proposal 不写池既有） |
| Out of scope（thinking/cron/portfolio snapshot） | 未列入 |
