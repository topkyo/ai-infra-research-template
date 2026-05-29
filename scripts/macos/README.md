# macOS 本地系统服务（launchd）

将 **pyserver**（8001）与 **web**（3000）注册为当前用户的 LaunchAgent，在用户登录后自动启动，崩溃后自动重启。

## 安装

```bash
chmod +x scripts/macos/install-launchd.sh scripts/macos/uninstall-launchd.sh
./scripts/macos/install-launchd.sh
```

前提：

- 仓库根目录 `nvm use`（读取 [`.nvmrc`](../../.nvmrc)），**不要**让 launchd 与本地 shell 使用不同 Node 主版本
- `pyserver/.env` 含 `TUSHARE_TOKEN`
- `web/.env.local` 从 `web/env.example.txt` 复制，含 `PYSERVER_URL`、LLM key，以及信号/回测超时与并发（见根目录 README「LLM 同步任务调优」）
- 已执行 `cd pyserver && uv sync`、`cd web && npm install`（`postinstall` 会校验 `better-sqlite3`）

Web 以 **生产模式**（`npm run start`）运行；首次安装若缺少 `web/.next` 会自动 `npm run build`。

## 清行情缓存

mock 模式或网络异常后，`cache.db` 可能残留 `Mock-*` 数据：

```bash
./scripts/macos/clear-market-cache.sh
```

### 东财现价：默认直连（不要误开代理）

pyserver 启动时会**剥离** shell 里的 `HTTP_PROXY`/`HTTPS_PROXY`（例如 Clash `127.0.0.1:7890`），东财 `push2` 请求默认**直连**，与终端里 `env | grep -i proxy` 无关。

- **默认**：`pyserver/.env` 中**不要**设置 `MARKET_HTTP_PROXY`（国内宽带、能打开东财行情页时保持留空）。
- **仅兜底**：境外或特殊网络下，浏览器/直连 `push2` 失败，且经 Clash **国内节点** 走代理反而能通时，才在 `pyserver/.env` 显式设置：

```bash
MARKET_HTTP_PROXY=http://127.0.0.1:7890
```

Clash 建议为 `push2.eastmoney.com`、`.eastmoney.com` 使用 **DIRECT** 或国内节点，避免误走海外节点导致空响应。

诊断：`./scripts/macos/verify-network.sh`（会分别测「直连」与「经 7890」）。修复网络或规则后执行 `./scripts/macos/clear-market-cache.sh` 并复测。

Tushare 积分与接口权限见 [`docs/TUSHARE-PERMISSIONS.md`](../../docs/TUSHARE-PERMISSIONS.md)。

## 卸载

```bash
./scripts/macos/uninstall-launchd.sh
```

## 日志与状态

| 路径 | 说明 |
|------|------|
| `~/Library/Logs/topkyo-ai-infra/com.topkyo.ai-infra.pyserver.log` | sidecar 标准输出 |
| `~/Library/Logs/topkyo-ai-infra/com.topkyo.ai-infra.web.log` | Next.js 标准输出 |
| `*.err.log` | 标准错误 |

```bash
launchctl print gui/$(id -u)/com.topkyo.ai-infra.pyserver
launchctl print gui/$(id -u)/com.topkyo.ai-infra.web
curl http://127.0.0.1:8001/health
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:3000
```

## 说明

- 使用 **用户级** LaunchAgent（`~/Library/LaunchAgents`），在 macOS 上等同于「当前用户登录后自启」；无需 root。
- 若需未登录也启动，需改用 `/Library/LaunchDaemons` 并以 root 安装（本仓库未默认提供）。
- 更新代码后若改动了前端：在 `web/` 执行 `npm run build`，再 `launchctl kickstart -k gui/$(id -u)/com.topkyo.ai-infra.web`。
- 升级 Node 或 `npm install` 后若出现 `ERR_DLOPEN_FAILED`：`nvm use && ./scripts/rebuild-native-modules.sh`，再 kickstart web；或重新运行 `./scripts/macos/install-launchd.sh`（会按 `.nvmrc` 重建并重启）。
