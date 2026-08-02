# VPS 监控脚本（狗云 ~/scripts/ 的仓库快照）

2026-08-02 从狗云 VPS `~/scripts/` vendor 入库，让告警契约可审查、可追溯。
**线上运行副本**仍在 VPS `~/scripts/`,与 EA 系统共用;改动需两边同步(以仓库为准,部署到 VPS)。

| 脚本 | cron | 职责 | ALERT_KEY |
|---|---|---|---|
| `alert.sh` | (被调用) | Telegram + Slack 双通道发送,冷却戳**发送成功后**才写 | (由调用方传) |
| `platform-watch.sh` | */5 | 磁盘 / 内存 | `disk`(3600s)/ `mem`(1800s) |
| `proxy-watch.sh` | */5 | sing-box 服务 + 控制面 | `sing-box-unit` / `sing-box-ctrl` |
| `ea-watch.sh` | */5 | EA API / Caddy / simulators / mosquitto / cloudflared unit | `ea-api-http` / `ea-caddy-http` / `unit-*` |
| `tunnel-watch.sh` | */5 | EA Tunnel URL 同步 Vercel + 外网 `/health`(每 30 分钟) | `tunnel-external` |
| `health-watch.sh` | (勿入 cron) | 兼容包装,`exec ea-watch.sh` | — |

dashboard 侧脚本在仓库 `scripts/vps-healthcheck.sh`(每小时),其 `ALERT_KEY`:`dashboard-compose` / `dashboard-docker` / `dashboard-http` / `disk-crit`。

## 密钥

密钥**只存 VPS 点文件,永不入库**:`~/scripts/.telegram-token`、`.telegram-chat-id`、`.slack-webhook`、`.vercel-token`(600 权限)。脚本仅引用文件路径。

## 与线上副本的差异

- `alert.sh` 入库版本新增 **flock 串行化**(`.alert-state/.lock`):*/5 cron 重叠时,同一 key 的冷却 check→send→write 不再竞态双推。flock 缺失时回退旧行为。

## 已知限制(待后续)

- **部分通道掩盖**:任一通道(TG 或 Slack)发送成功即写冷却戳;另一通道的故障在冷却期内不重试,只记 `health-alerts.log`。后续可按通道拆分冷却戳。
- **无 dead-man's-switch**:全通道故障时只有 `health-alerts.log` 留痕,操作者无感知。待选型外部看门狗(如 healthchecks.io)。
- `tunnel-watch.sh` 是 EA 专有部署自动化(改写 EA 仓库 vercel.json 并 push),vendor 仅为监控表完整存档,dashboard 不依赖它。

## 参考 crontab

见 [crontab.example](crontab.example)(与 VPS `crontab -l` 对齐;dashboard 行为每小时,按主机时区)。
