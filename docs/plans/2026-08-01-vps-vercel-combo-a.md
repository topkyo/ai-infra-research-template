# 组合 A（VPS 私有 + Vercel 公开）Implementation Plan

> **For agentic workers:** Load `executing-plans` (2+ tasks). Use fresh implementer subagents. Then `finishing`. Checkboxes track progress.

**Goal:** 落地组合 A 的仓库侧配置与文档，使狗云 VPS 跑私有研究台、Vercel 托管公开 `docs/` 快照。  
**Spec:** [docs/specs/2026-08-01-vps-vercel-combo-a.md](../specs/2026-08-01-vps-vercel-combo-a.md)  
**Architecture:** VPS 上 Docker Compose（web+pyserver）仅监听本机，Caddy 终止 TLS 并鉴权；公开面用现有静态 `docs/`，经 Vercel 静态托管，由 snapshot 产物更新。  
**Tech stack:** Docker Compose, Caddy, Vercel static, 现有 `web/scripts/snapshot.ts`

**Out of repo execution:** SSH 上机、申请域名证书、写入真实 `DEEPSEEK_API_KEY` / `VERCEL_TOKEN` 由操作者按 runbook 完成；本计划只交付可复制资产。

---

## Files touched

| File | Action | Responsibility |
|------|--------|----------------|
| `docker-compose.yml` | modify | 本机绑定端口；web 持久化 volume |
| `private/README.md` | create | 私有数据目录约定 |
| `private/.gitignore` | create | 忽略密钥与持仓，保留 README |
| `deploy/Caddyfile.example` | create | 私有台反代 + 可选 Basic Auth |
| `docs/vercel.json` | create | Vercel 静态站点配置 |
| `docs/README.md` | modify | Vercel 公开部署说明 |
| `scripts/deploy-public-snapshot.sh` | create | 本地/VPS 触发 Vercel 部署公开快照 |
| `.github/workflows/deploy-public-vercel.yml` | create | 可选：docs 变更部署到 Vercel |
| `docs/DEPLOY.md` | modify | 组合 A 为主路径 |
| `docs/COMBO_A_RUNBOOK.md` | create | VPS+Vercel 操作清单 |
| `README.md` | modify | 文档导航指向组合 A |
| `docs/plans/2026-08-01-vps-vercel-combo-a.md` | create | 本计划 |
| `docs/specs/2026-08-01-vps-vercel-combo-a.md` | create | 规格 |

---

## Task 1: Compose 本机绑定 + 私有持久化

**Depends on:** none

**Files:**
- Modify: `docker-compose.yml`
- Create: `private/README.md`, `private/.gitignore`
- Modify: `.gitignore`（若需指向 `private/`）

- [x] **Step 1:** 将 `web` / `pyserver` 的 `ports` 改为 `127.0.0.1:3000:3000` 与 `127.0.0.1:8001:8001`。
- [x] **Step 2:** 为 `web` 增加 volumes：
  - `./private/holdings.local.json:/app/data/holdings.local.json`
  - `web-cache:/app/.cache`（named volume）或 `./private/web-cache:/app/.cache`
  - 在 `private/README.md` 说明首次需从 `web/data/holdings.example.json` 复制 holdings 文件，否则 file mount 可能失败。
- [x] **Step 3:** `private/.gitignore` 忽略 `*` 但 `!README.md` 与 `!.gitignore`。
- [x] **Verify:** `docker compose -f docker-compose.yml config -q` 退出码 0；`test -f private/README.md`（本机无 Docker 时 config 跳过，YAML 已人工核对）

**Commit:** `feat: bind compose to localhost and persist private web data`

---

## Task 2: Caddy 私有台示例

**Depends on:** none

**Files:**
- Create: `deploy/Caddyfile.example`
- Create: `deploy/README.md`（短说明：如何把 example 拷到 VPS、设置 `BASIC_AUTH`）

- [x] **Step 1:** Caddyfile 示例：反代 `127.0.0.1:3000`；占位域名 `app.example.com`；注释掉的 `basicauth` 块；**不要**反代 8001。
- [x] **Step 2:** `deploy/README.md` 写明：安装 Caddy、复制文件、重载；防火墙只开 80/443。
- [x] **Verify:** `test -f deploy/Caddyfile.example && test -f deploy/README.md`；Caddyfile 含 `reverse_proxy 127.0.0.1:3000` 且不含 `:8001` 反代。

**Commit:** `docs: add Caddy example for private VPS app`

---

## Task 3: Vercel 静态公开面配置

**Depends on:** none

**Files:**
- Create: `docs/vercel.json`
- Modify: `docs/README.md`

- [x] **Step 1:** `docs/vercel.json` 使用静态友好设置（例如 `cleanUrls`）；勿配置 Next.js build。
- [x] **Step 2:** 更新 `docs/README.md`：说明推荐用 Vercel，Root Directory = `docs`；Framework Preset = Other；保留 GitHub Pages 为备选；更新链路仍是 `snapshot.ts` → 提交/部署 `docs/data`。
- [x] **Verify:** `python3 -m json.tool docs/vercel.json >/dev/null`；`rg -n "Vercel" docs/README.md`

**Commit:** `docs: add Vercel static hosting for public snapshot`

---

## Task 4: 公开快照部署脚本

**Depends on:** none

**Files:**
- Create: `scripts/deploy-public-snapshot.sh`

- [x] **Step 1:** 脚本支持：若已安装 `vercel` CLI 且设置 `VERCEL_TOKEN`（或已 login），从仓库根对 `docs` 目录执行 `vercel deploy --prod --yes`（或文档化等价命令）；无 CLI 时打印 Vercel Dashboard / Git 集成步骤并 exit 0 或 2（选择：缺 CLI 时 exit 2 并打印说明，便于 CI 区分）。
- [x] **Step 2:** 脚本开头 `set -euo pipefail`；不打印任何 secret。
- [x] **Verify:** `bash -n scripts/deploy-public-snapshot.sh`

**Commit:** `feat: add public snapshot Vercel deploy helper script`

---

## Task 5: 可选 GitHub Action 部署公开站

**Depends on:** Task 3（commit）— 依赖 `docs/vercel.json` 语义

**Files:**
- Create: `.github/workflows/deploy-public-vercel.yml`

- [x] **Step 1:** 仅在 `docs/**` 变更或 `workflow_dispatch` 时运行；使用官方 Vercel action 或 `amondnet/vercel-action` 一类成熟 action；通过 secrets：`VERCEL_TOKEN`、`VERCEL_ORG_ID`、`VERCEL_PROJECT_ID`。
- [x] **Step 2:** 注释说明：未配置 secrets 时跳过或允许 failure；workflow 文件内写清要在 Vercel 创建 project 且 Root Directory=`docs`。
- [x] **Verify:** 文件存在且含 `workflow_dispatch` 与 `VERCEL_TOKEN`；`rg -n "docs" .github/workflows/deploy-public-vercel.yml`

**Commit:** `ci: optional Vercel deploy workflow for docs snapshot`

---

## Task 6: DEPLOY / Runbook / 根 README 串联

**Depends on:** Task 1, Task 2, Task 3, Task 4, Task 5（commits）— 文档需引用真实路径

**Files:**
- Modify: `docs/DEPLOY.md`
- Create: `docs/COMBO_A_RUNBOOK.md`
- Modify: `README.md`（文档导航表）
- Modify: `docs/OPERATIONS.md`（若有部署入口句，改指组合 A；保持简短）

- [x] **Step 1:** `DEPLOY.md` 开篇定义组合 A 为推荐生产形态；步骤顺序：Compose → private 数据 → Caddy →（并行）Vercel 公开。
- [x] **Step 2:** `COMBO_A_RUNBOOK.md` 提供检查清单：DNS、防火墙、`.env`、`docker compose up`、Caddy、Vercel project、首次 snapshot、持仓 mount 文件存在性。
- [x] **Step 3:** 根 `README.md` 文档导航增加 COMBO_A_RUNBOOK 与更新 DEPLOY 描述。
- [x] **Verify:** `rg -n "组合 A|COMBO_A|Vercel" docs/DEPLOY.md docs/COMBO_A_RUNBOOK.md README.md`

**Commit:** `docs: document Combo A VPS+Vercel production path`

---

## Final verify

- [ ] `docker compose config -q`
- [ ] `bash -n scripts/deploy-public-snapshot.sh`
- [ ] `python3 -m json.tool docs/vercel.json >/dev/null`
- [ ] `test -f deploy/Caddyfile.example && test -f docs/COMBO_A_RUNBOOK.md`
- [ ] `cd web && npm test`（确认无业务回归；本计划偏运维，若未改 web/lib 可记为 smoke）

---

## Operator follow-up（非本计划 checkbox，写入 runbook）

1. 在狗云 VPS 克隆仓库、配置 `.env`、创建 `private/holdings.local.json`。
2. `docker compose up -d --build`；配置 Caddy 与域名。
3. Vercel 新建项目，Root = `docs`，配置 GitHub secrets 或本地 `vercel link`。
4. 合并/推送后验证：公开 URL 打开快照；私有 URL 需鉴权且 8001 外网不可达。
