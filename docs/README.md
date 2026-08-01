# docs/ 静态快照

`docs/` 用于公开展示最近一次研究快照。它不运行 Next.js，不访问私有 API key，只读取 `docs/data/*.json`。

**线上（Vercel）：** <https://ai-infra-dashboard-docs.vercel.app>

项目：`ai-infra-dashboard-docs`（Root Directory = `docs`，Framework = Other，无构建）。本地已登录 CLI 时可：

```bash
./scripts/deploy-public-snapshot.sh
# 或：vercel deploy --prod --yes --cwd docs
```

**备选：** GitHub Pages（需在仓库 Settings 启用 Pages）仍可托管同一份静态文件。

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
uv run uvicorn main:app --port 8001
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

刷新后提交并部署 `docs/data/` 即可更新公开快照（Vercel Git 集成会自动部署，或通过 Vercel CLI / Dashboard 手动触发；GitHub Pages 则 push 到默认分支即可）。

## 预览

```bash
python3 -m http.server 8765 --directory docs
```

打开 <http://localhost:8765/>。

## 边界

- 静态页只展示最近一次快照，不代表实时行情。
- 快照数据可能包含 LLM 信号和回测记录，只适合作为可公开研究记录。
- 需要实时数据、在线信号生成、交互式回测或股票池刷新时，请运行完整 Next.js + pyserver 应用。
