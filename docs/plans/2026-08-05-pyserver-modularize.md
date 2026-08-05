# pyserver modularize Implementation Plan

> **For agentic workers:** Load `executing-plans`（2+ tasks）+ `git-worktrees`（在 main 上开分支）。按任务串行（共享 `main.py` 抽出面）。符号定位，**禁止依赖行号**。完成后 `finishing`。Checkbox 跟踪进度。

**Goal:** 行为 Freeze 下按数据域拆分 `main.py`，薄壳保留 `main:app`，并打断 `analyst → main` 循环依赖。  
**Spec:** `docs/specs/2026-08-05-pyserver-modularize.md`  
**Architecture:** `main.py` 为组合根 + 兼容 re-export；`config` / `models` / `symbols` / `util` / `http_util` / `providers.*` / `routes.*` 承载逻辑；`analyst` 只依赖中立模块。  
**Tech stack:** FastAPI, unittest (`uv run python -m unittest discover -p "test_*.py"`), Docker `uvicorn main:app`

**Commit 风格:** 祈使句、无强制前缀；每完成一 Task 且 Verify 绿后 commit。

**Patch 纪律（全计划通用）:** 函数迁出后，凡 `unittest.mock.patch("main.<name>")` 必须改到**被测代码实际绑定该名的模块**（通常是定义模块或 `routes.*` 的 import 名）。`main` 上保留同名 re-export 只保证 `main.<name>(...)` 直接调用，**不能**让对 `main.<name>` 的 patch 自动打进已 `from providers.x import name` 的路由。实现时以失败的现有测试为清单，逐个改 patch 路径。

---

## Files touched

| File | Action | Responsibility |
|------|--------|----------------|
| `pyserver/config.py` | create | env flags, `log`, `CACHE_NAMESPACE`, `_QUOTE_SOURCE_KEY`, `NEGATIVE_CACHE` |
| `pyserver/models.py` | create | Pydantic `Kline`/`Fundamental`/`Analyst`/`Spot` |
| `pyserver/symbols.py` | create | `_to_ts_code`, `_cache_ts_code`, `_echo_request_symbol`, `_compact_code`, `_infer_market_prefix`, `_eastmoney_market_code` |
| `pyserver/util.py` | create | `_num_or_none`, `_ak_col`, `_market_cap_to_yi`, `_source_summary`, `seconds_until_next_trading_close`, `_empty_bars_ttl` |
| `pyserver/http_util.py` | create | proxy strip, market HTTP session/get, `_TokenBucket`, `_ak_call`, `_with_retries`, locks |
| `pyserver/providers/__init__.py` | create | empty or minimal |
| `pyserver/providers/tushare_api.py` | create | `_pro` bootstrap, `_report_rc`/`_daily_basic`/`_fina_indicator`, YOY helpers |
| `pyserver/providers/baostock_api.py` | create | login/logout/hist/growth/rows |
| `pyserver/providers/akshare_hist.py` | create | `_ak_a_hist_df`, `_rows_from_ak_hist`, `_AK_HIST_RENAME` |
| `pyserver/providers/akshare_spot.py` | create | sina + ak spot chain, warnings, `_resolve_name`, price helpers |
| `pyserver/providers/akshare_analyst.py` | create | `_ak_consensus_eps`, `_ak_research_consensus`, `_ak_stock_value_row` |
| `pyserver/routes/__init__.py` | create | `register_all(app)` 或逐个 register |
| `pyserver/routes/health.py` | create | `/health` |
| `pyserver/routes/klines.py` | create | `/klines` |
| `pyserver/routes/spot.py` | create | `/spot` |
| `pyserver/routes/fundamental.py` | create | `/fundamental` |
| `pyserver/routes/benchmarks.py` | create | `/benchmark/klines`, `/benchmarks` |
| `pyserver/analyst.py` | modify | 去掉对 `main` 的 import；改 import 中立模块 |
| `pyserver/main.py` | modify | 薄壳：cache namespace 接线、挂路由、re-export |
| `pyserver/test_*.py` | modify | 重定向 `patch("main.…")` 到实际绑定模块；保留 `import main` / `main.app` 用法 |

---

## Task 1: 抽出 config / models / symbols / util / http_util

**Depends on:** none

**Files:**
- Create: `pyserver/config.py`, `models.py`, `symbols.py`, `util.py`, `http_util.py`
- Modify: `pyserver/main.py`（改为从上述模块 import，并 re-export 同名符号）
- Test: 现有 `test_unit_helpers.py`, `test_num_or_none.py`, `test_with_retries.py`, `test_validation.py`（应仍经 `main.` 访问）

- [x] **Step 1:** 创建 `config.py`：迁入 `log`、`MARKET_HTTP_PROXY`、`TUSHARE_TOKEN`、`MOCK_MODE`、`HAS_TUSHARE_TOKEN`、`STRICT_LIVE_DATA`、`MARKET_ENABLE_TUSHARE_SECONDARY`、`CACHE_NAMESPACE`、`NEGATIVE_CACHE`、`_QUOTE_SOURCE_KEY`。保留 `load_dotenv` / `_strip_proxy_env` 的启动副作用顺序与现网一致（dotenv + proxy strip 仍在 import 链最早处执行——可放 `config.py` 顶层，`main` 首先 `import config`）。
- [x] **Step 2:** 创建 `models.py`：迁入四个 Pydantic 模型。
- [x] **Step 3:** 创建 `symbols.py`：迁入 `_to_ts_code`、`_cache_ts_code`、`_echo_request_symbol`、`_compact_code`、`_infer_market_prefix`、`_eastmoney_market_code`。
- [x] **Step 4:** 创建 `util.py`：迁入 `_num_or_none`、`_ak_col`、`_market_cap_to_yi`、`_source_summary`、`seconds_until_next_trading_close`、`_empty_bars_ttl`。
- [x] **Step 5:** 创建 `http_util.py`：迁入 `_market_http_session`、`_market_http_get`、`_TokenBucket`、limiters、`_AK_LOCK`/`_BS_LOCK`、`_ak_call`、`_with_retries`。
- [x] **Step 6:** `main.py` 删除已迁定义，改为 import + **显式 re-export**（`from util import _num_or_none` 等），保证 `main._num_or_none` / `main._with_retries` 仍存在。保留 `cache_mod.CACHE_NAMESPACE = config.CACHE_NAMESPACE` 接线。
- [ ] **Verify:**  
  ```bash
  cd pyserver && uv run python -m unittest \
    test_unit_helpers test_num_or_none test_with_retries test_validation -v
  ```  
  期望：全部 PASS。

---

## Task 2: 抽出 providers（tushare / baostock / akshare_*）

**Depends on:** Task 1（共享基础模块）

**Files:**
- Create: `pyserver/providers/__init__.py`, `tushare_api.py`, `baostock_api.py`, `akshare_hist.py`, `akshare_spot.py`, `akshare_analyst.py`
- Modify: `pyserver/main.py`（import providers + re-export）
- Test: `test_baostock.py`, `test_klines_empty.py`（adapter 部分）, `test_spot_fallback.py`, `test_provider_logging.py`, `test_tushare_bootstrap.py`, `test_scrub_warnings.py`

- [x] **Step 1:** `providers/tushare_api.py`：迁入 `_pro` 初始化逻辑（与现 `MOCK_MODE` / `MARKET_ENABLE_TUSHARE_SECONDARY` 分支一致）、`_report_rc`、`_daily_basic`、`_fina_indicator`、`_latest_profit_yoy`、`_attach_profit_yoy`。
- [x] **Step 2:** `providers/baostock_api.py`：迁入 baostock login/logout/hist/rows/growth。
- [x] **Step 3:** `providers/akshare_hist.py`：迁入 `_AK_HIST_RENAME`、`_ak_a_hist_df`、`_rows_from_ak_hist`。
- [x] **Step 4:** `providers/akshare_spot.py`：迁入 sina/ak spot 全链、`parse_sina_hq_text`、spot warning/price helpers、`_resolve_name`。
- [x] **Step 5:** `providers/akshare_analyst.py`：迁入 `_ak_stock_value_row`、`_ak_consensus_eps`、`_ak_research_consensus`。
- [x] **Step 6:** `main.py` re-export 全部迁出的 provider 符号（含 `_pro`、`parse_sina_hq_text`）。路由函数可暂时仍留在 `main.py`，但应改为调用 providers（或仍通过本模块全局名——若仍定义在 main 则本 Task 末先保持路由在 main，仅 helper 迁出）。
- [x] **Step 7:** 按 **Patch 纪律** 更新失败测试的 `patch("main.<provider_fn>")` → `patch("providers.<mod>.<fn>")` 或 `patch("main.<fn>")` 仅当被测代码仍从 `main` 属性查找时。优先让被测直接调用 `main.<fn>` 的单测继续用 re-export；让路由内绑定名的集成测改 patch 目标。
- [ ] **Verify:**  
  ```bash
  cd pyserver && uv run python -m unittest \
    test_baostock test_klines_empty test_spot_fallback \
    test_provider_logging test_tushare_bootstrap test_scrub_warnings -v
  ```  
  期望：全部 PASS。

---

## Task 3: 抽出 routes（health / klines / spot / fundamental / benchmarks）

**Depends on:** Task 2（providers 已稳定）

**Files:**
- Create: `pyserver/routes/__init__.py`, `health.py`, `klines.py`, `spot.py`, `fundamental.py`, `benchmarks.py`
- Modify: `pyserver/main.py`（删除 route 函数体，改为 register）
- Test: `test_endpoints.py`, `test_cache_hit.py`, `test_cache_alias.py`, `test_fundamental_warning.py`, `test_validation.py`, `test_klines_empty.py`

- [x] **Step 1:** 每个 route 文件导出 `register(app)`，内部用 `@app.get(...)` 注册；handler 实现从 `main` **原样搬移**（Freeze），import providers/config/cache/validation/models。
- [x] **Step 2:** `routes/__init__.py` 提供 `register_routes(app)` 依次注册全部（analyst 仍由 `analyst.register_routes` 单独挂，见 Task 4）。
- [x] **Step 3:** `main.py`：`app = FastAPI(...)` 后调用 `routes.register_routes(app)`；**re-export** handler 函数名 `health`/`klines`/`spot`/`fundamental`/`benchmark_klines`/`list_benchmarks`，使 `main.klines(...)` 与 `TestClient(main.app)` 仍可用。
- [x] **Step 4:** 全面重定向 route 相关 `patch("main._ak_a_hist_df")` 等至 `routes.klines._ak_a_hist_df`（若 klines 从 providers import 到自己的全局）或 `providers.akshare_hist._ak_a_hist_df`——以「patch 能拦截 handler 内调用」为准，跑红测试直到绿。
- [ ] **Verify:**  
  ```bash
  cd pyserver && uv run python -m unittest \
    test_endpoints test_cache_hit test_cache_alias \
    test_fundamental_warning test_validation test_klines_empty -v
  ```  
  期望：全部 PASS。

---

## Task 4: 打断 analyst → main 环 + 瘦身 main

**Depends on:** Task 3（models/providers 已可被 analyst 直接 import）

**Files:**
- Modify: `pyserver/analyst.py`, `pyserver/main.py`
- Test: 含 analyst 的 endpoint/集成测（`test_endpoints.py` 若覆盖）；全量 suite

- [x] **Step 1:** 在 `analyst.py` 顶部改为：  
  `from config import MOCK_MODE, MARKET_ENABLE_TUSHARE_SECONDARY, log`  
  `from symbols import _to_ts_code, _echo_request_symbol`  
  `from util import _num_or_none, _ak_col, _source_summary`  
  `from http_util import _with_retries`  
  `from providers.akshare_spot import _ak_a_spot, _ak_a_spot_from_hist, _spot_price_from_ak`  
  `from providers.akshare_analyst import _ak_consensus_eps, _ak_research_consensus, _ak_stock_value_row`  
  `from providers.tushare_api import _daily_basic, _report_rc, _pro`  
  `from config import _QUOTE_SOURCE_KEY`  
  以及 `MOCK_MODE` 时 `from mock_data import mock_analyst`。  
  **删除**所有 `from main import ...`。
- [x] **Step 2:** `main.py` 仅保留：import config（副作用）、cache namespace 接线、`app`、`routes.register_routes`、`register_analyst_routes(app, Analyst)`、以及对测试所需符号的显式 re-export 列表（按 `rg 'main\.' pyserver/test_*.py` 清单维护，宁多勿漏）。
- [x] **Step 3:** 门禁：  
  ```bash
  rg -n 'from main import|import main' pyserver/analyst.py
  ```  
  期望：无匹配。
- [ ] **Verify:**  
  ```bash
  cd pyserver && uv run python -m unittest discover -p "test_*.py"
  ```  
  期望：全部 PASS。并确认：  
  ```bash
  cd pyserver && uv run python -c "from main import app; print(app.title)"
  ```  
  期望：打印 app title。

---

## Task 5: CI 入口与文档锚点确认

**Depends on:** Task 4

**Files:**
- Modify: 仅当 CI 失败时改 `.github/workflows/ci.yml`（预期**不改** `main:app` / `main.py` 路径）
- Modify: `docs/plans/2026-08-04-quality-remediation.md` 将 B1/B7 标注为「见本计划」或 Done（一行状态，避免漂移）

- [x] **Step 1:** 本地复现 CI pyserver 三步：  
  ```bash
  cd pyserver && uv run python -m py_compile main.py \
    && TUSHARE_TOKEN=dummy-ci-token uv run python -c "import importlib.util as u; spec=u.spec_from_file_location('m','main.py'); m=u.module_from_spec(spec); spec.loader.exec_module(m); print(m.app)" \
    && TUSHARE_TOKEN=dummy-ci-token uv run python -m unittest discover -p "test_*.py"
  ```  
  期望：全部成功。
- [x] **Step 2:** 更新质量计划外置表：B1/B7 → 指向本计划（或标记进行中/完成）。
- [ ] **Verify:** 同 Step 1；另：  
  ```bash
  rg -n 'from main import|import main' pyserver/analyst.py; test $? -eq 1
  ```

---

## Final verify

```bash
cd pyserver && TUSHARE_TOKEN=dummy-ci-token uv run python -m unittest discover -p "test_*.py"
rg -n 'from main import|import main' pyserver/analyst.py   # 无匹配
cd pyserver && uv run python -c "from main import app; assert app is not None"
```

成功标准对照 spec：
1. `main.py` 无业务编排/provider 实现（仅组合根 + re-export）
2. analyst 零依赖 main
3. 全量 pyserver 测试绿
4. Freeze：未改缓存键字符串、HTTP 契约、三态语义

---

## Out of scope（本计划不做）

- `deepseek.ts` modularize（切片 B，另立 spec/plan）
- Bars/NoData/Failed 类型系统
- 强制全体测试改为子模块 import（只改必要的 patch 路径）
- 删除 `main.py` 或改 Docker CMD 入口模块名
