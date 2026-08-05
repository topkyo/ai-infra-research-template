# 完整应用部署

完整交互应用包括 Next.js Web、Python pyserver、LLM key 和市场数据缓存。部署后可使用实时行情、在线信号、回测和股票池刷新。

## 推荐生产形态：组合 A（VPS 私有 + Vercel 公开）

**组合 A** 是本仓库推荐的线上部署方式：

| 平面 | 托管 | 内容 |
|---|---|---|
| **私有研究台** | VPS（Docker Compose + Caddy） | 实时行情、LLM 信号、回测、股票池刷新；含 API key 与真实持仓 |
| **公开快照** | [Vercel](https://vercel.com) 静态托管 `docs/` | 最近一次研究快照（股票池、信号、回测 JSON），无 API key |

私有面只通过 HTTPS（可选 Basic Auth）暴露 Next.js；pyserver 绑定 `127.0.0.1:8001`，不对外发布。公开面与私有面解耦，由 `web/scripts/snapshot.ts` 生成 `docs/data/` 后部署。

**操作清单：** [COMBO_A_RUNBOOK.md](COMBO_A_RUNBOOK.md)（DNS、防火墙、首次上机逐步勾选）。

### 部署顺序

1. **Docker Compose** — 本机绑定端口、启动 web + pyserver（见下文 §1–§3）。
2. **私有数据** — 创建 `private/holdings.local.json` 与持久化 volume（见 [private/README.md](../private/README.md)）。
3. **Caddy** — TLS 终止、反代 `127.0.0.1:3000`（见 [deploy/README.md](../deploy/README.md)）。
4. **Vercel 公开面**（可与步骤 1–3 并行） — Root Directory = `docs`；首次 snapshot 与部署（见 [docs/README.md](README.md)、[scripts/deploy-public-snapshot.sh](../scripts/deploy-public-snapshot.sh)）。

公开展示快照不需要部署完整应用；若只需静态页，可跳过 VPS，仅配置 Vercel + snapshot 流程。

---

## 前置条件

- Linux VPS / 云主机，建议 2 vCPU / 2 GB RAM 以上。
- Docker 和 Docker Compose。
- 域名（私有台 HTTPS；公开面可用 Vercel 默认域名或自定义域）。
- LLM API key：`OPENCODE_GO_API_KEY` 或 `DEEPSEEK_API_KEY`。
- 市场数据默认可走免费源；Tushare 仅在需要次级补缺时启用。

## 1. 克隆仓库

```bash
git clone https://github.com/topkyo/ai-infra-dashboard.git
cd ai-infra-dashboard
```

## 2. 配置 `.env`

从根目录示例复制：

```bash
cp .env.example .env
```

最小生产配置：

```bash
LLM_PROVIDER=deepseek
DEEPSEEK_API_KEY=sk-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
DEEPSEEK_BASE_URL=https://api.deepseek.com
LLM_MODEL=deepseek-v4-flash
LLM_MODEL_BACKTEST=deepseek-v4-flash

# Docker Compose 镜像内 TUSHARE_TOKEN 默认为空（免费实时源 akshare+baostock）。
# 使用占位值保持相同效果；设为真实 token 则启用 Tushare 次级源。
TUSHARE_TOKEN=your-tushare-pro-token-here

SIGNALS_LLM_TIMEOUT_MS=900000
SIGNALS_LLM_SCORE_BATCH_SIZE=10
BACKTEST_SIGNAL_CONCURRENCY=8
BACKTEST_LLM_SCORE_BATCH_SIZE=10
BACKTEST_LLM_TIMEOUT_MS=300000
UNIVERSE_REFRESH_LLM_TIMEOUT_MS=900000
UNIVERSE_REFRESH_ENABLED=1
```

当前 `docker-compose.yml` 只把 `TUSHARE_TOKEN` 和 `PYSERVER_CACHE_DB` 传给 pyserver。若要在 Docker 中启用 Tushare 次级源，先在 `docker-compose.yml` 的 `pyserver.environment` 增加 `MARKET_ENABLE_TUSHARE_SECONDARY` 和 `STRICT_LIVE_DATA`，再配置：

```bash
TUSHARE_TOKEN=your-real-tushare-token
MARKET_ENABLE_TUSHARE_SECONDARY=1
STRICT_LIVE_DATA=1
```

Tushare 接口权限见 [TUSHARE-PERMISSIONS.md](TUSHARE-PERMISSIONS.md)。

## 3. 私有数据与启动 Compose

仓库根目录 `docker-compose.yml` 已将 web / pyserver 绑定到本机：

- `127.0.0.1:3000` — Next.js
- `127.0.0.1:8001` — pyserver（仅容器内与宿主机 loopback 访问）

web 服务挂载：

- `./web/data` → 容器内 `/app/data`（目录挂载，支持 `universe.json` 原子 tmp+rename）
- `./private` → 容器内 `/app/private`（`HOLDINGS_FILE=/app/private/holdings.local.json`，支持持仓原子写）
- named volume `web-cache` → 容器内 `/app/.cache`（LLM 与回测 SQLite 缓存）

pyserver 服务挂载：

- named volume `pyserver-cache` → 容器内 `/app/cache-data`（行情 SQLite 缓存，`PYSERVER_CACHE_DB`）

### 容器用户与挂载权限（uid 1001）

两个镜像均以非 root 用户 `app`（**uid/gid 1001**）运行。可写路径在 Dockerfile 中 `chown` 给该用户；bind mount 与已有 named volume 的宿主机权限需单独对齐。

| 挂载 | 类型 | 容器路径 | 权限说明 |
|---|---|---|---|
| `./web/data` | bind | `/app/data` | 股票池刷新需写 `universe.json`；宿主机目录须对 uid **1001** 可写 |
| `./private` | bind | `/app/private` | 持仓 JSON 原子写；首次部署前创建目录与文件（见下） |
| `web-cache` | named volume | `/app/.cache` | LLM/回测 SQLite；**首次** `compose up` 时 Docker 从镜像 `/app/.cache`（已 chown 1001）初始化卷 |
| `pyserver-cache` | named volume | `/app/cache-data` | pyserver SQLite；同上，从镜像 `/app/cache-data` 初始化 |

**Bind mount 首次对齐（VPS 或本机 Compose）：**

```bash
# 仓库根目录；将 bind mount 目录属主改为容器 uid
sudo chown -R 1001:1001 web/data private
```

若暂不能改属主，开发环境可放宽目录权限（生产不推荐）：`chmod -R a+rwX web/data private`。

**Named volume 已存在且属 root 时**（升级自 root 容器后的旧卷）：

```bash
docker compose run --rm --user root pyserver chown -R app:app /app/cache-data
docker compose run --rm --user root web chown -R app:app /app/.cache
```

**验证非 root 与构建：**

```bash
docker compose build
docker compose run --rm pyserver id   # 期望 uid=1001(app)
docker compose run --rm web id        # 期望 uid=1001(app)
docker compose up -d
curl -sS http://127.0.0.1:8001/health
curl -sS -o /dev/null -w "%{http_code}\n" http://127.0.0.1:3000/
```

**首次启动前**必须从示例复制持仓文件，否则真实持仓信号不可用（`/api/signals` 返回 `setup_required`）：

```bash
cp web/data/holdings.example.json private/holdings.local.json
# 编辑 private/holdings.local.json，填入真实现金与持仓
```

详见 [private/README.md](../private/README.md)。

股票池 UI 刷新默认启用（`UNIVERSE_REFRESH_ENABLED=1`）；演示/只读可设 `0`。访问靠 SSH 隧道或 Caddy Basic Auth，无应用层刷新令牌。

启动：

```bash
docker compose up -d --build
# 小根盘（如狗云 20G）：回收 build cache / 旧镜像，避免 disk≥85% 告警
# （需已同步 deploy/vps-scripts/docker-disk-prune.sh → ~/scripts/）
~/scripts/docker-disk-prune.sh || {
  docker builder prune -af
  docker image prune -af
}
```

本机验证（在 VPS 上执行）：

```bash
curl -sS http://127.0.0.1:8001/health
curl -sS -o /dev/null -w "%{http_code}" http://127.0.0.1:3000/
df -h /
```

**不要**从公网直接访问 `:3000` 或 `:8001`；对外入口由 Caddy 提供。

常用命令：

```bash
docker compose ps
docker compose logs -f web pyserver
docker compose down
```

## 4. Caddy 反向代理（私有 HTTPS 入口）

生产环境通过 Caddy 终止 TLS，反代 `127.0.0.1:3000`。pyserver 不反代、不对外暴露。

1. 复制 [deploy/Caddyfile.example](../deploy/Caddyfile.example) 到 VPS（例如 `/etc/caddy/Caddyfile`）。
2. 将 `app.example.com` 替换为真实域名，DNS A/AAAA 指向 VPS。
3. **必须**（Mode A）：用 `caddy hash-password` 替换 `basicauth` 中的 `REPLACE_WITH_HASH`（示例默认已启用 Basic Auth；占位不可用）。
4. 防火墙仅开放 80/443（见 [deploy/README.md](../deploy/README.md)）。

API key 只放在容器环境变量中，不会写入前端 bundle。

## 5. Vercel 公开快照

公开面托管静态 `docs/`，与 VPS 私有台独立：

| 资产 | 说明 |
|---|---|
| [docs/vercel.json](vercel.json) | Vercel 静态站点配置（`cleanUrls` 等） |
| [docs/README.md](README.md) | 快照内容与刷新说明 |
| [scripts/deploy-public-snapshot.sh](../scripts/deploy-public-snapshot.sh) | CLI 部署 helper（需 `vercel` + `VERCEL_TOKEN` 或已 login） |
| [.github/workflows/deploy-public-vercel.yml](../.github/workflows/deploy-public-vercel.yml) | 可选 CI：`docs/**` 变更或 `workflow_dispatch` 时部署 |

Vercel 项目设置：

- **Root Directory** = `docs`
- **Framework Preset** = Other（无构建步骤）

生成并发布首次快照：

```bash
cd web
npx tsx scripts/snapshot.ts
cd ..
git add docs/data/
git commit -m "chore: refresh public snapshot"
# 推送后 Vercel Git 集成自动部署，或：
./scripts/deploy-public-snapshot.sh
```

静态页不会实时请求行情或 LLM；GitHub Pages 仍为备选，见 [docs/README.md](README.md)。

## 6. 排障

| 现象 | 检查 |
|---|---|
| 首页无行情 | `docker compose ps`；`curl http://127.0.0.1:8001/health`；确认 Web 的 `PYSERVER_URL` 指向 `http://pyserver:8001`。 |
| pyserver 返回 mock 数据 | 检查根 `.env` 的 `TUSHARE_TOKEN` 是否被设为 `mock`；默认为空或占位值即使用免费实时源（akshare+baostock），`/health` 返回 `mock:false` 可确认。 |
| 信号不可用 / 超时 | 检查 LLM key、`LLM_MODEL`、`SIGNALS_LLM_SCORE_BATCH_SIZE`、`SIGNALS_LLM_TIMEOUT_MS` 和 `docker compose logs web`。 |
| 回测失败 / 超时 | 缩短日期范围；检查 `LLM_MODEL_BACKTEST`、`BACKTEST_LLM_TIMEOUT_MS`、`BACKTEST_LLM_SCORE_BATCH_SIZE`、`BACKTEST_SIGNAL_CONCURRENCY`。 |
| 股票池刷新超时 | 增大 `UNIVERSE_REFRESH_LLM_TIMEOUT_MS`，确认模型支持长上下文和长时间 JSON 输出。 |
| Tushare 权限错误 | 关闭 `MARKET_ENABLE_TUSHARE_SECONDARY` 或确认 token 权限、积分、频次。 |
| 静态页数据旧 | 重新运行 `web/scripts/snapshot.ts`，提交 `docs/data/` 并触发 Vercel 部署。 |
| 外网可访问 8001 | 检查 `docker-compose.yml` 端口是否为 `127.0.0.1:8001`；确认防火墙与 Caddy 未反代 8001。 |
| Compose 启动失败（web） | 确认 `private/holdings.local.json` 已存在（见 [private/README.md](../private/README.md)）。 |
| 磁盘使用率 ≥85% 告警 | 多为 Docker build cache / 旧镜像（`/var/lib/containerd`）。跑 `~/scripts/docker-disk-prune.sh`；确认 weekly cron（见 Runbook §H）。勿 `prune --volumes`。 |

## 7. 备份

生产 VPS 上 **`web-cache`**（回测存档，换模型后不可复现）与 **`private/holdings.local.json`**（真实持仓）不在 git 中，需定期离线备份。

| 资产 | 位置 | 建议 |
|---|---|---|
| 回测 + LLM SQLite | Docker volume `web-cache` → 容器 `/app/.cache/web.db` | 每周或改模型前； tarball 归档 |
| 真实持仓 | `./private/holdings.local.json` | 每日或改仓后； rsync / 私有 git |

完整命令、恢复流程与「勿提交密钥」清单见 **[BACKUP_RUNBOOK.md](BACKUP_RUNBOOK.md)**。
