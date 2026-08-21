# docs/ 静态快照

`docs/` 用于公开展示最近一次研究快照。它不运行 Next.js，不访问私有 API key，只读取 `docs/data/*.json`。

`docs/data/*.json` **不进 git**（见 [data/README.md](data/README.md)）。部署需自行配置静态托管（Vercel、GitHub Pages 或本机 `http.server`）；若使用 Vercel，建议关闭 Git 自动生产部署，改由 CLI 推送快照数据。

自行托管时：Root Directory = `docs`，Framework = Other，无构建。Vercel 项目名由操作者自定，不要把仓库维护者的项目名当成模板官方项目。

```bash
./scripts/vps-refresh-public-snapshot.sh          # 推荐：生成 + 部署
# 或已有 docs/data 时：
./scripts/deploy-public-snapshot.sh
```

**备选：** GitHub Pages 可托管同一静态壳，但数据文件仍须自行同步到 Pages 源，不推荐与 Combo A 混用。

## 内容

| 文件 | 说明 |
|---|---|
| `index.html` | 静态入口，展示股票池、LLM 信号和回测结果。 |
| `styles.css` | 与 Web 应用一致的浅色研究台样式。 |
| `app.js` | 无构建依赖的快照渲染逻辑。 |
| `data/universe.json` | 股票池快照。 |
| `data/analyst.json` | 现价、隐含目标、买入覆盖等一致预期参考。 |
| `data/signals.json` | LLM 信号与基本面输入快照。 |
| `data/backtest.json` | 回测曲线、统计和交易记录。 |
| `data/meta.json` | 快照生成时间。 |

## 刷新

完整刷新需要先启动 pyserver，并在 `web/.env.local` 配置 LLM key：

```bash
cd pyserver
uv run uvicorn main:app --host 127.0.0.1 --port 8001
```

```bash
cd web
npx tsx scripts/snapshot.ts
```

只刷新股票池和分析师数据，跳过 LLM 信号与回测：

```bash
cd web
SNAPSHOT_SKIP_SIGNALS=1 SNAPSHOT_SKIP_BACKTEST=1 npx tsx scripts/snapshot.ts
```

刷新后在仓库根执行 `./scripts/deploy-public-snapshot.sh`（需 `VERCEL_TOKEN`）。不要把 `docs/data/*.json` 提交进 git。

## 预览

```bash
python3 -m http.server 8765 --directory docs
```

打开 <http://localhost:8765/>。

## 边界

- 静态页只展示最近一次快照，不代表实时行情。
- 快照数据可能包含 LLM 信号和回测记录，只适合作为可公开研究记录。
- 需要实时数据、在线信号生成、交互式回测或股票池刷新时，请运行完整 Next.js + pyserver 应用。

模板不提供官方公开站。需要公开展示时，用本目录的静态页自行托管，并按需设置 `NEXT_PUBLIC_PUBLIC_SNAPSHOT_URL`。
