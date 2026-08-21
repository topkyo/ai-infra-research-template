# 安全说明

本仓库是个人 A 股主题研究台模板，默认在本机 loopback 运行。以下约束适用于 fork 后的自托管部署。

## 无应用层鉴权的 API

以下路由**没有**登录、API key 或刷新令牌等应用层鉴权。若 Web 端口被暴露到非受信网络，调用方可直接读写敏感数据或触发 LLM 消耗：

| 路由 | 风险 |
|---|---|
| `/api/holdings` | 读写本地持仓 JSON |
| `/api/signals` | 触发 LLM 生成目标仓位 |
| `/api/backtest` | 触发 LLM 回测 |
| `/api/universe/refresh` | 触发 LLM 改写股票池文件 |

## 默认网络边界

- **Docker Compose**：`docker-compose.yml` 的 `ports` 必须保持 `127.0.0.1:3000` 与 `127.0.0.1:8001`。容器内进程可监听 `0.0.0.0`；对外发布端口只能由 compose 的 `127.0.0.1:` 前缀约束。
- **本机开发**：`npm run dev` 与 uvicorn 默认绑定 `127.0.0.1`。
- **组合 A 模式 A（有域名）**：Caddy 反代私有 HTTPS 入口时**必须**启用 Basic Auth。股票池刷新无应用层令牌，公网入口靠 Caddy 认证；不要把 pyserver `:8001` 反代或开放到公网。

## 漏洞报告

- **公开模板仓** [topkyo/ai-infra-research-template](https://github.com/topkyo/ai-infra-research-template)：请通过该仓 GitHub Settings 的 **Private vulnerability reporting** 提交。请勿通过 Issues 或 Pull Request 提交可利用细节。
- **维护者私有操作台**（若存在且仍为 private）：**不接受匿名外部报告**。

本文件不另设私人联系邮箱。

## 密钥与私有数据

- 不要提交 `.env`、`.env.local`、API key、`web/data/holdings.local.json`、`web/data/universe.json`（操作者实文件）或 `docs/data/*.json`（公开快照）。
- LLM key 只放在 `web/.env.local` 或部署环境变量；Tushare token 只放在 `pyserver/.env` 或部署环境变量。
