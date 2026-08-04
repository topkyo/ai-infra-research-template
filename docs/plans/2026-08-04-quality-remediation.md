# 全量质量 remediation 计划

> **For agentic workers:** Load `executing-plans` (2+ tasks). Use fresh implementer subagents per workstream. Then `finishing`. Checkboxes track progress.

**Goal:** 修复全量代码评估中发现的所有不足，覆盖正确性、代码质量、测试覆盖、安全、部署五个维度。
**Context:** B-1/B-2/B-3 已在紧急修复中完成（analyst 缓存 key 遮蔽、klines 空结果静默降级、Docker TZ）。本计划处理剩余问题。
**Constraint:** 每个新增 fallback/兜底逻辑前必须获得用户同意，并配套覆盖失败语义的测试（AGENTS.md 规则）。

---

## 已完成（紧急修复）

| 编号 | 问题 | 修复 | 验证 |
|------|------|------|------|
| B-1 | `analyst.py:131` 循环变量 `key` 遮蔽缓存 key | 改名为 `field_name` | 38 pyserver + 118 web tests pass |
| B-2 | `/klines` 和 `/benchmark/klines` 全源失败返回 `200 []` | df=None 时 raise 502；df.empty 时返回 [] 短 TTL 60s | 同上 |
| B-3 | Docker 容器未设 TZ → UTC 时区偏移 | 两个 Dockerfile + docker-compose.yml 设 `TZ=Asia/Shanghai`，pyserver 安装 tzdata | 同上 |

---

## Workstream A: pyserver 正确性与数据完整性

**Agent:** worker (medium complexity)
**Depends on:** none (与 B/C/D/E/F 可并行)

### Task A1: 修复 `float(... or 0)` 伪造零值字段 (B-4)

**Files:** `pyserver/main.py`

`/spot` 端点在 fallback 路径 (`main.py:1228-1231`) 用 `float(r.get("close", 0) or 0)` 提取字段，当上游 schema drift（列名变更）时会输出 `price: 0.0` 作为成功 quote，无 warning。

- [ ] **Step 1:** 将 `/spot` fallback 路径的 `float(r.get("close", 0) or 0)` 改为先检查字段是否存在：若 `close` 不在 row 中或为 NaN，append warning `"close field missing from upstream row"` 并 `raise HTTPException(502, ...)`。同理处理 `change_pct`、`volume`、`turnover`。
- [ ] **Step 2:** 对 `/spot` 前段 fallback 路径 (`main.py:1158-1160`) 的 `change_pct: ... or 0` 同样处理：缺失时设为 `None` 并 append warning，不伪造 0。
- [ ] **Step 3:** 对 `parse_sina_hq_text` (`main.py:751-756`) 的 `涨跌幅: 0` when `prev_close` missing：改为返回 `None` 并让调用方决定 warning。
- [ ] **Verify:** 新增 `test_spot_fallback.py` 测试：mock 上游返回不含 `close` 列的 DataFrame，断言 502 而非 `price: 0`。

**Commit:** `fix: reject zero-fabricated spot fields on upstream schema drift`

### Task A2: 修复 `_num_or_none` 多数字平均 bug

**Files:** `pyserver/main.py`

`_num_or_none` (`main.py:411-421`) 对字符串中所有数字取平均：`"1,234.5"` → `(1+234.5)/2 = 117.75`，而非解析失败。

- [ ] **Step 1:** 改为只提取第一个匹配的数字：`return float(matches[0])`。若字符串包含多个数字（如逗号分隔），说明格式不符合预期，log warning 并返回第一个。
- [ ] **Step 2:** 对逗号分隔的大数字（如 `"1,234.5"`），在 regex 前先 `str(value).replace(",", "")` 去除千位分隔符。
- [ ] **Verify:** 新增 `test_num_or_none.py`：测试 `None`→`None`、`3.14`→`3.14`、`"1,234.5"`→`1234.5`、`"N/A"`→`None`、`""`→`None`、`123`→`123.0`。

**Commit:** `fix: _num_or_none handles comma-separated numbers and single extraction`

### Task A3: provider helpers 吞异常无日志 → 补 log.warning

**Files:** `pyserver/main.py`

8 处 provider helper 用 `except Exception: df = None` / `return None` 吞异常且无日志 (`main.py:480`, `495`, `637`, `706`, `789`, `808`, `841`, `872`, `915`)。持续 AkShare 宕机不留任何服务端证据。

- [ ] **Step 1:** 在每个 `except Exception:` 块内加 `log.warning("provider %s failed: %s", fn_name, e)`（不含 URL/token，只记函数名和异常类型+消息）。
- [ ] **Step 2:** 不要改变返回值行为（仍返回 None），只补日志。
- [ ] **Verify:** 手动验证：mock 一个 provider 抛异常，确认 log.warning 被调用。新增测试断言日志输出。

**Commit:** `fix: log provider failures instead of silently swallowing`

### Task A4: 上游异常原文转发到 client warnings → 擦洗

**Files:** `pyserver/main.py`, `pyserver/analyst.py`

4 处将 Tushare 异常原文放入 `warnings` 列表 (`main.py:285`, `1113`; `analyst.py:124`, `178`)。

- [ ] **Step 1:** 将 `f"tushare XXX unavailable: {e}"` 改为 `f"tushare XXX unavailable: {type(e).__name__}"`（只暴露异常类型，不暴露消息体）。
- [ ] **Step 2:** 完整异常消息用 `log.exception(...)` 记录到服务端日志。
- [ ] **Verify:** grep 确认无 `f"...{e}"` 在 warnings 路径。新增测试断言 warnings 不含 URL/path。

**Commit:** `fix: scrub upstream exception details from client-facing warnings`

### Task A5: `/fundamental` 非实时价格无 warning → 补齐

**Files:** `pyserver/main.py`

`/fundamental` 从 `stock_value_em` 复制 `latest_close`/`latest_date`/`change_pct` (`main.py:1061-1064`)，可能数日旧，无 "not realtime" warning。`/analyst` 和 `/spot` 对同一来源已加 warning。

- [ ] **Step 1:** 在 `/fundamental` 从 `stock_value_em` 取 `latest_close` 时，若来源不是实时 spot，append warning `"latest_close is from AkShare stock_value_em, may not be realtime"`。
- [ ] **Step 2:** 利用已有的 `field_sources` 判断来源；若 `latest_close` 的 `field_sources` 不是实时 spot 源，加 warning。
- [ ] **Verify:** 新增 TestClient 测试：mock `/fundamental` 返回 stock_value_em 来源，断言 warnings 包含 "not realtime"。

**Commit:** `fix: warn when fundamental latest_close is not realtime`

### Task A6: `_with_retries` 最终失败后多余 sleep

**Files:** `pyserver/main.py`

`_with_retries` (`main.py:205-214`) 在最后一次尝试失败后仍执行 `time.sleep(base_delay * (2 ** i))`，浪费 2-4 秒才 raise。

- [ ] **Step 1:** 在 except 块内加 `if i < attempts - 1: time.sleep(...)` 条件，最后一次失败不 sleep 直接 raise。
- [ ] **Verify:** 新增测试：mock fn 恋抛异常，attempts=3，断言总耗时 < base_delay*(1+2) + 1s（不含最后一次 sleep）。

**Commit:** `fix: skip sleep after final retry attempt`

### Task A7: `/klines` 请求窗口无上限

**Files:** `pyserver/validation.py`

`_validate_date` 允许 1990-01-01 至明日 (`validation.py:32`, `68-71`)，无 span cap。单个请求可触发 35 年回测拉取。

- [ ] **Step 1:** 在 `/klines` 和 `/benchmark/klines` handler 中，若 `end - start > 3650 天`（10 年），raise 400 `"date range exceeds 10-year maximum"`。
- [ ] **Step 2:** 不修改 `_validate_date` 本身（其他端点可能需要长窗口），在 handler 层加 cap。
- [ ] **Verify:** 新增测试：start=19900101, end=today → 400。

**Commit:** `fix: cap klines request window to 10 years`

### Task A8: `/spot` 缺少 response_model (Pydantic)

**Files:** `pyserver/main.py`

`/spot` (`main.py:1129`) 返回 bare dict 无 Pydantic model，是最多分支的 payload 却无输出契约。`revenue_yoy` 死字段正是因此未被察觉。

- [ ] **Step 1:** 定义 `class Spot(BaseModel)` 含 `symbol, name, price, change_pct, volume, turnover, source, fetched_at, warnings`。
- [ ] **Step 2:** 给 `/spot` 加 `response_model=Spot`。
- [ ] **Step 3:** 同步更新 `web/lib/pyserver.ts` 的 Spot 类型（若需要）。
- [ ] **Verify:** TestClient 测试 `/spot` 返回符合 Spot model。

**Commit:** `fix: add Spot Pydantic model for /spot response contract`

---

## Workstream B: pyserver 架构与代码质量

**Agent:** worker (medium complexity)
**Depends on:** A 完成（避免 merge conflict）

### Task B1: 拆分 main.py god-file

**Files:** `pyserver/main.py` → 拆出 `pyserver/providers.py`, `pyserver/models.py`, `pyserver/spot.py`

main.py 1336 行持有 3 个 provider adapter、4 个 Pydantic 模型、token bucket、retry 逻辑、4 个路由处理器。

- [ ] **Step 1:** 提取 Pydantic 模型 (`Kline`, `Fundamental`, `Analyst`, `Spot`) 到 `pyserver/models.py`。
- [ ] **Step 2:** 提取 provider adapters (`_ak_a_hist_df`, `_baostock_hist_df`, `_ak_a_spot`, `_sina_a_spot_rows`, `_ak_stock_value_row` 等) 到 `pyserver/providers.py`。
- [ ] **Step 3:** 提取 `/spot` handler 到 `pyserver/spot.py`（类似 analyst.py 的模式）。
- [ ] **Step 4:** main.py 只保留 app 创建、路由注册、bootstrap/proxy/env 处理。
- [ ] **Step 5:** 更新 `pyserver/Dockerfile` 的 `COPY` 行包含新文件。
- [ ] **Step 6:** 移除 `main.py:85-93` 和 `:396-402` 的 test-only re-exports，改为测试直接 import 新模块。
- [ ] **Verify:** `uv run python -c "import main; print('OK')"` + 全部测试通过 + Docker build 通过。

**Commit:** `refactor: extract models, providers, and spot handler from main.py`

### Task B2: 消除重复代码

**Files:** `pyserver/main.py` (or 拆分后的 providers.py)

- [ ] **Step 1:** `trade_date`→rows 转换块 (`main.py:1008-1021` ≡ `1295-1308`) 提取为 `_rows_from_trade_date(df)` helper。
- [ ] **Step 2:** 中列名 rename map 出现 3 次 (`_AK_HIST_RENAME` at `452`, inline at `999-1002`, inline at `1205-1210`)：统一引用 `_AK_HIST_RENAME`。
- [ ] **Step 3:** `NEGATIVE_CACHE` get/check/put 前导代码重复 4 次 (`585-590`, `624-629`, `685-690`, `770-775`)：提取为 `_negative_cache_check(key) -> dict | None` 和 `_negative_cache_put(key, ttl)` helpers。
- [ ] **Verify:** 测试通过 + grep 确认无重复块。

**Commit:** `refactor: deduplicate row conversion, rename maps, and negative-cache preamble`

### Task B3: 清理死代码

**Files:** `pyserver/main.py`, `web/lib/deepseek.ts`, `web/lib/scoring/rules.ts`

- [ ] **Step 1:** 删除 `_hk_daily` (`main.py:217-220`) 和 `_HK_DAILY_LIMITER`（从未调用）。
- [ ] **Step 2:** 删除 `_requests_get_no_proxy` (`main.py:145`)（`_market_http_get` 的 pass-through 别名）。
- [ ] **Step 3:** `_spot_warnings_from_row` (`main.py:818-819`)：要么实现真正的 warning 逻辑，要么删除并更新 `test_spot_fallback.py` 的断言。
- [ ] **Step 4:** `_sina_hq_list_id(market, code)` (`main.py:730`)：删除忽略的 `market` 参数或修正调用。
- [ ] **Step 5:** `Fundamental.revenue_yoy` (`main.py:338`)：删除字段 + 同步 `web/lib/pyserver.ts:26`。
- [ ] **Step 6:** `STRICT_LIVE_DATA` (`main.py:76`)：若仅 bootstrap 断言引用，内联或删除。
- [ ] **Step 7:** `web/lib/deepseek.ts`: 删除 `scoreSymbolsLlm` 导出 (`:601`)、`totalWeight || 1` 死分支 (`backtest.ts:337`)。
- [ ] **Step 8:** `web/lib/scoring/rules.ts`: 删除 `rankByRules` 别名 (`:106`) + 更新测试。
- [ ] **Step 9:** `web/lib/backtest.ts`: 删除 `BenchmarkResult` root 的 `excessReturnPct` (`:152`)，只保留 `stats.excessReturnPct`。
- [ ] **Verify:** tsc + 全部测试通过。

**Commit:** `refactor: remove dead code across pyserver and web`

### Task B4: 缓存 key 规范化

**Files:** `pyserver/main.py`, `pyserver/analyst.py`

标的别名（`600519`, `sh600519`, `600519.SH`, `600519.sh`, `SH600519`）产生 5 个缓存 key/股票。

- [ ] **Step 1:** 在所有 `cache_put`/`cache_get` 调用处，用规范化后的 `ts_code` 构造 key，而非原始输入 `symbol`。
- [ ] **Step 2:** 具体位置：`klines` key (`main.py:945`)、`fundamental` key (`:1032`)、`spot` key (`:1133`)、`analyst` key (`analyst.py:50`)、`benchmark` key（已用 index，不需要改）。
- [ ] **Step 3:** 保留原始 `symbol` 在响应中（客户端看到的是请求时的格式）。
- [ ] **Verify:** 新增测试：分别用 `600519` 和 `sh600519` 请求 `/klines`，第二次应命中缓存。

**Commit:** `fix: normalize cache keys to ts_code to avoid duplicate upstream hits`

### Task B5: 缓存 prune 改进

**Files:** `pyserver/cache.py`

- [ ] **Step 1:** prune 的 eviction 策略改为优先 evict 过期行 + TTL 最短的行，而非纯 `fetched_at ASC`（当前会 evict 新写入的 24h fundamental 行而保留旧的 30s spot 行）。
- [ ] **Step 2:** 改为 `ORDER BY fetched_at + ttl_seconds ASC LIMIT ?`（最近过期的优先 evict）。
- [ ] **Step 3:** `cache_prune` 从请求线程移到后台线程：在 `_init_db()` 后启动一个 daemon thread，每 `_PRUNE_INTERVAL_S` 秒执行一次 `cache_prune()`，`cache_put` 中只更新 `_last_prune_at` 不再同步调用。
- [ ] **Verify:** `test_cache_concurrency.py` 通过 + 新增测试验证 prune 优先 evict 过期行。

**Commit:** `fix: improve cache prune eviction policy and move to background thread`

### Task B6: 容器非 root 运行

**Files:** `pyserver/Dockerfile`, `web/Dockerfile`

- [ ] **Step 1:** pyserver Dockerfile：在 `RUN pip install ...` 后加 `RUN useradd -r -u 1001 app && chown -R app /app`，在 `CMD` 前加 `USER app`。
- [ ] **Step 2:** web Dockerfile：在 runner stage 加 `RUN groupadd -r app && useradd -r -u 1001 -g app app && chown -R app /app`，加 `USER app`。注意 `next start` 需要 `.next/` 目录可读 + `.cache/` volume 可写。
- [ ] **Step 3:** docker-compose.yml 的 volume 挂载目录权限：在 README/runbook 中说明首次需 `chown -R 1001 private/ web-cache/`。
- [ ] **Verify:** `docker build` 成功 + `docker run --rm ... id` 输出 `uid=1001`。

**Commit:** `fix: run containers as non-root user`

### Task B7: 修复 analyst.py 循环依赖

**Files:** `pyserver/analyst.py`, `pyserver/main.py` (or 拆分后的 providers.py)

`analyst.py:29-43` 在请求路径内做 20 个名字的延迟 import。

- [ ] **Step 1:** 将被 analyst.py 依赖的 helper 函数（`_to_ts_code`, `_validate_symbol`, `_ak_a_spot`, `_num_or_none` 等）移到 `pyserver/providers.py` 或 `pyserver/utils.py`，使 analyst.py 可以在模块顶层 import。
- [ ] **Step 2:** 移除 analyst.py 内的 `from main import (...)` 延迟 import，改为顶层 `from providers import ...`。
- [ ] **Step 3:** 保留 `MOCK_MODE` / `MARKET_ENABLE_TUSHARE_SECONDARY` 的延迟读取（这些是运行时 env，可能被 main.py 重赋值），或改为函数调用 `from config import is_mock_mode, is_tushare_secondary`。
- [ ] **Verify:** `uv run python -c "import analyst; analyst.analyst('600519')"` 不报循环 import。

**Commit:** `refactor: break analyst.py circular dependency with top-level imports`

---

## Workstream C: pyserver 测试覆盖

**Agent:** worker (medium complexity)
**Depends on:** A 完成（测试新行为需要修复先行）

### Task C1: 缓存命中测试

**Files:** `pyserver/test_cache_hit.py` (new)

无任何端点的缓存命中测试——B-1 正因此存活。

- [ ] **Step 1:** 使用 `TestClient`（`fastapi.testclient`）测试 `/analyst`：mock provider 返回数据，调用两次，第二次断言上游 mock 只被调用一次（缓存命中）。
- [ ] **Step 2:** 同理测试 `/klines`、`/fundamental`、`/spot`、`/benchmark/klines`。
- [ ] **Step 3:** 测试缓存 key 规范化：用 `600519` 和 `sh600519` 各请求一次 `/klines`，断言上游只被调用一次。
- [ ] **Verify:** `uv run python -m unittest test_cache_hit -v` 通过。

**Commit:** `test: add cache hit tests for all endpoints`

### Task C2: TestClient 集成测试

**Files:** `pyserver/test_endpoints.py` (new)

所有端点测试直接调 handler 函数，只断言 400。无成功 payload、warning payload、空结果 vs 错误语义测试。

- [ ] **Step 1:** 用 `TestClient` 测试 `/klines` 成功返回 Kline 列表（mock akshare 返回 DataFrame）。
- [ ] **Step 2:** 测试 `/klines` 全源失败返回 502（B-2 修复后的新行为）。
- [ ] **Step 3:** 测试 `/klines` 空窗口返回 `200 []` + 60s TTL（genuine empty）。
- [ ] **Step 4:** 测试 `/fundamental` 502 on missing pe/pb/market_cap（`main.py:1121` 规则）。
- [ ] **Step 5:** 测试 `/spot` fallback ladder：Eastmoney OK → stock_value_em + warning → daily close + warning → 502。
- [ ] **Step 6:** 测试 `/health` 返回正确字段。
- [ ] **Verify:** `uv run python -m unittest test_endpoints -v` 通过。

**Commit:** `test: add TestClient integration tests for success, warning, and error paths`

### Task C3: 核心函数单元测试

**Files:** `pyserver/test_unit_helpers.py` (new)

`_to_ts_code`, `_num_or_none`, `seconds_until_next_trading_close`, `_source_summary` 均无测试。

- [ ] **Step 1:** `_to_ts_code`: 测试 `600519`→`600519.SH`、`000858`→`000858.SZ`、`300750`→`300750.SZ`、`688981`→`688981.SH`、`830799`→`830799.BJ`、`hk00700`→`00700.HK`、`SH600519`→`600519.SH`。
- [ ] **Step 2:** `_num_or_none`: 覆盖 Task A2 的全部 case。
- [ ] **Step 3:** `seconds_until_next_trading_close`: mock `datetime.now()` 测试盘中、盘后、周末的 TTL 值。
- [ ] **Step 4:** `_source_summary`: 测试 8 个分支的输出字符串。
- [ ] **Verify:** `uv run python -m unittest test_unit_helpers -v` 通过。

**Commit:** `test: add unit tests for _to_ts_code, _num_or_none, TTL, and source summary`

### Task C4: BaoStock 路径测试

**Files:** `pyserver/test_baostock.py` (new)

`_baostock_hist_df`、`_baostock_growth_yoy` 零测试覆盖，包括 login/logout lock 纪律。

- [ ] **Step 1:** mock `baostock.query_history_k_data_plus` 返回正常 DataFrame，断言 `_baostock_hist_df` 正确转换并 logout。
- [ ] **Step 2:** mock 返回 `error_code != "0"`，断言返回 None 且 logout 被调用。
- [ ] **Step 3:** mock 返回空数据，断言返回 None 且 logout 被调用。
- [ ] **Step 4:** mock `baostock.query_growth_data` 路径测试 `_baostock_growth_yoy`。
- [ ] **Verify:** `uv run python -m unittest test_baostock -v` 通过。

**Commit:** `test: add BaoStock provider path tests with mocked baostock`

### Task C5: 修复测试 hygiene

**Files:** `pyserver/test_tushare_bootstrap.py`, `pyserver/test_spot_fallback.py`

- [ ] **Step 1:** `test_tushare_bootstrap.py`: 用 `unittest.mock.patch.dict(os.environ, ...)` 替代直接 `os.environ[...] = ...`，确保测试后 env 恢复。
- [ ] **Step 2:** `test_tushare_bootstrap.py`: 不再用 `PYSERVER_CACHE_DB=:memory:`（会静默禁用缓存），改用 `tempfile.NamedTemporaryFile` 并在 tearDown 中删除。
- [ ] **Step 3:** `test_spot_fallback.py`: 若 `_spot_warnings_from_row` 被实现（B3 Task），更新断言；若被删除，移除对应测试。
- [ ] **Step 4:** 新增 negative cache 行为测试：mock provider 失败，断言 sentinel 被写入且短 TTL，第二次调用命中 sentinel 返回 None。
- [ ] **Verify:** `uv run python -m unittest discover -p "test_*.py"` 全部通过，无 env 泄漏。

**Commit:** `test: fix env leak in tushare bootstrap test and add negative cache test`

---

## Workstream D: web/LLM/backtest 代码质量

**Agent:** worker (medium complexity)
**Depends on:** none (与 A/B/C/E/F 可并行)

### Task D1: 拆分 deepseek.ts

**Files:** `web/lib/deepseek.ts` → `web/lib/llm/client.ts`, `web/lib/llm/mock.ts`, `web/lib/llm/types.ts`

deepseek.ts 815 行包含 HTTP client、类型定义、system prompts、validation、scoring orchestration、mock provider。

- [ ] **Step 1:** 提取类型定义 (`SymbolSnapshot`, `Signal`, `PortfolioTargetSignal`, `ScoringSnapshot` 等) 到 `web/lib/llm/types.ts`。
- [ ] **Step 2:** 提取 HTTP client (`chatDetailed`, `chat`, retry 逻辑, error classes) 到 `web/lib/llm/client.ts`。
- [ ] **Step 3:** 提取 mock provider (`mockSignalFor`, `mockPortfolioTargetFor`, `mockProviderActive`) 到 `web/lib/llm/mock.ts`。
- [ ] **Step 4:** deepseek.ts 只保留 scoring orchestration + validation + system prompts。
- [ ] **Step 5:** 更新所有 import 路径。
- [ ] **Verify:** `tsc --noEmit` + `npm test` 通过。

**Commit:** `refactor: extract llm client, types, and mock from deepseek.ts`

### Task D2: 消除 scoring 函数重复

**Files:** `web/lib/deepseek.ts` (or 拆分后)

`scoreSymbolsBatchLlm` / `scorePortfolioTargetsBatchLlm` ~80 行重复控制流；`scoreSymbols` / `scorePortfolioTargets` ~40 行重复。

- [ ] **Step 1:** 提取共享 `scoreWithRetry<T>(opts: { systemPrompt, userPayload, normalize, model, ... })` 高阶函数，封装 retry + strict repair + batch 循环。
- [ ] **Step 2:** `scoreSymbolsBatchLlm` 和 `scorePortfolioTargetsBatchLlm` 调用 `scoreWithRetry` 并传入各自的 prompt/normalize/model。
- [ ] **Step 3:** 同理提取 `scoreOrchestrate<T>(opts: { scorer, unscorable, batchSize, ... })` 统一 `scoreSymbols` / `scorePortfolioTargets`。
- [ ] **Verify:** `npm test` 通过 + grep 确认无重复控制流。

**Commit:** `refactor: deduplicate LLM scoring orchestration with shared higher-order functions`

### Task D3: 修复 clamp01 严格性不一致

**Files:** `web/lib/deepseek.ts`

`clamp01` 对 confidence/size 静默截断到 [0,1]，而 `strictWeight` 对 targetWeight 严格拒绝越界。

- [ ] **Step 1:** 将 `confidence` 和 `size` 的校验改为与 `strictWeight` 一致：非 number/非 finite/<0/>1 时 throw `LLM returned invalid confidence` 触发 strict repair retry。
- [ ] **Step 2:** 更新 mock provider 确保 confidence/size 在 [0,1] 内（mock 已在范围内，无需改）。
- [ ] **Step 3:** 更新 `test/deepseek.test.ts` 新增越界 confidence/size 的拒绝测试。
- [ ] **Verify:** `npm test` 通过。

**Commit:** `fix: validate confidence and size strictly instead of silent clamping`

### Task D4: 修复 computeStatsFromEquities NaN 风险

**Files:** `web/lib/backtest.ts`

无 empty array / start=0 guard（当前不可达因 min 5 dates，但无防御）。

- [ ] **Step 1:** 在函数入口加 `if (equities.length < 2) throw new Error("need >= 2 equity points")`。
- [ ] **Step 2:** 在 `totalReturnPct` 计算前加 `if (start <= 0) throw new Error("starting equity must be positive")`。
- [ ] **Step 3:** `computeBenchmarkResult` 同理加 guard（已有 `first.close <= 0` 检查，补 `equities.length < 2`）。
- [ ] **Verify:** 新增 `test/backtest.test.ts` 测试：空数组和 start=0 抛 Error。

**Commit:** `fix: guard computeStatsFromEquities against empty array and zero equity`

### Task D5: Mock portfolio target 一致性

**Files:** `web/lib/deepseek.ts` (or `web/lib/llm/mock.ts`)

Mock portfolio targets 有空 evidence/risks 数组，绕过 strict validation。

- [ ] **Step 1:** 在 mock provider 中填充非空 evidence/risks（如 `["mock evidence"]` / `["mock risk"]`），使 mock 输出能通过 strict validation。
- [ ] **Step 2:** 或者：在 `PortfolioTargetSignal` 类型中将 evidence/risks 改为 optional，strict validation 只在非 mock 路径执行（不推荐，破坏类型安全）。
- [ ] **Step 3:** 推荐 Step 1：mock 填充占位值。
- [ ] **Verify:** `npm test` 通过 + mock signal 能通过 `normalizePortfolioSignals`。

**Commit:** `fix: populate mock portfolio target evidence and risks for type consistency`

---

## Workstream E: web 测试覆盖

**Agent:** worker (light complexity)
**Depends on:** D 完成（测试新行为需要修复先行）

### Task E1: 回测边界测试

**Files:** `web/test/backtest.test.ts`

- [ ] **Step 1:** 测试 `computeStatsFromEquities` 空/单元素数组抛 Error（D4 修复后）。
- [ ] **Step 2:** 测试 `computeStatsFromEquities` start=0 抛 Error。
- [ ] **Step 3:** 测试 benchmark 无 `dates[0]` bar 时 `computeBenchmarkResult` 返回 undefined（当前行为验证）。
- [ ] **Step 4:** 测试 `rebalanceEveryNDays=1`（日频调仓）的 T+1 安全性。
- [ ] **Verify:** `npm test` 通过。

**Commit:** `test: add backtest edge case tests for empty equity and zero start`

### Task E2: LLM 校验严格性测试

**Files:** `web/test/deepseek.test.ts`

- [ ] **Step 1:** 测试越界 confidence (>1, <0, NaN, string) 被 strict validation 拒绝（D3 修复后）。
- [ ] **Step 2:** 测试越界 size 同理。
- [ ] **Step 3:** 测试 mock portfolio target 的 evidence/risks 非空（D5 修复后）。
- [ ] **Step 4:** 测试 `excessReturnPct` 只在 `stats` 下存在，不在 `benchmark` root（B3 Task 后）。
- [ ] **Verify:** `npm test` 通过。

**Commit:** `test: add LLM validation strictness tests for confidence and size`

---

## Workstream F: 文档与杂项

**Agent:** worker (light complexity)
**Depends on:** none (与所有 workstream 可并行)

### Task F1: 修复 README 引用

**Files:** `README.md`

- [ ] **Step 1:** 检查 `scripts/macos/README.md` 和 `scripts/monitor-dashboard.sh` 是否存在；若不存在，移除 README 中的引用或创建缺失文件。
- [ ] **Step 2:** 检查 `scripts/` 目录内容，确保 README "常用命令" 表中的所有脚本路径正确。
- [ ] **Verify:** `grep -r "monitor-dashboard\|macos/README" README.md` 输出与实际文件一致。

**Commit:** `docs: fix README references to missing scripts`

### Task F2: 文档化回测执行模型

**Files:** `README.md`, `docs/RESEARCH_WORKFLOW.md`

回测使用 same-day close-to-close 执行模型（信号和成交都用当日收盘价），这是方法论选择但需显式声明。

- [ ] **Step 1:** 在 README "严格回测" 描述中加注："信号与成交均使用当日收盘价（same-day close-to-close），不建模盘中路径；此简化可能略微高估动量策略收益。"
- [ ] **Step 2:** 在 `docs/RESEARCH_WORKFLOW.md` 中补充回测方法论说明。
- [ ] **Verify:** 人工 review。

**Commit:** `docs: document same-day close-to-close backtest execution model`

### Task F3: pyserver .dockerignore

**Files:** `pyserver/.dockerignore` (new)

web/ 有 .dockerignore，pyserver/ 没有。

- [ ] **Step 1:** 创建 `pyserver/.dockerignore` 忽略 `.env`, `cache.db*`, `__pycache__/`, `.venv/`, `test_*.py`, `*.pyc`。
- [ ] **Step 2:** 注意：Dockerfile COPY 只拷贝特定文件，但 .dockerignore 可减少 build context 传输。
- [ ] **Verify:** `docker build` 成功 + build context 体积减小。

**Commit:** `chore: add .dockerignore for pyserver`

---

## 执行顺序与并行策略

```
Phase 1 (紧急): B-1, B-2, B-3  ← 已完成

Phase 2 (并行):
  ├─ Workstream A (pyserver 正确性)     ← Agent 1
  ├─ Workstream D (web 代码质量)        ← Agent 2
  └─ Workstream F (文档与杂项)          ← Agent 3

Phase 3 (依赖 Phase 2):
  ├─ Workstream B (pyserver 架构)       ← Agent 1 (依赖 A 完成)
  ├─ Workstream C (pyserver 测试)       ← Agent 4 (依赖 A 完成)
  └─ Workstream E (web 测试)            ← Agent 2 (依赖 D 完成)
```

**每个 Task 完成后：**
1. 运行对应测试套件（`uv run python -m unittest discover` / `npm test` / `tsc --noEmit`）
2. 提交独立 commit（遵循 AGENTS.md commit 规范）
3. 勾选 checkbox

**全部完成后：**
1. `cd web && npm test && ./node_modules/.bin/tsc --noEmit`
2. `cd pyserver && uv run python -m unittest discover -p "test_*.py"`
3. `docker build` 两个镜像成功
4. 更新 README（如需要）

---

## 风险与注意事项

1. **B1 Task (拆分 main.py) 是最高风险变更**：可能引入循环 import、Dockerfile COPY 遗漏、测试 import 路径断裂。建议在独立分支上完成，逐步验证。
2. **B4 Task (缓存 key 规范化) 会改变缓存行为**：已有缓存数据将全部 miss 一次（因为 key 变了），但不影响正确性。
3. **B6 Task (非 root 运行) 可能影响 volume 权限**：需要文档说明首次部署的 chown 步骤。
4. **D3 Task (clamp01 改 strict) 可能导致现有 LLM 输出被拒绝**：如果 DeepSeek 当前偶尔返回 >1 的 confidence，改为 strict 会导致 strict repair retry。需评估是否值得多一次 API 调用。
5. **新增 fallback 逻辑前必须获得用户同意**（AGENTS.md 规则）。本计划中无新增 fallback，所有修复都是"拒绝伪造数据"或"改善日志/测试"方向。
