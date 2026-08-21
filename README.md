# topkyo · A 股主题研究台（模板）

在自己电脑上跑的 **A 股主题研究台**：维护股票池、看行情、用 LLM 生成组合目标仓位、做回测。

输出只供你自己复核，**不是投资建议，不能当交易指令**。行情来自第三方接口，**默认不是实时成交价**。

推荐用 GitHub 的 **Use this template** 建自己的仓，或：

```bash
git clone https://github.com/topkyo/ai-infra-research-template.git
cd ai-infra-research-template
```

## 你需要

- Node.js 24（见仓库根目录 `.nvmrc`；建议用 [nvm](https://github.com/nvm-sh/nvm)）
- Python 3.11+ 和 [uv](https://docs.astral.sh/uv/)
- 一个 [DeepSeek](https://platform.deepseek.com/) API key（看行情可以先不填；生成信号、回测、刷新股票池时需要）

## 第一次启动

```bash
cp web/data/universe.example.json web/data/universe.json
cp pyserver/env.example pyserver/.env
cp web/env.example.txt web/.env.local
# 用编辑器打开 web/.env.local，把 DEEPSEEK_API_KEY 换成你的 key

nvm install && nvm use          # 若不用 nvm，请自行安装 Node 24
cd pyserver && uv sync && cd ..
cd web && npm install && cd ..

./start.sh
```

浏览器打开 <http://localhost:3000>。

已安装 Docker 时也可以：同样先复制 `universe.json`，再 `cp .env.example .env` 填入 API key，然后 `docker compose up --build`，打开 <http://127.0.0.1:3000>。

| 打开 | 做什么 |
|---|---|
| `/` | 股票池和行情 |
| `/signals` | 按持仓或模拟资金生成目标仓位 |
| `/backtest` | 策略体检；很耗 LLM，不要天天跑 |

模板自带的示例股票池只有几只，用来把流程跑通，**不是推荐组合**。之后改被忽略的 `web/data/universe.json`。不要把实盘名单、持仓或 API key 提交进 git。

## 三条纪律

1. **只绑本机。** 不要把端口改成对公网开放。这些 API **没有登录**，别人能读持仓、也能花你的 LLM 额度。见 [SECURITY.md](SECURITY.md)。
2. **失败就报错。** 行情或 LLM 挂了，界面会明确不可用，不会编造买卖结论。这是故意的。
3. **不是开源软件。** 没有 `LICENSE`。源码公开是为了你自托管；未经许可请勿当开源项目再分发。贡献约定见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 再往下看

日常怎么配环境、怎么排障：[docs/OPERATIONS.md](docs/OPERATIONS.md)

部署到服务器：[docs/DEPLOY.md](docs/DEPLOY.md)

怎么用这个台做研究：[docs/RESEARCH_WORKFLOW.md](docs/RESEARCH_WORKFLOW.md)

漏洞请走 GitHub 的 **Private vulnerability reporting**，不要开 Issue 贴细节。

## 致谢，以及和原作有何不同

本仓库 fork 自 [madeye](https://github.com/madeye) 的 [硅基文明消费股交易系统](https://github.com/madeye/silicon-civilization-stock-trade)：Next.js 研究台、FastAPI 行情 sidecar、DeepSeek 信号与回测这条骨架是他搭的。没有那份工作，不会有这个模板。致谢。

想跟原作、或继续用「硅基文明消费」叙事，请直接用上游仓库。本模板在那条骨架上改成了**可自托管的个人研究台**，主要不同：

| | madeye 的原作 | 本模板 |
|---|---|---|
| 主题 | 硅基文明消费：做多「喂养」AI 的供给链 | 默认 AI 基建；可用本地 `thesis.md` 换成你自己的叙事 |
| 给谁用 | 主题交易仪表盘，并可发布公开快照站 | 自己看盘用的模板；不是信号产品，也没有官方公开站 |
| 组合 | 策略信号与回测 | 加上**持仓感知**的目标仓位；行情/LLM 失败就报错，不编造买卖结论 |
| 股票池 | `universe.json` 进 git | 只提交示例池；你的实盘名单和持仓留在本机 |
| 行情源 | Tushare 更前置 | 免费源优先，Tushare 可选 |
| 网络 | 按开发服务启动 | 默认只绑本机；API 没有登录，不能对公网裸奔 |

上游仍在演进。这里不跟踪它的每一个提交；有骨架层面的修复，欢迎对照原作。

