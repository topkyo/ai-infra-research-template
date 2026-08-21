# 运行手册

这份手册收纳完整应用的本地运行、环境变量、缓存和常见排障。项目入口和产品说明见根目录 [README.md](../README.md)。

## 前置条件

| 组件 | 要求 |
|---|---|
| Node.js | 本地以根目录 [`.nvmrc`](../.nvmrc) 为准；`better-sqlite3` 必须按实际运行时 Node ABI 重建。 |
| Python | `pyproject.toml` 声明 `requires-python >=3.11`；CI/Docker 验证 3.13，推荐本地 3.13。依赖由 `uv` 管理。 |
| LLM key | `OPENCODE_GO_API_KEY` 或 `DEEPSEEK_API_KEY`。 |
| 市场数据 | 默认免费真实数据无需 Tushare；Tushare 只作为显式次级源。 |

CI 使用 Node 24，Dockerfile 使用 `node:24-slim`，与 `package.json` engines 要求的 Node 24.5.0 一致（本地 `.nvmrc` 同为 24.5.0）。不要混用同一份 `node_modules`；切换 Node 主版本后执行 `cd web && npm install` 或 `./scripts/rebuild-native-modules.sh`。

## 环境文件

| 文件 | 用途 |
|---|---|
| `.env.example` | Docker Compose 示例变量，复制为根目录 `.env`。 |
| `web/env.example.txt` | Web / LLM 示例变量，复制为 `web/.env.local`。 |
| `pyserver/env.example` | sidecar 市场数据变量，复制为 `pyserver/.env`。 |

最小本地配置：

```bash
cp web/data/universe.example.json web/data/universe.json
cd pyserver && cp env.example .env
cd ../web && cp env.example.txt .env.local
```

`pyserver/.env` 留空 `TUSHARE_TOKEN` 时走免费真实数据源。只有要启用 Tushare 补缺时，才设置：

```bash
TUSHARE_TOKEN=your-real-token
MARKET_ENABLE_TUSHARE_SECONDARY=1
```

## 启动

分别启动：

```bash
cd pyserver
uv sync
uv run uvicorn main:app --host 127.0.0.1 --port 8001 --reload
```

```bash
nvm install
nvm use
cd web
npm install
npm run dev
```

也可以从仓库根目录用联动脚本启动两个服务：

```bash
./start.sh
```

打开：

- Web：<http://localhost:3000>
- pyserver OpenAPI：<http://localhost:8001/docs>
- pyserver health：<http://localhost:8001/health>

## 真实持仓与组合信号

`/signals` 有两种组合模式：

| 模式 | 行为 |
|---|---|
| 真实持仓 | 读取 `web/data/holdings.local.json`，用现价计算当前权重、浮盈亏、目标金额和调仓差额。 |
| 模拟资金 | 使用页面输入的现金金额推演目标仓位，不读取真实持仓，不代表实际账户。 |

真实持仓文件被 `.gitignore` 忽略，避免提交现金、成本和持仓数量。可从示例复制：

```bash
cd web
cp data/holdings.example.json data/holdings.local.json
```

也可以在 `/signals` 页面粘贴券商持仓表，支持中文表头如 `证券代码`、`持仓数量`、`成本价`、`可用资金`，以及英文 CSV 表头 `symbol`、`shares`、`cost_basis`、`cash`。保存后会调用 `/api/holdings` 写入本地 JSON。

校验规则：

- `cash` 必须是非负数字。
- `positions[].symbol` 必须在股票池内，不能重复。
- `positions[].shares` 必须为正数。
- `positions[].cost_basis` 必须为非负数字。

真实模式下如果文件缺失或非法，`/api/signals` 会返回 `setup_required`，并在加载行情和调用 LLM 前停止。这样不会把“无持仓配置”误当成空仓信号。

## LLM 调优变量

OpenCode Go / DeepSeek 对大股票池同步 JSON 生成延迟较高。信号与回测均要求 LLM 覆盖请求内全部标的；输出缺失、重复、未知代码、实时信号非法 `targetWeight` 或回测非法 `action` 时任务失败，UI/API 显式报错。

| 变量 | 默认 | 说明 |
|---|---:|---|
| `LLM_PROVIDER` | `deepseek` | 推荐直连 `deepseek`（官方 Flash-0731）；可选 `opencode-go` 作备用。 |
| `LLM_MODEL` | `deepseek-v4-flash` | 实时信号与股票池刷新模型。默认与回测同用 Flash，避免信号/回测模型不一致；Pro 有实质升级后再单独设 `deepseek-v4-pro`。 |
| `LLM_MODEL_BACKTEST` | `deepseek-v4-flash` | 回测调仓日模型。 |
| `SIGNALS_LLM_SCORE_BATCH_SIZE` | `10` | 实时信号 LLM 批大小，串行执行。 |
| `SIGNALS_LLM_TIMEOUT_MS` | `900000` | 实时信号单批 LLM 超时。 |
| `SIGNALS_LLM_MAX_ATTEMPTS` | `1` | 实时信号技术重试次数。 |
| `SIGNALS_LOAD_CONCURRENCY` | `3` | 实时信号加载 K 线/基本面的并发数。 |
| `SIGNALS_PYSERVER_TIMEOUT_MS` | `120000` | 实时信号单只 K 线请求超时。 |
| `SIGNALS_FUNDAMENTAL_TIMEOUT_MS` | `8000` | 实时信号单只基本面请求超时。 |
| `LLM_TRANSPORT_MAX_ATTEMPTS` | `3` | LLM HTTP 临时失败重试次数，覆盖 `408/429/5xx` 和网络抖动；不修正业务输出。 |
| `BACKTEST_LLM_SCORE_BATCH_SIZE` | `10` | 回测每个调仓日内 LLM 批大小。 |
| `BACKTEST_SIGNAL_CONCURRENCY` | `8` | 并行处理的调仓日数量。 |
| `BACKTEST_LLM_TIMEOUT_MS` | `300000` | 回测单批 LLM 超时。 |
| `BACKTEST_LLM_MAX_ATTEMPTS` | `2` | 回测单批技术重试次数。 |
| `BACKTEST_LOAD_CONCURRENCY` | `10` | 回测加载 K 线/基本面的并发数。 |
| `BACKTEST_PYSERVER_TIMEOUT_MS` | `60000` | 回测单只 K 线请求超时。 |
| `BACKTEST_SLIPPAGE_BPS` | `0` | 回测单边滑点（bps），请求体 `slippageBps` 优先；页面默认填 5。 |
| `BACKTEST_RESPECT_PRICE_LIMITS` | `1` | 回测涨跌停限制（涨停不可买/跌停不可卖，按板块 10%/20%/30%），`0` 关闭；请求体 `respectPriceLimits` 优先。 |
| `LLM_SCORE_BATCH_SIZE` | `10` | `scoreSymbols` 其他调用方默认批大小。 |
| `UNIVERSE_REFRESH_LLM_TIMEOUT_MS` | `900000` | 股票池刷新提议阶段 LLM 超时。 |
| `UNIVERSE_REFRESH_VALIDATE_TIMEOUT_MS` | `20000` | 股票池刷新新增标的 pyserver 校验超时。 |
| `UNIVERSE_REFRESH_ENABLED` | `1` | 设为 `0` 时 `/api/universe/refresh` 显式报错且首页刷新按钮禁用（冻结/只读场景）。默认启用：compose 将 `./web/data` bind-mount，UI 刷新原子写入宿主机。访问控制靠网络层（模式 B：SSH 隧道；模式 A：Caddy Basic Auth），无应用层刷新令牌。**注意**：刷新后 `universe.json` 可能有未提交改动，`git pull --ff-only` 可能冲突。 |

批大小越小越稳，但总耗时更长。信号和回测失败时优先检查 key、模型、批大小、超时和 pyserver 可用性。

## 缓存

| 层 | 位置 | 用途 | TTL |
|---|---|---|---|
| 浏览器现价缓存 | `localStorage` | 首页现价与涨跌幅 | 15 分钟 |
| 浏览器分析师缓存 | `localStorage` | 首页隐含目标与评级 | 24 小时 |
| Python 市场数据缓存 | `pyserver/cache.db` 或 `PYSERVER_CACHE_DB` | K 线、基本面、分析师、spot | 分层 TTL |
| LLM 回包缓存 | `web/.cache/web.db` | prompt + model 哈希 | 约 12 小时 |
| 回测结果存档 | `web/.cache/web.db` | 历史回测结果 | 长期保留 |

缓存维护（两端一致）：读取时立即删除过期行；写入按时间间隔节流触发清理，先删过期行，再按最旧 `fetched_at` 淘汰超量行。上限分别由 `WEB_CACHE_MAX_ROWS`（默认 5000）与 `PYSERVER_CACHE_MAX_ROWS`（默认 20000）控制。pyserver 的 SQLite 使用 WAL + busy_timeout，并发读写不会再出现 `database is locked`；日志级别由 `PYSERVER_LOG_LEVEL`（默认 `INFO`）控制，上游异常详情只进服务端日志，不再随 502 回传。

清理 macOS 本地行情缓存：

```bash
./scripts/macos/clear-market-cache.sh
```

## 静态快照

### 花费档位

LLM 调用按场景分三档，避免日常公开刷新误跑全年回测（数百批 LLM）。完整变量见上文「LLM 调优变量」。

| 档位 | 何时 | 动作 | 相对成本 |
|---|---|---|---|
| **日常** | 更新公开页或 VPS 一键 | 刷池 → analyst → signals → **跳过回测** → `meta.json` → 部署；公开页保留既有 `backtest.json` 并在 meta/UI 标注「回测沿用至 …」 | 低 |
| **研究日** | 私有台日常选股 | 首页看盘 → 按需「DeepSeek 刷新股票池」→ `/signals`（持仓感知）；**不**默认跑全年回测 | 低 |
| **策略体检** | 策略或股票池有实质变更后 | 私有 `/backtest` UI，或 CLI 带 `SNAPSHOT_INCLUDE_BACKTEST=1` 写回公开回测 | 高（有意为之） |

研究日与公开「日常」一键是两条线：私有台 `:3000` 以 `/signals` 为主；公开站用 VPS 一键刷新 `docs/data`。公开 snapshot 信号**无持仓**；私有 `/signals` **有持仓**。详见 [RESEARCH_WORKFLOW.md](RESEARCH_WORKFLOW.md)。

**默认一键**（刷池 + analyst/signals，跳过回测，公开页沿用旧回测）：

```bash
cd ~/github/ai-infra-dashboard
./scripts/vps-refresh-public-snapshot.sh
```

**策略体检并更新公开回测**（全链路含回测，成功才覆盖 `docs/data/backtest.json`）：

```bash
SNAPSHOT_INCLUDE_BACKTEST=1 ./scripts/vps-refresh-public-snapshot.sh
```

**跳过刷池**（仅重跑 analyst/signals 与部署，股票池不变）：

```bash
SNAPSHOT_SKIP_UNIVERSE_REFRESH=1 ./scripts/vps-refresh-public-snapshot.sh
```

私有研究台体检入口：<http://localhost:3000/backtest>（或 VPS SSH 隧道后的私有 URL）。该页**不会**自动部署 Vercel；若公开页也需新回测，再用上一条 `SNAPSHOT_INCLUDE_BACKTEST=1` 命令。

### 狗云 VPS 一键（推荐）

在 VPS 仓库根目录执行（compose 健康 + 宿主机刷池/`snapshot.ts` + Vercel 部署）。**默认即日常档**：刷池 + analyst/signals，跳过回测。

```bash
cd ~/github/ai-infra-dashboard
./scripts/vps-refresh-public-snapshot.sh
```

说明：

- **必须在宿主机跑 snapshot**，不要用生产 `web` 镜像（镜像里没有 `lib/`，会报 `Cannot find module '/app/lib/universe'`）。
- 脚本会从根目录 `.env` 生成 `web/.env.local`，并强制 `PYSERVER_URL=http://127.0.0.1:8001`。
- 部署读取 `~/scripts/.vercel-token`（或环境变量 `VERCEL_TOKEN`）。单独跑 `./scripts/deploy-public-snapshot.sh` 时也要先 `export VERCEL_TOKEN=…`，否则会报未登录并**不会**部署。
- **`web/data` 权限**：一键会在宿主机写 `universe.json`。若目录仅 `1001:1001` 且 mode `755`，宿主机用户会 `EACCES`（`.tmp` 写失败）。推荐宿主机用户加入 `deploy`（gid 1001）组，并：
  ```bash
  sudo chown -R "$USER":deploy web/data
  sudo chmod 2775 web/data
  sudo chmod g+w web/data/*
  ```
  这样 Compose（uid 1001）与宿主机脚本都能写。勿长期只用 `chown 1001:1001` 却从宿主机跑 `refresh-universe`。
- **公开快照只认 VPS CLI**：`docs/data/*.json` 已 gitignore，不进仓库；GitHub Actions **不会**再部署公开数据。合并 `docs/*.md` 不会盖掉 Vercel。见 [specs/2026-08-06-public-snapshot-source-of-truth.md](specs/2026-08-06-public-snapshot-source-of-truth.md)。
- Vercel 项目须关闭 **Git 自动生产部署**（仅 CLI / 本一键脚本）。当前项目已设 Ignored Build Step = `exit 0`（Git 推送跳过构建；`vercel deploy` CLI 不受影响）。
- 更轻（跳过 LLM 信号与回测）：`SNAPSHOT_SKIP_SIGNALS=1 SNAPSHOT_SKIP_BACKTEST=1 ./scripts/vps-refresh-public-snapshot.sh`
- 只生成不部署：`SKIP_DEPLOY=1 ./scripts/vps-refresh-public-snapshot.sh`
- 仅重新部署已有 `docs/data`：`export VERCEL_TOKEN=… && ./scripts/deploy-public-snapshot.sh`（若明显旧于 `web/data/universe.json` 会拒绝，除非 `FORCE_STALE_SNAPSHOT_DEPLOY=1`）

### 本机手动

完整刷新需要本机 pyserver 正常运行，并在 `web/.env.local` 配置 LLM key：

```bash
./start.sh   # 另开终端，确保 :8001 可用
cd web && npx tsx scripts/snapshot.ts
cd .. && ./scripts/deploy-public-snapshot.sh   # 必须在仓库根目录
```

常用覆盖项（档位说明见上文「花费档位」）：

```bash
# 日常：跳过回测（默认 VPS 一键行为）
SNAPSHOT_SKIP_BACKTEST=1 npx tsx scripts/snapshot.ts

# 策略体检：含回测
unset SNAPSHOT_SKIP_BACKTEST
npx tsx scripts/snapshot.ts

# 更轻：跳过信号与回测
SNAPSHOT_SKIP_SIGNALS=1 SNAPSHOT_SKIP_BACKTEST=1 npx tsx scripts/snapshot.ts

# 自定义回测区间
SNAPSHOT_BACKTEST_START=2024-01-01 SNAPSHOT_BACKTEST_END=2026-05-14 npx tsx scripts/snapshot.ts
```

本地预览：

```bash
python3 -m http.server 8765 --directory docs
```

## 常见问题

| 现象 | 检查 |
|---|---|
| `/api/signals` HTTP 500 且出现 `ERR_DLOPEN_FAILED` | `nvm use && ./scripts/rebuild-native-modules.sh`，再重启 Web。 |
| 首页无行情 | `curl http://127.0.0.1:8001/health`，确认 `PYSERVER_URL=http://localhost:8001`。 |
| 信号超时 | 减小 `SIGNALS_LLM_SCORE_BATCH_SIZE`，增大 `SIGNALS_LLM_TIMEOUT_MS`，查看 Web 日志。 |
| 信号返回 LLM `503` / 超时 | 传输层会自动重试；仍失败时减小 `SIGNALS_LLM_SCORE_BATCH_SIZE`，确认 `LLM_PROVIDER=deepseek` 与 `DEEPSEEK_API_KEY`，或临时改用 `opencode-go`。 |
| 回测超时 | 缩短日期区间，降低 `BACKTEST_SIGNAL_CONCURRENCY` 或减小 `BACKTEST_LLM_SCORE_BATCH_SIZE`。 |
| `EACCES` 写 `web/data/universe.json.tmp` | 宿主机无写权限；按上文「狗云 VPS 一键」权限段设置 `chown`/`chmod 2775`。 |
| 私有台 `:3000` HTTP 500 / `EACCES` 读 `universe.json` | 宿主机刷池后文件常成 `0600`，Compose（uid 1001）读不了；`chmod 664 web/data/universe.json` 后 `docker compose restart web`。一键脚本在刷池后会尝试 `chmod 664`。 |
| 公开页「信号输入警告」很多条 | 主路径 `latest_close` 以 `field_sources=akshare_stock_value_em` 审计，**不再**逐票写入 warnings。公开页对重复文案折叠为「N 只：…」。真降级（实时不可用→日线等）仍报警告。旧 snapshot 若仍含大量同文案，靠 UI 折叠消噪；重新一键刷新后源头即干净。 |
| 改 pyserver 警告语义后仍见旧「非实时」警告 | 基本面缓存在 pyserver SQLite 的 `live:fund:*`（不是裸 `fund:`）。在 VPS 清掉对应 key 或整库相关条目后，再跑一键快照；勿只重启容器指望过期。 |
| DeepSeek `402 Insufficient Balance` | 充值后再跑；日常一键已跳过回测，余额主要耗在刷池 + 信号（或误开 `SNAPSHOT_INCLUDE_BACKTEST=1`）。 |
| 公开页数据突然变旧 | 确认 Vercel 未开启 Git 自动生产部署；用 VPS 一键或 `./scripts/deploy-public-snapshot.sh` 从宿主机 `docs/data` 部署。`docs/data/*.json` 不应再出现在 git 提交里。 |
| Tushare 权限错误 | 默认关闭 Tushare 次级源；确需启用时参考 [TUSHARE-PERMISSIONS.md](TUSHARE-PERMISSIONS.md)。 |
| 同一工作区构建异常 | 避免同时运行 `npm run dev` 和 `npm run build`。 |

## 验证命令

```bash
cd web && npm test
cd web && ./node_modules/.bin/tsc --noEmit
cd web && npm run build
cd pyserver && uv run python -m py_compile main.py
```

## 本机 / VPS / GitHub 如何对齐

公开模板是 [topkyo/ai-infra-research-template](https://github.com/topkyo/ai-infra-research-template)。维护者可以另有不公开的操作台仓；不要把实盘数据推进公开模板。

| 位置 | 跟 git 什么 | 运行时数据（不进 git） |
|---|---|---|
| 本机 | `origin` = 你的操作仓；改代码、跑测试 | 可选本地 `universe.json` / `.env.local`，与 VPS **不同步** |
| VPS | 同一操作仓 | 生产观察名单、`private/holdings.local.json`、`.env`、Compose volume |
| 公开模板仓 | 确认无私有数据后再 push | 只有 `universe.example.json` / `thesis.example.md` |

日常升级 VPS 代码：

```bash
cd ~/github/ai-infra-research-template   # 或你的操作仓路径
git pull --ff-only
docker compose up -d --build
# 20G 盘在 rebuild 后建议清构建缓存，避免再次告警：
docker builder prune -af
```

不要在 VPS 上改业务代码。`web/data/universe.json` 与持仓是宿主机文件，pull/rebuild 不应覆盖它们（已被 gitignore）；若做 `reset --hard` 或换 clone，须先备份再拷回。

看盘：本机 SSH 隧道到 VPS `:3000`（例如 `ssh -L 3000:127.0.0.1:3000 your-vps`）。本机没有 `node_modules` 也不影响看 VPS。

## 生产部署

线上可选 **组合 A**（VPS 私有研究台 + 静态快照托管）。上机勾选清单见 [COMBO_A_RUNBOOK.md](COMBO_A_RUNBOOK.md)；完整步骤见 [DEPLOY.md](DEPLOY.md)。模板不提供官方公开站；需要公开展示时自行配置 `NEXT_PUBLIC_PUBLIC_SNAPSHOT_URL` 与托管。
