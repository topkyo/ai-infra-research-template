# topkyo · A 股主题研究台（模板）

在自己电脑上跑的主题研究台：维护股票池、看行情、按持仓生成目标仓位、做回测。

输出只供你复核，**不是投资建议，不能当交易指令**。行情来自第三方接口，**默认不是实时成交价**。

本仓库给的是**研究机器**，不是一份可转发的研究报告。不附带公开股票池、信号快照或买方研报，也没有官方公开站。骨架 fork 自 [madeye](https://github.com/madeye) 的 [硅基文明消费股交易系统](https://github.com/madeye/silicon-civilization-stock-trade)——那是作者自己的研究站。想跟原作叙事，请用上游。

**开箱：** 行情默认走 Eastmoney / AkShare / BaoStock，**不需要 Tushare**。看池子可以先不填任何行情 token（Tushare 只在你显式打开时当补缺）。上游文档开箱就要 Pro token。

**用起来：** `/signals` 是**持仓感知**的——读你本机的现金和持仓，按现价算当前权重，再给出目标仓位和调仓差额。上游信号页对着整池打 buy/hold/sell，不问你手里有什么。没有持仓文件不会假装你空仓；行情或 LLM 失败就报错，不编造买卖结论。实盘股票池和持仓留在本机，git 里只有示例。

推荐用 GitHub 的 **Use this template** 建仓，或：

```bash
git clone https://github.com/topkyo/ai-infra-research-template.git
cd ai-infra-research-template
```

## 你需要

- Node.js 24（仓库根目录 `.nvmrc`；建议 [nvm](https://github.com/nvm-sh/nvm)）
- Python 3.11+ 和 [uv](https://docs.astral.sh/uv/)
- [DeepSeek](https://platform.deepseek.com/) API key：看行情可以先空着；生成信号、回测、刷新股票池时再填

## 第一次启动

```bash
cp web/data/universe.example.json web/data/universe.json
cp pyserver/env.example pyserver/.env
cp web/env.example.txt web/.env.local
# 编辑 web/.env.local，填入 DEEPSEEK_API_KEY

nvm install && nvm use          # 不用 nvm 则自行安装 Node 24
cd pyserver && uv sync && cd ..
cd web && npm install && cd ..

./start.sh
```

打开 <http://localhost:3000>。

已装 Docker 时：同样先复制 `universe.json`，再 `cp .env.example .env` 填 key，然后 `docker compose up --build`，打开 <http://127.0.0.1:3000>。

| 打开 | 做什么 |
|---|---|
| `/` | 股票池和行情 |
| `/signals` | 按真实持仓或模拟资金生成目标仓位 |
| `/backtest` | 策略体检；耗 LLM，不要当日常任务 |

示例股票池只有几只，用来把流程跑通，**不是推荐组合**。之后改被 gitignore 的 `web/data/universe.json`。不要把实盘名单、持仓或 API key 提交进 git。

[docs/](docs/) 是静态快照**壳**（`index.html`）。模板不带数据；生成与预览见 [docs/README.md](docs/README.md)。

## 三条纪律

1. **只绑本机。** 不要把端口改成对公网开放。Web API **没有登录**，别人能读持仓、也能花你的 LLM 额度。见 [SECURITY.md](SECURITY.md)。
2. **失败就报错。** 行情或 LLM 挂了，界面会明确不可用，不会编造买卖结论。
3. **不是开源软件。** 没有 `LICENSE`。源码公开是为了自托管；未经许可请勿当开源项目再分发。见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 再往下看

| | |
|---|---|
| 环境变量、排障 | [docs/OPERATIONS.md](docs/OPERATIONS.md) |
| 部署到服务器 | [docs/DEPLOY.md](docs/DEPLOY.md) |
| 怎么用这个台做研究 | [docs/RESEARCH_WORKFLOW.md](docs/RESEARCH_WORKFLOW.md) |
| 漏洞 | GitHub **Private vulnerability reporting**，不要开 Issue 贴细节 |
