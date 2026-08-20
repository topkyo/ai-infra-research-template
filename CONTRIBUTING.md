# 贡献指南

感谢关注本仓库。提交改动前请先阅读 [AGENTS.md](AGENTS.md) 中的数据完整性规则与 [SECURITY.md](SECURITY.md) 中的网络边界说明。

## 测试命令

改动涉及 web 或 pyserver 逻辑时，请在 PR 描述中注明已运行的命令及结果：

```bash
cd web && npm test
cd web && ./node_modules/.bin/tsc --noEmit
cd pyserver && uv run python -m unittest discover -p "test_*.py"
cd web && npm run test:e2e
```

## 我们会拒绝的 PR

- LLM、API 或关键数据失败时**合成** `hold`、目标仓位或回测买卖结论（违反严格失败语义）。
- 把非实时价或日线收盘**标成**实时成交价，或静默隐藏降级。
- 提交 API key、`.env*`、`web/data/holdings.local.json`、操作者实文件 `web/data/universe.json` / `web/data/thesis.md`，或把 `docs/data/*.json` 塞进 git。
- 把静态快照或示例股票池**写成**推荐组合或投资建议。
- 未经讨论新增业务兜底 / fallback，且缺少覆盖失败语义的测试。

## 提交说明

- 保持 commit 主题简洁、祈使语气，与近期历史一致。
- 避免在同一 PR 中混合无关的 web、pyserver 与纯文档改动，除非属于同一功能。
- PR 请包含行为摘要、已运行的测试命令、必要的环境变量说明；UI 变更请附截图。

## 许可

本仓库未预置开源许可证文件。提交 PR 不表示授予任何额外权利；许可安排由仓库维护者单独决定。
