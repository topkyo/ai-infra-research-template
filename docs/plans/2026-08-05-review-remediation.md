# 2026-08-05 评审发现 remediation 计划

> **For agentic workers:** Load `executing-plans`。按依赖波次执行；跳过已核验为误报的 N8/N12。完成后 `finishing`。

**Goal:** 修复 2026-08-05 多 agent 评审中已确认的全部问题（N1–N7、N9–N11、N13；N4/N5 运维硬化）。  
**Constraint:** 禁止业务兜底/静默降级；失败须显式 `error`/`unavailable`/`warning`。  
**基线:** pyserver 120 + web 117 全绿；分支 `feat/review-remediation-2026-08-05`。  
**跳过:** N8（onBadLine 已接线）、N12（`free_port` 已有确认杀进程）。

**Architecture:** pyserver 边界三态与 klines 对齐；回测剔除静态基本面输入并显式披露；CI/依赖/文档补齐运维契约。

---

## Files touched（预期）

| File | Action | Task |
|------|--------|------|
| `pyserver/providers/akshare_spot.py` | modify | T1 |
| `pyserver/test_spot_empty_hist.py` | create | T1 |
| `pyserver/routes/benchmarks.py` | modify | T2 |
| `pyserver/test_benchmarks_empty.py` | create | T2 |
| `pyserver/pyproject.toml` + `uv.lock` | modify | T3 |
| `docs/BACKUP_RUNBOOK.md` | create | T4 |
| `docs/DEPLOY.md` | modify | T4 |
| `.github/workflows/deploy-public-vercel.yml` | modify | T5 |
| `docs/COMBO_A_RUNBOOK.md` | modify | T5 |
| `web/lib/backtest.ts` | modify | T6, T8 |
| `web/app/api/backtest/route.ts` | modify | T6 |
| `web/app/backtest/page.tsx` | modify | T6 |
| `web/test/backtest.test.ts` | modify | T6 |
| `README.md` / `docs/RESEARCH_WORKFLOW.md` | modify | T6 |
| `web/lib/universe-refresh.ts` | modify | T7 |
| `web/test/universe-refresh*.ts` or new test | modify/create | T7 |
| `web/lib/llm/score-retry.ts` | create | T9 |
| `web/lib/llm/score-symbols.ts` / `score-portfolio.ts` | modify | T9 |
| `.github/workflows/ci.yml` | modify | T10 |

---

## Task 1: N2 — `_ak_a_spot_from_hist` 空 DataFrame

**Depends on:** none

**Files:**
- Modify: `pyserver/providers/akshare_spot.py`（`_ak_a_spot_from_hist`）
- Create: `pyserver/test_spot_empty_hist.py`

**Steps:**
1. 在 `df = _ak_a_hist_df(...)` 后改为：`if df is None or df.empty: return None`（勿再 `iloc[-1]`）。
2. 单测：mock `_ak_a_hist_df` 返回 empty DataFrame，断言 `_ak_a_spot_from_hist` 返回 `None`（不抛 IndexError）。

**Verify:**
```bash
cd pyserver && uv run python -m unittest discover -p 'test_spot_empty_hist.py' -v
```

**Commit:** `fix: treat empty hist as no spot in akshare fallback`

---

## Task 2: N3+N6 — benchmarks 空窗语义 + 日志

**Depends on:** none

**Files:**
- Modify: `pyserver/routes/benchmarks.py`
- Create: `pyserver/test_benchmarks_empty.py`

**Steps:**
1. 对齐 `routes/klines.py` 三态：区分 upstream failure vs confirmed empty。
2. AkShare `except` 必须 `log.exception`（或 `log.warning`）并标记 `had_failure`；不得静默 `df = None`。
3. 主源成功但日期过滤后 empty：可继续试 Tushare；若**无 failure** 且最终 empty → `200 []` + `_empty_bars_ttl`；若有 failure 且最终 None → 502。
4. 关键：过滤后空窗 + Tushare 失败时，若 AkShare 曾成功返回非空再被滤空，不得用 Tushare 异常覆盖为 502——应返回 `[]`（与「已确认该窗口无数据」一致）。实现时优先：AkShare 过滤前有行、过滤后 empty 记为 confirmed empty（非 failure），Tushare 失败不升级为 502。
5. 单测覆盖上述路径。

**Verify:**
```bash
cd pyserver && uv run python -m unittest discover -p 'test_benchmarks_empty.py' -v
```

**Commit:** `fix: preserve confirmed-empty benchmarks windows and log akshare errors`

---

## Task 3: N10 — pyproject 依赖卫生

**Depends on:** none

**Files:**
- Modify: `pyserver/pyproject.toml`
- Modify: `pyserver/uv.lock`（`uv lock` / `uv sync`）

**Steps:**
1. 移除未使用的直接依赖 `httpx`。
2. 将 `requests` 加入直接依赖（`http_util.py` 使用）。
3. 更新 lockfile。

**Verify:**
```bash
cd pyserver && uv sync --frozen && uv run python -c "import requests; import http_util; print('ok')" && uv run python -m unittest discover -p 'test_*.py' -q
```

**Commit:** `chore: declare requests and drop unused httpx from pyserver`

---

## Task 4: N5 — 备份 runbook

**Depends on:** none

**Files:**
- Create: `docs/BACKUP_RUNBOOK.md`
- Modify: `docs/DEPLOY.md`（链到 runbook）

**Steps:**
1. 文档化 `web-cache` volume（回测存档）与 `holdings.local.json` / `private/` 的备份策略：频率建议、目标（私有 git / 对象存储 / 本地 rsync）、恢复步骤、勿提交密钥。
2. `DEPLOY.md` 增加「Backup」小节链接。

**Verify:**
```bash
test -f docs/BACKUP_RUNBOOK.md && rg -n 'web-cache|holdings|备份|backup' docs/BACKUP_RUNBOOK.md docs/DEPLOY.md
```

**Commit:** `docs: add backup runbook for web-cache and holdings`

---

## Task 5: N4 — Vercel 公开快照失败可见性

**Depends on:** none

**Files:**
- Modify: `.github/workflows/deploy-public-vercel.yml`
- Modify: `docs/COMBO_A_RUNBOOK.md`

**Steps:**
1. 去掉「部署失败仍整 workflow 绿灯」：在 secrets 已配置时，若 deploy step 失败，最终 step **exit 1**（保留清晰错误信息；可继续用 `continue-on-error` 于 deploy step 本身以便写摘要，但必须有强制失败的收尾 step）。
2. Runbook 增加：如何确认上次成功部署时间、token 轮换后重跑 workflow。

**Verify:**
```bash
rg -n 'exit 1|deploy.outcome|continue-on-error' .github/workflows/deploy-public-vercel.yml
rg -n 'Vercel|snapshot|token' docs/COMBO_A_RUNBOOK.md
```

**Commit:** `ci: fail public Vercel workflow when configured deploy fails`

---

## Task 6: N1 — 回测基本面 look-ahead 消除 + 披露

**Depends on:** none（与 T8 同文件时串行：先 T6 后 T8）

**Files:**
- Modify: `web/lib/backtest.ts` — 调仓快照不传 `fundamental`；修正 look-ahead-free 注释；结果带 `warnings`
- Modify: `web/app/api/backtest/route.ts` — 可不抓 / 可不传 fundamental；或抓了也不注入 scorer（推荐：回测路径不再 fetch fundamental，减少误导）
- Modify: `web/app/backtest/page.tsx` — UI 显示警告
- Modify: `web/test/backtest.test.ts` — 断言 scorer 收到的 snapshot 无 fundamental（即使 series 带了）
- Modify: `README.md`、`docs/RESEARCH_WORKFLOW.md` — 声明回测 LLM 仅价格动量+主题，不含时点基本面

**Steps:**
1. 在构建 scorer snapshots 时强制 `fundamental: undefined`（或省略），即使 series 有值。
2. `BacktestResult` 增加/使用 `warnings: string[]`，包含明确 look-ahead 缓解说明。
3. 回测 API 停止调用 `fetchFundamental`（避免无用请求与缓存污染）。
4. UI + 文档披露。
5. 回归测试。

**Verify:**
```bash
cd web && npm test -- --test-name-pattern='fundamental|look-ahead|backtest' 2>/dev/null; npm test 2>&1 | tail -20
./node_modules/.bin/tsc --noEmit
```

**Commit:** `fix: exclude static fundamentals from backtest scoring to remove look-ahead`

---

## Task 7: N7 — universe-refresh proposal 形状校验

**Depends on:** none

**Files:**
- Modify: `web/lib/universe-refresh.ts`
- Modify/Create: 对应 `web/test/*universe*` 测试

**Steps:**
1. `JSON.parse` 后对 `adds`/`removes`/`reclassified`（或现有字段名）做运行时形状校验；非法结构抛明确错误（可供 strict-repair 或上层捕获）。
2. 不要静默当成空 proposal 成功写文件。
3. 单测：畸形 JSON 形状 → 可识别错误。

**Verify:**
```bash
cd web && npm test 2>&1 | tail -25
./node_modules/.bin/tsc --noEmit
```

**Commit:** `fix: validate universe refresh proposal shape after JSON.parse`

---

## Task 8: N9 — 移除死字段 `BenchmarkResult` 侧 excessReturnPct cast

**Depends on:** Task 6

**Files:**
- Modify: `web/lib/backtest.ts` — 删除 root 级 `excessReturnPct` 与 `as` cast；保留 `stats.excessReturnPct`（UI 使用）
- 确认无其它读取方；勿删 `totalWeight` 局部变量

**Verify:**
```bash
cd web && rg -n 'excessReturnPct' lib/backtest.ts app/backtest/page.tsx test && npm test 2>&1 | tail -15 && ./node_modules/.bin/tsc --noEmit
```

**Commit:** `refactor: drop unused benchmark-root excessReturnPct cast`

---

## Task 9: N13 — 抽取 LLM score retry 共用控制流

**Depends on:** none（避免与 T6 同时改 score-symbols 若 T6 不碰则可并行；T6 若只改 backtest 则无冲突）

**Files:**
- Create: `web/lib/llm/score-retry.ts`（或现有合适模块）
- Modify: `web/lib/llm/score-symbols.ts`、`web/lib/llm/score-portfolio.ts`

**Steps:**
1. 抽取 ~30–40 行相同的 retry / strict-repair 循环为共享 helper。
2. 两处改为调用 helper；行为不变。
3. 现有相关测试须通过。

**Verify:**
```bash
cd web && npm test 2>&1 | tail -20 && ./node_modules/.bin/tsc --noEmit
```

**Commit:** `refactor: share LLM score retry control flow`

---

## Task 10: N11 — CI 加 lint + 依赖审计

**Depends on:** none

**Files:**
- Modify: `.github/workflows/ci.yml`

**Steps:**
1. web job：在 typecheck 前后增加 `npm run lint`。
2. web job：增加 `npm audit --audit-level=high`（允许单独 step；若当前有 high 漏洞导致红，先在 Notes 报告 BLOCKED 而非乱改依赖——父裁决）。
3. 不强制上覆盖率上报/完整安全扫描产品（范围外）；lint+audit 即可关闭本发现。

**Verify:**
```bash
rg -n 'npm run lint|npm audit' .github/workflows/ci.yml
cd web && npm run lint 2>&1 | tail -30
```

**Commit:** `ci: add next lint and npm audit to web job`

---

## Execution waves

```
Wave A (并行，max 2 writers via best-of-n 或串行 subagent):
  T1, T2, T3, T4, T5, T7, T9, T10

Wave B (T6 完成后):
  T8

串行推荐顺序（单 worktree）:
  T1 → T2 → T3 → T4 → T5 → T6 → T7 → T8 → T9 → T10
```

单 worktree 下用 **fresh subagent 串行**（避免并行写冲突）。
