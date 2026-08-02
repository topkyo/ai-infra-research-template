# Spec: 组合 A — 狗云 VPS 私有台 + Vercel 公开快照

**Status:** approved (chat 2026-08-01)  
**Product:** topkyo AI 基建研究台

## Intent

在已有狗云 VPS 前提下，采用双平面架构：

- **私有平面（VPS）**：Next.js + pyserver，HTTPS + 鉴权，持仓/缓存持久化；承载信号、回测、股票池刷新。
- **公开平面（Vercel）**：仅托管现有 `docs/` 静态快照；无 API key、无持仓、无 pyserver。

不把完整 Next 应用部署到 Vercel；不公开暴露 pyserver。

## Non-goals

- 不迁移到 Responses API / 不改 LLM 协议
- 不做多租户、K8s、实时公开信号
- 不在本仓库任务内完成真实 SSH 上机或绑定用户域名证书（提供可复制配置与清单；凭据由操作者在 VPS/Vercel 控制台完成）

## Requirements

1. Compose 默认将 web/pyserver 端口绑到 `127.0.0.1`，便于 Caddy 反代。
2. 持久化：`holdings.local.json` 与 `web/.cache` 经 `private/` bind mount。
3. 提供 Caddy 示例：仅反代 Web；可选 Basic Auth。
4. 提供 Vercel 静态配置（`docs/` 为 Root Directory）与部署说明/脚本。
5. 文档明确组合 A 为推荐生产形态；GitHub Pages 可保留为备选。

## Success criteria

- 仓库内配置与文档自洽；`docker compose config` 通过。
- 操作者按 runbook 可在 VPS 拉起私有台，并在 Vercel 发布公开快照（需自备 token/域名）。
- 监控契约自洽（2026-08-02 补充）：故障域拆分（platform/proxy/ea/tunnel/dashboard）、`ALERT_KEY` 全集、冷却"发送成功后才写戳"、dashboard 磁盘仅 `disk-crit` 兜底，均在 runbook §H 与 `deploy/vps-scripts/` 中文档化且与线上脚本一致。
