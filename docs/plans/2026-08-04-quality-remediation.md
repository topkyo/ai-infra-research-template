# 质量 remediation 计划（可执行修订版）

> **For agentic workers:** Load `executing-plans`（2+ tasks）。按 **文件所有权车道** 并行；`main.py` 单车道串行。每任务按符号定位，**禁止依赖本文行号**。完成后 `finishing`。Checkbox 跟踪进度。
>
> **修订依据：** 2026-08-04 多 agent 交叉评估（A/C、B/F、D/E、整体裁决）。原「全量」范围过大且依赖图不安全；本版收缩为可并行执行的正确性 / 测试 / 小清理波次。大重构另立计划。
>
> **执行状态（2026-08-04）：** Wave 1 + Wave 2 已在分支 `feat/quality-remediation`（`673b897`）落地。最终门禁：pyserver 120 / web 123 / `tsc` OK。B6 Docker build/`id` 断言因执行环境无 Docker 为 soft-blocked，镜像与 compose 变更已提交。Wave 3（modularize）仍外置。

**Goal:** 消除仍会伪造或静默降级的数据路径，补齐失败语义测试，并做低风险清理与文档/部署硬化。  
**Constraint:** 新增 fallback/兜底前须用户同意；失败须显式 `error`/`unavailable`/`warning`（AGENTS.md）。  
**定位规则:** 用 `def`/`function`/字符串锚点搜索；行号若出现仅作历史参考，实现前必须重新定位。

---

## 已完成（紧急修复，以 `b87b1cc` 为准）

| 编号 | 问题 | 实际修复 | 验证 |
|------|------|----------|------|
| B-1 | `analyst` 循环变量遮蔽缓存 key | 循环改为 `field_name`；`key = f"analyst:v4:{symbol}"` 不再被覆盖 | pyserver unittest |
| B-2 | `/klines`、`/benchmark/klines` 全源失败伪装 `200 []` | `df is None` → 502；`df.empty` → `[]`；adapter 区分 failure vs empty；`_empty_bars_ttl(end)`：开放窗 60s / 闭合窗 24h；恢复 `if market == "hk"` 后处理 | `test_klines_empty.py` + suite |
| B-3 | 容器 TZ | 两 Dockerfile + compose `TZ=Asia/Shanghai`；**pyserver 与 web 均安装 `tzdata`** | 镜像构建配置 |

当前静态测试规模约 **46 pyserver / 118 web**（以 `unittest discover` / `npm test` 为准）。

---

## 明确移出本计划（另立文档后再做）

| 原任务 | 理由 | 后续计划建议 |
|--------|------|----------------|
| B1 拆分 `main.py`、B2 大块去重、B7 拆 analyst 循环依赖 | 高风险边界重构；与正确性任务抢 `main.py`；B1 须同步改 CI `import` 清单 | **Done on `feat/pyserver-modularize`** — 见 [`docs/plans/2026-08-05-pyserver-modularize.md`](2026-08-05-pyserver-modularize.md)（B1/B7 已落地；B2 大块去重仍外置） |
| D1 拆 `deepseek.ts`、D2 泛型评分编排 | import fan-out 大；D2 易过度抽象 | `docs/plans/…-web-llm-modularize.md` |
| F1 README 脚本引用 | 前提错误：`scripts/monitor-dashboard.sh` 与 `scripts/macos/README.md` 均存在 | —（删除） |

---

## 执行车道与依赖（对齐后）

```
Wave 1（可并行，按文件所有权）
  车道 a — pyserver/main.py + analyst.py（单 implementer 串行）:
      P0-1 → P0-2 → A1(+web) → A2 → A3 → A4 → A5 → A6
  车道 b — validation / handler 日期语义:  A7
  车道 c — 新建 pyserver 测试文件:       C3, C4, C5a（与 A 无文件冲突的部分）
  车道 d — web/lib 行为修复:             D3 → D4 → D5
  车道 e — docs / docker ignore / B6 准备: F2, F3

Wave 2（依赖 Wave 1 相关交付）
  A8 Spot model（依赖 A1 字段契约）
  B4 缓存 key（依赖 A1 稳定 spot；与 C1 同波）
  B5 prune 排序（不含后台线程）
  B6 非 root（含 compose/写目录）
  C1 缓存命中（依赖 B4）
  C2 TestClient 集成（契约已稳定）
  C5b spot warnings / env hygiene（依赖 A1/B3 决策落地）
  B3 精简死代码（A/D 落地后，避免抢文件）
  E* 仅补 D 未覆盖的边界（不重复 D 的测试 commit）
  NEW-U universe `updated_at` 不变量测试

Wave 3 — 另立计划
  pyserver modularize / web llm modularize
```

**Commit 风格:** 与近期历史一致——祈使句、无 `fix:`/`refactor:` 前缀；每车道每 2–4 个相关任务可合并为一个 commit，不必一 task 一 commit。

---

## Wave 1 — P0 / 正确性

### Task P0-1: 空帧不得短路次级行情源

**Depends on:** none  
**Priority:** P0  
**Files:** `pyserver/main.py`（`klines` A-share 降级链、`_ak_a_hist_df` 契约说明）

**问题:** `_ak_a_hist_df` 成功返回空 `DataFrame` 时，`klines` 见 `df is not None` 即跳过 baostock/tushare，把「东财空窗 / 限流空帧」与「全市场确认无 K 线」混为一谈（静默降级残留）。

- [ ] **Step 1:** 在 `klines` A-share 路径：仅当当前源为 **failure (`None`)** 时才尝试下一源；**empty DF 继续尝试次级源**；仅当所有已尝试源均为 empty（无一 `None` 失败且无一有数据）时才 `200 []`；若存在 failure 且无任何有数据结果 → 502。
- [ ] **Step 2:** 用简短注释写清三态：`None`=该源失败，`empty`=该源确认无行，`rows`=有数据。不要引入完整 Bars/NoData/Failed 类型系统（留给 modularize 计划）。
- [ ] **Verify（file-scoped）:**  
  `uv run python -m unittest test_klines_empty -v`  
  新增用例：mock `_ak_a_hist_df`→empty、`_baostock_hist_df`→非空 → 响应有 bars；  
  mock 全 empty → `[]`；mock 全 `None` → 502。

**Suggested commit subject:** `Try secondary kline sources after empty primary frames`

---

### Task P0-2: 开放窗 empty TTL 退避

**Depends on:** P0-1（同文件，串行）  
**Priority:** P0  
**Files:** `pyserver/main.py`（`_empty_bars_ttl`）、`pyserver/test_klines_empty.py`

**问题:** 开放窗固定 60s 在全池 signals 下可能惊群打上游。

- [ ] **Step 1:** 为开放窗 empty 结果增加退避或更长下限（例如首次 60s、同 key 连续 empty 递增至上限，或直接将开放窗下限提高到可接受值——**实现前在 brief 中写死选定策略，默认：开放窗 TTL=300s，闭合窗保持 24h**；若改退避结构需用户点头）。
- [ ] **Step 2:** 更新 `EmptyBarsTtlTest`。
- [ ] **Verify:** `uv run python -m unittest test_klines_empty.EmptyBarsTtlTest -v`

**Suggested commit subject:** `Raise open-window empty kline cache TTL to curb stampede`

---

### Task A7: 日期窗口校验（含 start≤end）

**Depends on:** none（可与车道 a 并行；若改 `klines`/`benchmark_klines` handler 则与 a 错开或并入 a）  
**Priority:** P0（`start≤end`）/ P1（10 年 cap）  
**Files:** `pyserver/main.py` 或 `pyserver/validation.py`、新建/扩展测试

- [ ] **Step 1:** `/klines` 与 `/benchmark/klines`：`start > end` → 400，文案明确，**不得**落到 `200 []`。
- [ ] **Step 2:** `end - start > 3650` 天 → 400（10 年 cap；不改 `_validate_date` 全局上下界）。
- [ ] **Verify:** 针对本任务测试模块：`start>end`→400；超长窗→400。

**Suggested commit subject:** `Reject inverted and overlong kline date ranges`

---

### Task A1: 拒绝 Spot 伪零值 + web 可空契约

**Depends on:** P0-1, P0-2（同 `main.py` 串行）  
**Priority:** P0  
**Files:** `pyserver/main.py`（`spot`、`parse_sina_hq_text` 及所有 `or 0` 报价路径）、`web/lib/pyserver.ts`、相关 web 消费点、`pyserver/test_spot_fallback.py`（扩展）

**契约（先锁定再改）：**
- `price` 缺失 / NaN → **502**（不可合成 0）
- `change_pct` / `volume` / `turnover` 缺失 → **`null` + warning**（不伪造 0）；web `Spot.change_pct` 改为 `number | null`
- `parse_sina_hq_text`：`prev_close` 缺失时涨跌幅为 `None`；**同一任务内**改调用方发 warning，禁止只改一半

- [ ] **Step 1:** 扫全部 spot 相关 `float(... or 0)` / 默认 0（含 realtime、Sina、stock_value_em、history、HK/Tushare 末端），按契约处理。
- [ ] **Step 2:** 更新 `web/lib/pyserver.ts` 的 `Spot` 与所有把 `change_pct` 当必有 number 的调用点；`tsc --noEmit`。
- [ ] **Step 3:** 测试：缺 `close` → 502；缺 `change_pct` → 200 + warning + `null`（非 0）。
- [ ] **Verify:**  
  `uv run python -m unittest test_spot_fallback -v`  
  `cd web && ./node_modules/.bin/tsc --noEmit`

**Suggested commit subject:** `Reject fabricated zero spot fields and nullable change_pct`

---

### Task A2: `_num_or_none` 安全解析

**Depends on:** A1（同文件）  
**Priority:** P0  
**Files:** `pyserver/main.py`（`_num_or_none`）、`pyserver/test_num_or_none.py`（new）

- [ ] **Step 1:** 去千分位逗号后再匹配数字。
- [ ] **Step 2:** **仅当恰好一个数字**时返回 `float`；0 个或多个 → `None` + `log.warning`（禁止「多数字取第一个」的静默截断）。
- [ ] **Verify:** `uv run python -m unittest test_num_or_none -v`  
  cases: `None`→`None`、`3.14`→`3.14`、`"1,234.5"`→`1234.5`、`"N/A"`→`None`、`""`→`None`、`123`→`123.0`、`"12.3 (was 45.6)"`→`None`

**Suggested commit subject:** `Parse numeric strings without averaging or silent truncation`

---

### Task A3: provider 失败打日志

**Depends on:** A2  
**Priority:** P1  
**Files:** `pyserver/main.py`（各 `except Exception` 后置 `df = None` / `return None` 的 provider helper）

- [ ] **Step 1:** 在吞异常处加 `log.warning("provider %s failed: %s", name, e)`（无 URL/token）。
- [ ] **Step 2:** 不改变返回值语义。
- [ ] **Verify:** 针对本行为的单测（mock 抛错断言 `log.warning` 被调用），勿用全库主观 grep 门禁。

**Suggested commit subject:** `Log swallowed provider exceptions in pyserver helpers`

---

### Task A4: 擦洗 client-facing warnings 中的异常原文

**Depends on:** A3  
**Priority:** P1  
**Files:** `pyserver/main.py`、`pyserver/analyst.py`

- [ ] **Step 1:** warnings 只含 `type(e).__name__`；完整异常 `log.exception`。
- [ ] **Verify:** 本任务测试断言 warnings 不含 URL/path；允许在测试文件内检查相关调用点。

**Suggested commit subject:** `Scrub upstream exception text from client warnings`

---

### Task A5: `/fundamental` 非实时价格 warning

**Depends on:** A4  
**Priority:** P1  
**Files:** `pyserver/main.py`（`fundamental`）、对应测试

- [ ] **Step 1:** 从 `stock_value_em` 填 `latest_close` 时 append 与 analyst 同语义的非实时 warning。
- [ ] **Verify:** 单测 mock 该来源，断言 warnings 含非实时说明。

**Suggested commit subject:** `Warn when fundamental latest_close is not realtime`

---

### Task A6: `_with_retries` 末次失败不 sleep

**Depends on:** A5  
**Priority:** P2  
**Files:** `pyserver/main.py`（`_with_retries`）、单元测试

- [ ] **Step 1:** `if i < attempts - 1: sleep(...)`。
- [ ] **Verify:** 用 mock 时钟或记录 sleep 调用次数，避免 CI 墙钟 flaky。

**Suggested commit subject:** `Skip backoff sleep after final retry attempt`

---

## Wave 1 — Web / LLM

### Task D3: confidence/size 严格校验

**Depends on:** none  
**Priority:** P0  
**Files:** `web/lib/deepseek.ts`（及拆分后仍存放 validation 处）、`web/test/deepseek.test.ts`；若改 mock 错误串则触及 `isStrictLlmOutputError`

- [ ] **Step 1:** 去掉对 confidence/size 的 `clamp01` 静默截断；非法值 throw，前缀纳入现有 strict-error 识别（例如与 `LLM signal` / portfolio 前缀一致），以便 strict repair 或明确失败——**二选一写进实现 brief：默认「识别为 strict error 并 repair 一次」；须更新 `isStrictLlmOutputError`，否则不会多一次修复调用。**
- [ ] **Step 2:** 替换现有「clamp 到边界」测试为拒绝/repair 测试。
- [ ] **Verify:** `cd web && npm test -- --test-name-pattern='deepseek|confidence|size'`（或项目等价过滤）+ `tsc --noEmit`；若改 mock provider，加跑 `npm run test:e2e`（若存在）。

**Suggested commit subject:** `Reject out-of-range LLM confidence and size`

---

### Task D4: backtest stats 防护

**Depends on:** D3（可放宽为 none，若无文件冲突）  
**Priority:** P2  
**Files:** `web/lib/backtest.ts`、`web/test/backtest.test.ts`

- [ ] **Step 1:** 对可达路径加 guard（优先经 `runBacktest` / 已导出 API 测；**勿仅为测试扩大 public export**）。
- [ ] **Verify:** `cd web && npm test` 中 backtest 相关文件。

**Suggested commit subject:** `Guard backtest stats against empty or non-positive equity`

---

### Task D5: mock portfolio 一致性

**Depends on:** D3  
**Priority:** P2  
**Files:** mock provider 所在模块、`web/test/llm-mock.test.ts`（或现有 mock 测试）

- [ ] **Step 1:** mock 填非空 evidence/risks，文案标明 mock/不可实盘（禁止伪装真实研究证据）。
- [ ] **Step 2:** ~~不要~~把 evidence/risks 改成 optional 来绕过校验。
- [ ] **Verify:** mock 相关单测；触及 e2e mock 则跑 e2e。

**Suggested commit subject:** `Fill mock portfolio evidence and risks explicitly`

---

## Wave 1 — 文档 / 杂项

### Task F2: 文档化 same-day close-to-close

**Depends on:** none  
**Priority:** P2  
**Files:** `README.md`、`docs/RESEARCH_WORKFLOW.md`

- [ ] **Step 1:** 声明信号与成交均用当日收盘、不建模盘中路径，及对动量策略可能偏乐观。
- [ ] **Verify:** 人工读一遍相关段落。

---

### Task F3: `pyserver/.dockerignore`

**Depends on:** none  
**Priority:** P2  
**Files:** create `pyserver/.dockerignore`

- [ ] **Step 1:** 忽略 `.env`、`cache.db*`、`__pycache__/`、`.venv/`、`test_*.py`、`*.pyc` 等。
- [ ] **Verify:** `docker build -f pyserver/Dockerfile pyserver` 成功。

---

## Wave 1 — 测试（新文件，可并行）

### Task C3: helper 单元测试

**Depends on:** none（A2 的 `_num_or_none` 期望以 A2 完成后为准；可先写 `_to_ts_code` / TTL / `_source_summary`）  
**Priority:** P1  
**Files:** create `pyserver/test_unit_helpers.py`

- [ ] **Step 1:** `_to_ts_code` 别名矩阵（计划原列表）。
- [ ] **Step 2:** `seconds_until_next_trading_close` 用 mock `datetime.now`（注明当前实现按日历日非交易日历）。
- [ ] **Step 3:** `_source_summary` 分支。
- [ ] **Verify:** `uv run python -m unittest test_unit_helpers -v`

---

### Task C4: BaoStock 路径（契约对齐 B-2）

**Depends on:** none  
**Priority:** P0  
**Files:** create `pyserver/test_baostock.py`

- [ ] **Step 1:** 正常数据 → DF + logout。
- [ ] **Step 2:** `error_code != "0"` → **`None`** + logout。
- [ ] **Step 3:** 空数据 / 全无效行 → **`empty DataFrame`（不是 None）** + logout。
- [ ] **Step 4:** `_baostock_growth_yoy` 路径冒烟。
- [ ] **Verify:** `uv run python -m unittest test_baostock -v`

---

### Task C5a: bootstrap 测试 hygiene

**Depends on:** none  
**Priority:** P1  
**Files:** `pyserver/test_tushare_bootstrap.py`

- [ ] **Step 1:** `patch.dict(os.environ, …)` 恢复环境。
- [ ] **Step 2:** 用 tempfile DB，不用 `:memory:` 静默禁用缓存。
- [ ] **Verify:** `uv run python -m unittest test_tushare_bootstrap -v`

---

## Wave 2

### Task A8: Spot response_model

**Depends on:** A1  
**Priority:** P1  
**Files:** `pyserver/main.py`（或后续 models 模块）、`web/lib/pyserver.ts`

- [ ] **Step 1:** `class Spot(BaseModel)` 与 A1 可空字段一致。
- [ ] **Step 2:** `/spot` 挂 `response_model=Spot`。
- [ ] **Verify:** 单测或 TestClient 断言 schema；`tsc --noEmit`。

---

### Task B4: 缓存 key 规范化

**Depends on:** A1（spot 稳定）  
**Priority:** P1  
**Files:** `pyserver/main.py`、`pyserver/analyst.py`、缓存命中测试

**注意:** fundamental/spot/analyst 缓存 payload 含原始 `symbol`。规范化 key 后须在命中时 **重写响应该次请求的 `symbol`**，或仅先规范化 klines（响应无 symbol）。

- [ ] **Step 1:** 选定策略（推荐：canonical key + 返回前覆盖 `symbol`）。
- [ ] **Step 2:** klines/fundamental/spot/analyst 按策略改；benchmark 已用 index 可不动。
- [ ] **Verify:** 别名两次请求上游只打一次 + 响应 symbol 等于当次请求。

---

### Task B5: cache prune 排序（不含后台线程）

**Depends on:** none  
**Priority:** P1  
**Files:** `pyserver/cache.py`、`pyserver/test_cache.py` / concurrency 测试

- [ ] **Step 1:** eviction 按 `fetched_at + ttl_seconds ASC`（最早到期优先）。
- [ ] **Step 2:** **本波不做** daemon 后台 prune（生命周期/测试隔离风险）；另立项。
- [ ] **Verify:** `uv run python -m unittest test_cache test_cache_concurrency -v` + 新 eviction 用例。

---

### Task B6: 非 root 容器

**Depends on:** none（可与 Wave 1 e 并行，但需完整权限方案）  
**Priority:** P1  
**Files:** `pyserver/Dockerfile`、`web/Dockerfile`、`docker-compose.yml`、README/runbook

- [ ] **Step 1:** 全部 COPY 之后创建 app 用户并 `chown` **实际可写路径**（含 cache-data、`/app/data`、private、`.cache` 挂载点在容器内的预期属主）。
- [ ] **Step 2:** named volume 初始化方案（不能只靠宿主 `chown private/`）；compose 验证 `docker compose run --rm pyserver id` → uid 1001。
- [ ] **Step 3:** 文档写明 bind mount UID 与 volume 首次权限。
- [ ] **Verify:** build + `id` 断言；真实 `compose up` 后 `/health` 与 cache 可写。

---

### Task C1: 端点缓存命中

**Depends on:** B4  
**Priority:** P1  
**Files:** create `pyserver/test_cache_hit.py`

- [ ] **Step 1:** 隔离 tempfile cache DB。
- [ ] **Step 2:** analyst/klines/fundamental/spot/benchmark 双调用，第二次不打上游。
- [ ] **Step 3:** 别名 key 命中（与 B4 策略一致）。
- [ ] **Verify:** `uv run python -m unittest test_cache_hit -v`

---

### Task C2: TestClient 集成语义

**Depends on:** P0-1, A1, A7  
**Priority:** P0  
**Files:** create `pyserver/test_endpoints.py`

- [ ] **Step 1:** `/klines` 成功列表（mock DF）。
- [ ] **Step 2:** 全源失败 → 502，且 **不写** 成功空缓存。
- [ ] **Step 3:** genuine empty → `200 []`，TTL 按 `_empty_bars_ttl`（**不要**写死一律 60s）。
- [ ] **Step 4:** `/fundamental` 缺 pe/pb/market_cap → 502。
- [ ] **Step 5:** `/spot` fallback ladder **含 Sina realtime**（Eastmoney → Sina → stock_value_em → history → …）。
- [ ] **Step 6:** `/health` 字段。
- [ ] **Verify:** `uv run python -m unittest test_endpoints -v`

---

### Task C5b: spot warnings / negative cache

**Depends on:** A1（及是否删除/实现 `_spot_warnings_from_row` 的决定）  
**Priority:** P1  
**Files:** `pyserver/test_spot_fallback.py`、negative-cache 测试

- [ ] **Step 1:** 与 A1/B3 精简决策对齐测试断言。
- [ ] **Step 2:** negative cache：失败写 sentinel、短 TTL、二次命中不伪装成功空业务结论。
- [ ] **Verify:** 相关 unittest 模块。

---

### Task B3: 精简死代码（收窄）

**Depends on:** Wave 1 车道 a/d 完成  
**Priority:** P1  
**Files:** 按符号删除/替换（禁止按行号）

**做：**
- 删除未调用的 `_hk_daily` / `_HK_DAILY_LIMITER`
- 删除未写入的 `Fundamental.revenue_yoy` + `web/lib/pyserver.ts` 对应字段
- 删除未使用导出 `scoreSymbolsLlm`（确认无引用）
- `_requests_get_no_proxy`：**有调用**——改为直接 `_market_http_get`，不要当死代码删
- `_spot_warnings_from_row`：实现或删除（与 A1/C5b 一致），非「纯死代码」
- **保留** `STRICT_LIVE_DATA` 启动断言
- `rankByRules`：若删则同步改 `web/test/scoring.test.ts`

**不做本波：** 与 D1/D2 纠缠的 deepseek 大清理；`excessReturnPct` root 清理可附带小 PR。

- [ ] **Verify:** pyserver unittest + `cd web && npm test && tsc --noEmit`

---

### Task E: 仅补缺口测试

**Depends on:** D3, D4, D5  
**Priority:** P2  

- [ ] **禁止** 重复 D3/D4/D5 已带的用例。
- [ ] 仅补：benchmark 无首日 bar 等 D 未覆盖边界；`excessReturnPct` 位置断言若做了 B3 清理则挂在 B3 commit。

---

### Task NEW-U: universe refresh `updated_at` 不变量

**Depends on:** none  
**Priority:** P1  
**Files:** `web` 侧 universe refresh 测试（新建或扩展现有）

- [ ] **Step 1:** LLM 空 proposal → 成功且 **不改写** 文件 / 不碰 `updated_at`。
- [ ] **Step 2:** 真实 add/remove/reclass → 更新 `updated_at`。
- [ ] **Verify:** 对应 `web/test` 文件 + 必要时 e2e。

---

## 全量完成门禁

1. `cd pyserver && uv run python -m unittest discover -s . -p 'test_*.py' -q`
2. `cd web && npm test && ./node_modules/.bin/tsc --noEmit`
3. 两镜像 `docker build`；若做了 B6，再 `compose` 冒烟 `/health`
4. 勿用仓库级主观 `grep 无重复` 作为唯一 verify

---

## 风险与注意事项

1. **`main.py` 是单写者车道**——Wave 1 车道 a 内任务必须串行，避免并行 implementer 互踩。
2. **P0-1 改变降级链行为**——须测试锁定；这是对 B-2 残留静默降级的修补，不是新业务兜底。
3. **A1 同时改 web 类型**——漏改消费点会在 `tsc` 暴露；verify 必含 tsc。
4. **D3 必须改 `isStrictLlmOutputError`**——否则「触发 repair」的叙述不成立，只会直接失败（也符合严格模式，但要与 brief 一致）。
5. **B4 响应 symbol**——规范化 key 时不得把缓存里的旧 symbol 回显给新别名请求。
6. **B6**——import 期建库/建目录；非 root 必须有可写路径方案，手册 chown 不算 verify。
7. **本计划不再声称「全量修复」**——未覆盖的 web route 硬化、依赖审计、pyserver mypy/ruff、完整 modularize 见后续计划。

---

## 修订历史

| 日期 | 变更 |
|------|------|
| 2026-08-04 | 初版（评估清单式全量计划） |
| 2026-08-04 | 多 agent 交叉评估后修订：修正已完成表与 B-2 契约、删 F1、外移大重构、重画依赖、P0-1/P0-2/NEW-U、禁行号执行、收窄 B3/B5、对齐 commit 风格 |
