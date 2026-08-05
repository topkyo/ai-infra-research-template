# 备份 Runbook

VPS 上 Docker Compose 部署有两类**不可从公开仓库恢复**的数据，需单独备份：

| 资产 | 宿主机 / Docker | 容器内路径 | 为何备份 |
|---|---|---|---|
| 回测存档 + LLM 缓存 | named volume **`web-cache`** | `/app/.cache`（主文件 `web.db`） | 历史回测结果长期保存在 SQLite；**换模型或 prompt 后无法原样重跑** |
| 真实持仓 | bind mount **`./private/`** | `/app/private`（`holdings.local.json`） | 真实资金与仓位；仓库仅含 `holdings.example.json` |

`pyserver-cache`（行情 SQLite）可随时间重建，优先级低于上表；丢失后仅增加冷启动拉数时间。

**切勿**将 API key（根目录 `.env`）、`holdings.local.json` 或含密钥的备份提交到本仓库或任何公开 git。

---

## 建议频率

| 资产 | 频率 | 触发条件 |
|---|---|---|
| `web-cache` | **每周**，或每次重要回测后 | 升级 `LLM_MODEL` / `LLM_MODEL_BACKTEST` 前**必备份** |
| `private/` | **每日**，或每次改持仓后 | 真实模式信号依赖此文件 |

---

## 备份目的地（任选或组合）

1. **私有 git** — 单独加密仓库（如 `git-crypt` / 仅 VPS 可 push 的 bare repo）；只存 tarball，不含 `.env` 明文 key。
2. **对象存储** — S3 / R2 / OSS 等，启用服务端加密与独立凭证；按日期前缀归档。
3. **本地 rsync** — 同步到另一台机器或 NAS：`rsync -a --delete` 到离线目录。

根目录 `.env` 若需灾难恢复，单独加密备份（密码管理器、KMS 或加密 tarball），**不要**与公开 snapshot 同路径。

---

## 备份步骤

在仓库根目录执行。将 `BACKUP_ROOT` 换成你的离线目录（勿放在可被公开 web 服务读取的路径）。

```bash
export BACKUP_ROOT=/var/backups/ai-infra-dashboard   # 示例
mkdir -p "$BACKUP_ROOT"
STAMP=$(date +%Y%m%d-%H%M)

# 1) web-cache（回测存档在 web.db 的 backtest_results 表）
docker compose stop web
docker compose run --rm --no-deps web tar czf - -C /app/.cache . \
  > "${BACKUP_ROOT}/web-cache-${STAMP}.tar.gz"
docker compose start web

# 2) 真实持仓（整个 private/ 目录，含 holdings.local.json）
rsync -a private/ "${BACKUP_ROOT}/private-${STAMP}/"
# 或单文件：cp -a private/holdings.local.json "${BACKUP_ROOT}/holdings.local.json.${STAMP}"
```

确认 tarball 非空：

```bash
tar tzf "${BACKUP_ROOT}/web-cache-${STAMP}.tar.gz" | head
test -f "${BACKUP_ROOT}/private-${STAMP}/holdings.local.json"
```

上传到对象存储或推送到私有 git 后，保留至少 **2** 个代际（例如当前 + 上一周）。

---

## 恢复步骤

**恢复前**停止 web，避免 SQLite 写入与 tarball 冲突。

### 恢复 `web-cache`

```bash
export BACKUP_ROOT=/var/backups/ai-infra-dashboard
ARCHIVE=web-cache-YYYYMMDD-HHMM.tar.gz   # 换成实际文件名

docker compose stop web

# 清空卷内旧数据并解压（卷名随 compose 项目名变化，先 ls 确认）
VOL=$(docker volume ls -q | grep web-cache | head -1)
docker run --rm \
  -v "${VOL}:/data" \
  -v "${BACKUP_ROOT}:/backup:ro" \
  alpine sh -c "rm -rf /data/* && tar xzf /backup/${ARCHIVE} -C /data && chown -R 1001:1001 /data"

docker compose start web
```

若卷属主异常（旧 root 容器遗留），见 [DEPLOY.md](DEPLOY.md) §3 的 `chown` 命令。

验证：打开 `/backtest` 页面，历史回测列表应出现；或进入容器检查：

```bash
docker compose exec web ls -la /app/.cache/
```

### 恢复 `private/holdings.local.json`

```bash
rsync -a "${BACKUP_ROOT}/private-YYYYMMDD-HHMM/" private/
sudo chown -R 1001:1001 private    # 与 DEPLOY.md §3 一致
docker compose restart web
```

验证：`curl -sS http://127.0.0.1:3000/api/signals?mode=real` 不应返回 `setup_required`（需 LLM key 与行情正常）。

---

## 不要备份进 git 的内容

- 根目录 `.env`（含 `DEEPSEEK_API_KEY` / `OPENCODE_GO_API_KEY` / `TUSHARE_TOKEN`）
- `private/holdings.local.json` 及任何含真实仓位的文件
- 未加密的 `web-cache` tarball

公开仓库中的 `docs/data/` 仅为静态 snapshot，**不能**替代上述私有备份。

---

## 相关文档

- 挂载与权限：[DEPLOY.md](DEPLOY.md) §3、[private/README.md](../private/README.md)
- 缓存语义：[OPERATIONS.md](OPERATIONS.md) §缓存
