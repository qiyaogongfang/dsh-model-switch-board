# 模型切换看板（dsh-task-router）

> **半成品 / Work in progress** —— 能跑，但接口、配置和界面都会变。

## 项目状态

这是一个实验性插件/看板，功能可用但接口、配置文件和界面可能随时变更，不保证稳定性。
仅在本机 Ollama + DSH 环境中验证过，尚未经过广泛测试。
欢迎试用并提 issue，但请勿用于生产环境。

This is an experimental plugin/board. Functionality is available, but interfaces, configuration files, and UI may change at any time with no stability guarantees.
Only tested in local Ollama + DSH environments.
Try it out and feel free to report issues, but please do not use it in production.

## 它是什么

DSH（DeepSeek Harness）的一个本地插件，做两件事：

1. **后台任务路由**：把机械的文本/编码活按「简单 / 一般 / 复杂」分给不同模型，后台跑完只回摘要，主对话不背原文；
2. **模型切换看板**：侧栏面板里按对话列出模型参与情况（哪几轮是谁跑的、API 还是本机）、token 和后台任务，并允许直接给三层换模型。

## 分层

| 层 | 默认后端 | 用途 |
| --- | --- | --- |
| `cheap` | 本机 Ollama `qwen3.8:latest`（走 DSH 提供方 `ollama`） | 摘要、抽取、分类、翻译、润色、格式转换、机械改写 |
| `standard` | 本机 Ollama `deepseek-r1:14b`（走 DSH 提供方 `ollama`） | 一般文本处理、多步整理、非紧急分析 |
| `deep` | 不转交 | 代码、架构、审核、需要对话上下文的任务 |

三层都可以在面板的「模型设置」里换成任意已注册的 DSH 提供方/模型；复杂层也可以选「留在主对话」。

## 安装

需要 DSH ≥ 0.2.2-rc.1，以及本机 Ollama（或任意 OpenAI 兼容接口）。

```bash
git clone https://github.com/qiyaogongfang/dsh-model-switch-board.git
```

在 DSH 桌面版里把目录作为本地插件安装（插件管理里选本地目录），或把目录以 `link:` 方式加进 profile，然后重载插件、刷新页面。

> 半成品说明：包名暂时沿用本地开发时的 `@local/task-router`，是为了和现有 profile 的 link 保持一致；正式发布时会换成公开包名。

## 工具

| 工具 | 作用 |
| --- | --- |
| `route_submit` | 提交任务（文本 + 文件路径 + 可选输出路径），立刻返回 job id |
| `route_status` | 看队列：排队 / 运行 / 完成 / 失败 |
| `route_result` | 取结果：默认摘要，`full=true` 才给全文 |
| `route_cancel` | 取消排队或运行中的任务 |
| `route_backends` | 看当前分层、后端，以及 DSH 里可用的模型提供方 |

## 模型切换看板

侧栏「模型切换看板」图标，主区域列出最近 30 个对话：每个对话的主模型（API / 本机、具体模型名）、各多少轮、多少 token、提交过哪些后台任务。点一行展开明细：模型参与时间线 + 模型明细表 + 后台任务表。

- **模型参与时间线**：按连续段列出「第 12–48 轮 · deepseek-flash · API · 36 次」这类记录，本地模型也会显示完整名称（如 `qwen3.8:latest`、`deepseek-r1:14b`）。
- **模型设置**：面板顶部「模型设置」里，分别给复杂 / 一般 / 简单选提供方和模型（复杂可以选「留在主对话」）。保存后写到 `data/models.json`，重启也生效，新提交的任务按新配置走。
- 数据来源：DSH 会话日志（`ctx.sessionPersistence`）+ 插件自己的任务记录；本机模型按 Ollama 提供方识别。
- 首次打开要扫一遍会话，30 个大约几秒；扫完写进 `data/dashboard-cache.json`，之后按 revision 增量刷新。
- 正在写的当前对话不读日志（会和写句柄抢锁），显示上一次缓存的统计，标记「实时对话」。
- 看板每 4 秒自动刷新；「刷新」按钮强制重扫。

## 数据

- 任务元数据：`data/jobs/<id>.json`
- 结果全文：`data/results/<id>.md`
- 看板统计缓存：`data/dashboard-cache.json`
- 面板里改过的分层模型：`data/models.json`
- 可传 `output` 让结果另存一份到你指定的路径
- DSH 重启后：未跑完的任务标记为失败（不会假装完成）

## 实测（2026-11-23，本机 Ollama）

| 层 | 任务 | 用时 | 用量 |
| --- | --- | --- | --- |
| cheap | 会议记录 → 3 条要点（约 400 字输入） | 26s | 954 token（本机，不花钱） |
| standard | 会议记录 → 181 字正式通知 | 15s | 795 token（本机，不花钱） |

主对话全程只收到一行摘要和结果文件路径，没有把原文和过程搬进上下文。

测试脚本：`node test/smoke.mjs`（引擎，不连模型）、`node test/backends.mjs`（真连本机与网关）、`node test/client-smoke.mjs`（面板模块注册）。

## 配置

插件配置（`cordis.patch.yml` 里该插件的 `config`）只覆盖你要改的字段，`backends` 数组整体替换：

```yaml
- insert:
    - id: task-router
      name: '@local/task-router'
      config:
        summaryChars: 800
        tiers:
          standard:
            concurrency: 2
            backends:
              - kind: http
                label: 免费池 free/smart
                baseURL: http://127.0.0.1:8317/v1
                model: free/smart
                apiKeyFile: ~/.dsh-model/keys.json
                timeoutMs: 300000
```

后端两种写法：

- `kind: http`：OpenAI 兼容接口，`baseURL` + `model`，`apiKey` / `apiKeyEnv` / `apiKeyFile` 三选一（本机 Ollama 不需要 key）。
- `kind: llm`：走 DSH 已注册的提供方，`provider` + `model`，不用自己管 key。

## 边界（半成品已知问题）

- 单轮调用，不带工具循环：本地模型不会自己读文件、改文件——文件由插件读入，结果由插件写出。
- 本机模型上下文有限：单文件超过 12000 字建议先拆分。
- 正在写的当前对话不读日志，只显示上次缓存；会话结束后才补时间线。
- 只统计最近 30 个对话；子代理和 mnemon 运行会话已过滤。
- 免费池/API 层的 token 会真的花掉，切之前想清楚；默认两层都走本机、不出网。
- 失败会退到同层下一个后端，全失败如实报错，不会偷偷换成另一个厂商。

## License

[MIT](LICENSE)
