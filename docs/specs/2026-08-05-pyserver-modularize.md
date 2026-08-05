# pyserver modularize（Wave 3 切片 A）

**Date:** 2026-08-05  
**Status:** Approved  
**Product:** topkyo AI 基建研究台  
**Program:** Wave 3 = 切片 A（本 spec）→ 切片 B（`deepseek.ts` modularize，另立 spec）

## Goal

在**行为 Freeze** 前提下，将 `pyserver/main.py`（~1465 行神文件）按数据域拆成可独立维护的模块，并打断 `analyst.py` 对 `main` 的 late-import 循环依赖。部署入口保持 `uvicorn main:app`；现有 `import main` 测试通过薄壳 re-export 继续可用。

## Constraints

- **A1 薄壳：** `main.py` 仍是组合根与兼容面；不强制改 Docker/CI 入口字符串。
- **行为 Freeze：** HTTP URL/query/JSON shape/status、缓存键字符串、三态（`None`=源失败 / empty=确认无行 / rows=有数据）、warning 与错误对外语义均不变。只允许改文件位置与 import 路径。
- **断环必做：** `analyst.py` 不得再 `from main import` / `import main`（含函数体内）。
- **严肃看盘规则不变：** 禁止业务兜底、禁止静默降级伪装成功。
- **依赖单向：** `routes` / `analyst` → `providers` / `symbols` / `config` / `models` → `cache` / `validation`；禁止 `providers` → `routes`/`main`；禁止 `analyst` → `main`。

## Design

### Architecture

- `main.py`：创建 `FastAPI`、挂载 `routes.*` 与 `analyst.register_routes`、为旧测试做显式 re-export。
- 业务与 provider 逻辑迁出到子模块；新代码禁止继续往 `main` 堆逻辑。
- 不引入 Bars/NoData/Failed 类型系统；不顺手改正确性语义。

### Components

| 模块 | 职责 |
|------|------|
| `config.py` | `MOCK_MODE`、Tushare/secondary flags、`CACHE_NAMESPACE`、`_QUOTE_SOURCE_KEY`、`log` 等 |
| `models.py` | `Kline` / `Fundamental` / `Analyst` / `Spot` |
| `symbols.py` | `_to_ts_code`、`_cache_ts_code`、`_echo_request_symbol`、`_compact_code` 等 |
| `http_util.py` | token bucket、`_with_retries`、`_ak_call`、market HTTP session |
| `providers/tushare.py` | `_pro`、daily_basic / fina / report_rc、YOY helpers |
| `providers/baostock.py` | login/hist/growth |
| `providers/akshare_hist.py` | A 股历史与 row 转换 |
| `providers/akshare_spot.py` | spot 链、Sina parse、spot warning helpers |
| `providers/akshare_analyst.py` | consensus EPS / research consensus / stock value row |
| `routes/klines.py` 等 | `/health`、`/klines`、`/spot`、`/fundamental`、`/benchmark*` |
| `analyst.py` | 一致预期业务；top-level import 中立模块 |

具体文件名在实现时可微调，但**数据域边界**（hist / spot / analyst 原料 / tushare / baostock / routes）必须保持可识别，避免重新合成神文件。

### Data flow

```
Client → main.app → routes.* | analyst routes
       → cache_get (key 算法与字符串不变)
       → miss → providers.*（现有降级链）
       → 响应 + cache_put
```

Mock 路径仍由 `config.MOCK_MODE` 门控；语义与拆分前一致。

### Error handling

- 不改 `HTTPException` 与 batch analyst 错误暴露策略。
- Provider 失败继续返回 `None`/记日志；不新增业务合成结论。
- Import/环错误应在测试导入阶段失败，不得静默改语义。

### Testing

1. 全量 pyserver 测试通过（现行 `uv run pytest` 或等价命令）。
2. `rg` 门禁：`analyst.py` 无对 `main` 的 import。
3. `from main import app` 可用；Docker/CI `main:app` 不变。
4. 现有 klines empty / spot / cache / validation / baostock 等测试即 Freeze 回归网。
5. 不强制重写测试 import；允许个别改为直 import 子模块。

## Success criteria

- [ ] `main.py` 仅为组合根 + 兼容 re-export（业务逻辑不在此文件）
- [ ] `analyst.py` 零依赖 `main`
- [ ] 全量 pyserver 测试绿
- [ ] 对外 HTTP/缓存键/三态语义与拆分前一致（Freeze）

## Out of scope

- 切片 B：`web/lib/deepseek.ts` modularize（另立 spec）
- Bars/NoData/Failed 类型系统、mypy/ruff 全量、依赖审计
- 改 LLM/web 路由、改市场数据源优先级、改缓存 TTL 策略
- 删除 `main.py` 或强制全体测试改 import 路径

## Open questions

(none)
