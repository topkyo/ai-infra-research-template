# 组合 A 上机清单（VPS 私有 + Vercel 公开）

按顺序勾选。规格说明见 [docs/specs/2026-08-01-vps-vercel-combo-a.md](specs/2026-08-01-vps-vercel-combo-a.md)；逐步说明见 [DEPLOY.md](DEPLOY.md)。

## 架构速览

```text
# 模式 B（无域名，推荐狗云当前态）：本机 Compose + SSH 隧道
Laptop ──ssh -L 3000:127.0.0.1:3000──► VPS 127.0.0.1:3000 (web)
                                       VPS 127.0.0.1:8001 (pyserver, 不对外)

# 模式 A（有域名时）：Caddy HTTPS + 强制 Basic Auth
Internet ──HTTPS──► Caddy ──► 127.0.0.1:3000 (web)

Internet ──HTTPS──► Vercel (docs/ 静态快照, Root = docs)
```

**无公网域名时走模式 B：** 跳过本节 DNS / 80·443 防火墙与下方 §E Caddy；访问用：

```bash
ssh -L 3000:127.0.0.1:3000 your-vps
# 浏览器打开 http://127.0.0.1:3000
```

---

## A. VPS 准备

- [ ] **克隆操作仓**到 VPS（例如 `~/github/ai-infra-research-template`）。公开模板只给人 Use this template / 外部 PR；生产 origin 应是你自己的仓。不要把实盘股票池或持仓推进公开模板。
- [ ] **模式 A 才需要 DNS**：私有域名 A/AAAA 指向 VPS（替换 `deploy/Caddyfile.example` 中的 `app.example.com`）。模式 B 跳过。
- [ ] **防火墙**：
  - **模式 B（无域名）：** 不要为研究台开放 `80/443/3000/8001`（保持 SSH `22` 即可；勿把 Compose 端口绑到 `0.0.0.0`）。
  - **模式 A（有 Caddy）：** 仅开放 `80/tcp`、`443/tcp`；**不要**开放 `3000`、`8001`。
  ```bash
  # 仅模式 A：
  sudo ufw allow 80/tcp
  sudo ufw allow 443/tcp
  sudo ufw enable
  ```
- [ ] 安装 **Docker** 与 **Docker Compose**。

## B. 环境变量

- [ ] 复制根目录 `.env`：`cp .env.example .env`
- [ ] 写入 **`DEEPSEEK_API_KEY`**（或 `OPENCODE_GO_API_KEY`）及模型/超时变量（见 [DEPLOY.md](DEPLOY.md) §2）。
- [ ] 按需设置 **`TUSHARE_TOKEN`**（免费真实源可用示例占位值；启用 Tushare 次级源时再填真实 token）。
- [ ] 确认 `.env` **未提交**到 Git。

## C. 私有数据（Compose 启动前）

- [ ] 创建持仓文件（bind mount 必需）：
  ```bash
  cp web/data/holdings.example.json private/holdings.local.json
  ```
- [ ] 编辑 `private/holdings.local.json`（现金、持仓、成本价）；或在私有台 `/signals` 页面保存。
- [ ] 阅读 [private/README.md](../private/README.md)：`web-cache` / `pyserver-cache` 由 Docker named volume 持久化；bind mount 需 **Compose uid 1001 与宿主机脚本都能写**（推荐 `chown "$USER":deploy` + `chmod 2775 web/data`，见 OPERATIONS「VPS 一键」权限段；勿只 `chown 1001:1001` 却从宿主机跑刷池）。
- [ ] （可选）验证非 root：`docker compose run --rm web id` → `uid=1001(app)`。

## D. Docker Compose

- [ ] 确认 `docker-compose.yml` 端口为本机绑定：
  - `127.0.0.1:3000:3000`
  - `127.0.0.1:8001:8001`
- [ ] 启动：`docker compose up -d --build`
- [ ] VPS 本机健康检查：
  ```bash
  curl -sS http://127.0.0.1:8001/health
  curl -sS -o /dev/null -w "%{http_code}\n" http://127.0.0.1:3000/
  ```
- [ ] **`8001` 外网不可达**：从另一台机器 `curl http://<VPS公网IP>:8001/health` 应失败或超时（Compose 已 bind 127.0.0.1）。

## E. Caddy（私有 HTTPS 入口 — 仅模式 A）

模式 B 跳过本节。

- [ ] 安装 Caddy（见 [deploy/README.md](../deploy/README.md)）。
- [ ] `sudo cp deploy/Caddyfile.example /etc/caddy/Caddyfile`，替换域名。
- [ ] **必须**配置 **Basic Auth**：`caddy hash-password`，把输出写入 `basicauth` 的 `REPLACE_WITH_HASH`（示例默认已启用 `basicauth`，占位 hash 不可用）——股票池刷新无应用层令牌，公网入口靠 Caddy。
- [ ] 确认文件中**没有** `REPLACE_WITH_HASH` 后再 `sudo caddy validate --config /etc/caddy/Caddyfile && sudo systemctl reload caddy`。
- [ ] 浏览器访问 `https://<私有域名>`，确认研究台可加载；未认证应被拒绝。
- [ ] 再次确认 Caddy **仅** `reverse_proxy 127.0.0.1:3000`，**不含** `:8001` 反代。

## F. Vercel 公开面

- [ ] 在 [Vercel](https://vercel.com) 新建项目（可关联本仓库仅作项目壳，**数据不走 git**）。
- [ ] **Root Directory** = `docs`
- [ ] **Framework Preset** = Other（无 build command）
- [ ] **关闭 Git 自动生产部署**（Project → Settings → Git → 关闭 Production Auto-deploy，或 Ignored Build Step 恒跳过）。公开面只认 VPS CLI。
- [ ] 在 VPS 配置 `~/scripts/.vercel-token`（或 `VERCEL_TOKEN`），安装 `vercel` CLI。
- [ ] 本地或 VPS 生成**首次快照**并部署（需 pyserver + LLM key；见 [docs/README.md](README.md)）：
  ```bash
  cd ~/github/ai-infra-dashboard && ./scripts/vps-refresh-public-snapshot.sh
  # 或：生成后单独 deploy
  # export VERCEL_TOKEN=… && ./scripts/deploy-public-snapshot.sh
  ```
- [ ] 打开 Vercel 生产 URL，确认静态页展示股票池/信号/回测 JSON；跳过回测时 meta/UI 应出现「回测沿用至 …」。
- [ ] **Token 轮换**：Vercel → Tokens 新建后写入 `~/scripts/.vercel-token`，再跑一键或 `deploy-public-snapshot.sh`。不要用 GitHub Actions 部署快照（workflow 会直接失败并提示 CLI）。


## G. 最终验收

- [ ] **模式 B：** SSH 隧道后本机可打开 `http://127.0.0.1:3000`；公网 IP 的 `:3000`/`:8001` 不可达。
- [ ] **模式 A：** 私有 HTTPS 正常，且 **Basic Auth 已生效**（未认证被拒绝）。
- [ ] 公开 URL（可选）：Vercel/Pages 静态快照为最近一次 `snapshot.ts` 输出。
- [ ] **安全**：外网无法访问 `:8001`；API key 与 `private/holdings.local.json` 未进入公开仓库或 `docs/data/`。
- [ ] **日常**更新公开快照（VPS 一键，**默认无回测**；刷池 + analyst/signals，公开页沿用旧 `backtest.json`）：
  ```bash
  cd ~/github/ai-infra-dashboard && ./scripts/vps-refresh-public-snapshot.sh
  ```
  档位说明见 [OPERATIONS.md](OPERATIONS.md)「静态快照 → 花费档位」。
- [ ] **策略体检**（股票池或策略有实质变更后；私有 UI 或写回公开回测）：
  - 私有研究台：<http://127.0.0.1:3000/backtest>（SSH 隧道后本机访问），**不**自动部署 Vercel。
  - 公开页也需新回测时：
    ```bash
    cd ~/github/ai-infra-dashboard && SNAPSHOT_INCLUDE_BACKTEST=1 ./scripts/vps-refresh-public-snapshot.sh
    ```
  - 仅重跑信号、跳过刷池：`SNAPSHOT_SKIP_UNIVERSE_REFRESH=1 ./scripts/vps-refresh-public-snapshot.sh`
- [ ] 持仓文件权限建议：`chmod 600 private/holdings.local.json`。

## H. 磁盘与监控

狗云监控按故障域拆分（与 EA 共用告警通道 Telegram/Slack）：

| Cron | 脚本 | 频率 | 职责 |
|---|---|---|---|
| platform | `~/scripts/platform-watch.sh` | */5 | 磁盘 / 内存 |
| proxy | `~/scripts/proxy-watch.sh` | */5 | sing-box |
| ea | `~/scripts/ea-watch.sh` | */5 | EA API / Caddy / simulators / mosquitto / cloudflared unit |
| tunnel | `~/scripts/tunnel-watch.sh` | */5 | Tunnel URL 同步 + 外网 `/health` |
| dashboard | [`scripts/vps-healthcheck.sh`](../scripts/vps-healthcheck.sh) | 每小时（如 `7 * * * *`，按主机时区） | 研究台 Compose + 3000/8001 + 磁盘紧急兜底 |

- 告警：`~/scripts/alert.sh`（`ALERT_TAG` + `ALERT_KEY`；冷却戳**按通道**写入 `${key}.telegram` / `${key}.slack`，仅该通道发送成功后才 stamp；一路成功不会压住另一路重试；dashboard 侧 `COOLDOWN_SEC` 默认 3600 秒）。无通道或发送失败会写入 `~/scripts/health-alerts.log`（并 stderr）；healthcheck 会把 alert.sh 的输出一并捕获进 `.monitor/logs/vps-health-*.log`。脚本已 vendor 到 [`deploy/vps-scripts/`](../deploy/vps-scripts/)（含 flock；密钥仅存 VPS 点文件），线上副本在 `~/scripts/`，改动以仓库为准两边同步。
- **Dead-man's-switch（Healthchecks.io）**：`vps-healthcheck` 结束时 ping 外部看门狗——`fail=0` 打成功 URL，`fail≠0` 打 `{url}/fail`；cron 整段失踪则 HC 侧超时告警（TG/Slack 全挂时仍可感知）。配置：
  1. 在 [healthchecks.io](https://healthchecks.io) 建 Check：Period **1 hour**，Grace **1 hour**（对齐 `7 * * * *`）。
  2. 通知渠道用**独立邮箱**或另一 TG bot（尽量不与现网 webhook 完全同钥）。
  3. VPS：`umask 077; printf '%s\n' 'https://hc-ping.com/<uuid>' > ~/scripts/.healthchecks-ping`（权限 600）。也可用环境变量 `HEALTHCHECKS_PING_URL`。
  4. 未配置文件时脚本 no-op，不影响本机告警。
- 监控边界：本表脚本只覆盖基础设施可观测性；告警沉默不代表业务接口（LLM 信号/回测/股票池）成功，业务失败语义由应用内 strict 规则保证。
- dashboard 的 `ALERT_KEY`：`dashboard-compose` / `dashboard-docker` / `dashboard-http` / `disk-crit`。
- `alert.sh` 缺失或不可执行时，healthcheck 会把 WARN 经 fd 3 写到 cron stderr 并记日志，但**无法告警**；上机与巡检前置自检：`sudo -u <cron用户> test -x ~/scripts/alert.sh && echo alert-ok`。
- 磁盘常规 paging **仅** `platform-watch`（`ALERT_KEY=disk`，阈值 `DISK_WARN_PCT` 默认 85），它是磁盘告警的强制依赖；healthcheck 低于 `DISK_CRIT_PCT`（默认 95）只记日志，达到阈值才兜底告警（`ALERT_KEY=disk-crit`，键不同，不与 platform-watch 双推）。
- Compose 已带 `restart: unless-stopped` 与容器日志限额（json-file 10m×3），VPS 重启后服务自动拉起，容器 stdout 不会无限撑盘。
- `health-watch.sh` 为兼容包装（`exec ea-watch.sh`），**勿再加入 cron**。
- 日志轮转：`/etc/logrotate.d/ea-vps-scripts`（daily / 14 份 / `maxsize 20M`）。
- 研究台日志：`.monitor/logs/vps-health-YYYY-MM-DD.log`。
- **Docker 磁盘回收（强制习惯）:** 20G 根盘上 compose 重建易把使用率顶到 `DISK_WARN_PCT`（默认 85%）。
  1. 仓库脚本：[`deploy/vps-scripts/docker-disk-prune.sh`](../deploy/vps-scripts/docker-disk-prune.sh) → 同步到 VPS `~/scripts/docker-disk-prune.sh`（`chmod +x`）。
  2. **每次** `docker compose up -d --build` 成功后手动跑一次（或见 [DEPLOY.md](DEPLOY.md)）。
  3. cron 每周兜底：见 [`deploy/vps-scripts/crontab.example`](../deploy/vps-scripts/crontab.example)（`15 4 * * 0`）。
  4. 只清 build cache + **未被运行中容器引用**的镜像；**禁止** `docker system prune --volumes`（会伤 named volume）。

## 相关文档

| 文档 | 用途 |
|---|---|
| [DEPLOY.md](DEPLOY.md) | 组合 A 完整部署说明 |
| [deploy/README.md](../deploy/README.md) | Caddy 安装与防火墙 |
| [private/README.md](../private/README.md) | 私有目录与 holdings mount |
| [docs/README.md](README.md) | 公开快照刷新与 Vercel 设置 |
| [OPERATIONS.md](OPERATIONS.md) | 本地运行、LLM 调优、排障 |
