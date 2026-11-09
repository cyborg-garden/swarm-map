<!-- 译自 README.md @ 088694d；如有出入，以英文版为准。 -->
<!-- Translated from README.md @ 088694d. The English README is authoritative. -->

# Swarm Map

[English](README.md) | **简体中文** | [繁體中文](README.zh-TW.md)

> **Swarm Map (SM)** —— 原名 Hermes Swarm Map / HSM。

[NimbleCo](https://www.nimbleco.ai/) 的公共品（commons）开源项目。

**面向异构智能体运行时的多人协作管理与编排平台。** 一个控制台，管理两种形态的智能体：[Hermes](https://github.com/cyborg-garden/hermes-agent-mt) 智能体（每个智能体是一个独立容器），以及 [Letta](https://github.com/letta-ai/letta) 智能体（以记忆为核心，作为数据行运行在同一台共享服务器上）。无论哪种形态，多租户安全、模型级联和平台连接都来自同一个控制平面。

*同类首创：一个点选式图形界面，不仅管理智能体运行时，还管理“谁能在哪里做什么”。解决多租户智能体问题。直面复杂性的全貌，而不迷失其中。共享算力。*

**两种运行时的支持程度还不对等。** Hermes 是成熟路径；Letta 目前只支持只读查看和发送消息。具体哪些已上线、哪些未上线，请看 [Runtimes](docs/runtimes.md)（英文）——我们宁愿你读一张枯燥的对照表，也不愿你部署之后才发现缺口。

<img width="1352" height="763" alt="Swarm Map 控制台截图" src="https://github.com/user-attachments/assets/4b94f0d1-d9b8-4a81-8b47-b2dae1940741" />
*平静的界面，展示跨多种智能体运行时的配置项*

---

## 为什么需要 Swarm Map？

智能体在“始终在线”时最有用：跑在服务器上，手机上随时能找到它，跨对话记住上下文。但要为*多个*用户、在*多个*平台上运行*多个*智能体，事情就难了。

Swarm Map 就是这个控制平面。一个界面即可部署、配置和管理一整支智能体队伍——每个智能体都有自己的人格、记忆、平台连接和预算。单个智能体能做的一切，现在可以成倍放大，并且多人共用。

当你的智能体*形态*各不相同时，难度还会增加。Hermes 智能体是一个容器，可以启动、停止、重建，并挂接消息平台。Letta 智能体是共享服务器数据库里的一行，采用以记忆为核心的架构——没有自己的容器，也没有东西可以 `docker restart`。Swarm Map 用同一个运行时接口同时建模两者（容器类运行时用 `ContainerRuntimeAdapter`，Letta 用单独的 REST provider），而不是假装一切都是容器。

## 大家用它做什么

**独立开发者**运行 3 个智能体：Telegram 上的客服机器人、Signal 上的研究助理，以及通过 API 调用的编程助手。每个都有自己的模型级联（复杂任务用 Claude，简单任务用 Gemini Flash）、自己的预算上限和自己的人格。SM 在一个控制台里管理这三个。

**小团队**在 Mattermost 上给每位成员配一个专属 AI 助手。记忆按频道隔离——工程频道讨论的内容只留在工程频道。团队负责人在 SM 里管理 API 密钥、监控成本、审批新的群组接入。

**AI 研究者**在 Signal 和 Telegram 上为不同研究方向运行 8 个专用智能体。SM 负责整个队伍的群组审批策略、模型回退链和成本追踪。新智能体通过向导几分钟即可部署。

## 你能得到什么

🧙 **设置向导** —— 5 次点击部署一个新智能体。压缩、记忆、安全和语音转写都有预设的合理默认值，开箱即用。

🔀 **模型级联** —— 跨服务商的有序回退链。先用 Claude，失败回退到 Gemini，再回退到本地 Ollama。按智能体单独配置。

🔐 **多租户安全** —— 按上下文隔离记忆、群组审批策略、仅管理员可用的命令、加密存储的 API 密钥。每个对话线程都是一座有围墙的花园。

📊 **队伍总览** —— 一眼看清所有智能体：健康状态、成本、会话数、模型用量。可在界面上停止、重启或重建任意容器。

🔌 **平台连接** —— 将智能体连接到 Signal、Telegram、Mattermost，或通过 API 暴露。在界面上管理接入面。

💰 **预算约束** —— 为每个 API 密钥设置月度花费上限。超出预算时智能体会自行限流。

🧩 **两种运行时，一个接口** —— Hermes（每个智能体一个容器）和 Letta（以记忆为核心的智能体，作为数据行运行在共享服务器上）出现在同一个队伍视图中。功能对等只是部分实现，详见 [Runtimes](docs/runtimes.md)；上面六项描述的是 Hermes 路径。

---

## 运行时

Swarm Map 管理两种智能体运行时。它们**并不**对等，文档有意如实说明这一点。

| | **Hermes** | **Letta** |
|---|---|---|
| 智能体是 | 一个容器 | 共享服务器上的一行 |
| 通过向导部署 | 支持 | 支持（拉起共享服务器并创建智能体） |
| 启动 / 停止 / 重启 / 重建 | 支持 | 不适用——没有容器可控制（*服务器*本身是容器，具备这些操作） |
| 读取智能体状态 | 支持 | 支持——队伍列表、核心记忆块、模型标识 |
| 从界面发送消息 | 支持 | 支持 |
| 编辑记忆、重新配置、删除智能体 | 支持 | **未上线**——Swarm Map 中的 Letta REST 接口只有只读和发送消息 |
| 消息平台（Signal / Telegram / Mattermost / Discord） | 支持，直连 | 只能通过 Hermes 前端把群组对话代理给该智能体 |
| Git 备份的记忆文件（memfs） | 不适用 | **未启用**——我们从不请求 `git_enabled`，所以智能体沿用服务器默认值（`false`） |
| 群组审批 + 审计 | 支持 | 通过 Hermes 前端访问时继承 |
| 预算约束 | 支持 | **不覆盖经代理的 Letta 轮次**——见下文 |

**关于预算，直说。** 群组审批和审计记录可以通过 Hermes 前端完整继承，因为它们在轮次运行之前就进行拦截。预算**不会**继承——任何路径都不会。Swarm Map 的月度花费检查会汇总每个智能体 `state.db` 中 `sessions` 表的 `input_tokens` / `output_tokens`，而 Letta 桥接从不写入这两列：它只记录 `last_prompt_tokens`（上下文大小）。因此经代理的 Letta 花费不会被计入，软上限永远不会被触及。不要把 Letta 智能体部署在 Hermes 前端之后，并指望前端的预算上限能约束它。

完整细节，包括支撑上述结论的路由清单：[docs/runtimes.md](docs/runtimes.md)。

---

## 快速开始

```bash
git clone https://github.com/cyborg-garden/swarm-map.git
cd swarm-map
pnpm install
pnpm seed         # 首次运行：写入设置和分层配置
pnpm dev          # http://localhost:3000
```

首次启动时，设置向导会自动检测你的 Hermes compose 目录。指向你的智能体目录即可开始。如果在向导中选择 Letta 运行时，它会拉起共享的 Letta 服务器并在其上创建智能体。

**第一次来？** 阅读 [Getting Started 指南](docs/getting-started.md)（英文）获取完整步骤。

### 环境要求

- **Node.js 18+**
- 本地运行的 **Docker**——Docker Desktop 或 OrbStack，用于容器管理（Swarm Map 调用你 PATH 中的 `docker` CLI）
- Hermes 运行时：需要 **Hermes Agent** 实例——Swarm Map 部署的是多租户分支 [cyborg-garden/hermes-agent-mt](https://github.com/cyborg-garden/hermes-agent-mt)，它是 [NousResearch/hermes-agent](https://github.com/NousResearch/hermes-agent) 的一个分支
- Letta 运行时：需要一台 **Letta 服务器**——向导会通过 `docker/letta-compose.yml` 为你拉起

---

## 功能

- **自动发现** —— 自动检测 Hermes 智能体容器和 compose 文件
- **Letta 队伍视图** —— 列出已配置 Letta 服务器上的智能体，读取其核心记忆，发送消息（其余为只读）
- **按智能体配置** —— 编辑环境变量、SOUL.md 人格设定、平台接入
- **模型级联** —— 跨服务商（Anthropic、OpenAI、Bedrock 等）的有序回退链
- **接入面管理** —— 将智能体连接到 Telegram、Signal、Mattermost
- **重启 / 重建 / 清除** —— 通过界面或 API 管理容器生命周期
- **策略执行** —— 群组访问控制、私信审批、管理员判定
- **智能体创建向导** —— 在界面上搭建并部署新智能体
- **API 密钥管理** —— 使用 AES-256-GCM 加密存储
- **审计日志** —— 记录谁在什么时候改了什么

<img width="911" height="742" alt="配置界面截图" src="https://github.com/user-attachments/assets/68a7f594-4e17-419a-8cb6-180b94cac40a" />

<img width="680" height="686" alt="智能体创建向导" src="https://github.com/user-attachments/assets/62ff24dc-d266-4c18-9542-038ac1b09eaa" />

---

## 在远程服务器上运行

构建一次，以生产模式运行：

```bash
pnpm build
npx next start --port 3000 --hostname 0.0.0.0
```

在同一网络中的任何机器上访问 `http://<hostname>:3000`。如需 HTTPS 或外网访问，请放在 nginx 或 Tailscale 之后。

在远程机器上使用开发模式时，在 `.env` 中设置 `ALLOWED_DEV_ORIGINS`（见“配置”）。

---

## 架构

<img width="1023" height="724" alt="架构截图" src="https://github.com/user-attachments/assets/a2ad3118-81a2-433a-ae02-289546e7e02d" />

- **Next.js 16**（App Router）+ **TypeScript**
- **Tailwind CSS v4** + **shadcn/ui** + **Lucide Icons**
- 通过 shell 调用 **Docker CLI** 管理容器
- 使用 **Vitest** 测试
- 使用 **AES-256-GCM** 加密存储密钥
- 基于文件的智能体配置，位于 `~/.hermes-swarm-map/`

---

## 安全模型

SM 假设使用者属于一个**基本可信的团队**——所有能访问控制台的用户都可以管理全部智能体、密钥和配置。同一部署内没有按用户划分的角色或权限范围。

**受保护的部分：**
- API 密钥使用机器本地密钥以 AES-256-GCM 加密存储
- 审计日志记录谁改了什么
- 按智能体的记忆范围隔离各对话上下文
- 群组审批策略控制智能体可以加入哪些平台

**未做范围隔离的部分：**
- 控制台访问是全有或全无——任何能打开界面的人都能管理整个队伍
- 技能、工具和智能体配置在所有操作者之间共享
- 底层 Hermes 智能体和任何基于 LLM 的系统一样，仍会受到恶意外部内容（消息、导入的文档）的提示注入攻击

**实际建议：** 将 SM 运行在私有网络中，或放在认证之后（Tailscale、nginx basic auth 等），只让你信得过、可以托付 API 密钥和智能体配置的人访问。

---

## API 参考

任何 AI 智能体（Claude Code、Hermes 等）都可以通过 REST API 编排整个队伍，无需图形界面。完整路由表见[英文 README 的 API Reference 部分](README.md#api-reference)。

```bash
# 示例
curl http://localhost:3000/api/harnesses
curl -X POST http://localhost:3000/api/harnesses/h_myagent/restart \
  -H "Content-Type: application/json" -d '{"mode":"quick"}'
curl http://localhost:3000/api/harnesses/h_myagent/logs?lines=50
```

---

## 配置

将 `.env.example` 复制为 `.env` 并设置：

| 变量 | 默认值 | 说明 |
|---|---|---|
| `HERMES_DIR` | — | 现有 Hermes docker-compose 文件所在路径 |
| `DATA_DIR` | `~/.hermes-swarm-map` | 配置、密钥、审计日志、独立 compose 文件 |
| `PORT` | `3000` | Swarm Map 界面端口 |
| `ALLOWED_DEV_ORIGINS` | — | 允许远程开发访问的主机名，逗号分隔 |

设置保存在 `~/.hermes-swarm-map/settings.json`。API 密钥使用位于 `~/.hermes-swarm-map/.key` 的机器本地密钥加密存储。

---

## 文档（英文）

- [Getting Started](docs/getting-started.md) —— 5 分钟部署你的第一个智能体
- [Runtimes](docs/runtimes.md) —— Hermes 与 Letta：哪些已上线、哪些没有，以及依据
- [Migrating Existing Agents](docs/migrating.md) —— 现有 Hermes 用户的升级路径
- [Platform Setup](docs/platforms.md) —— Signal、Telegram、Mattermost、Google Workspace 指南
- [Image vs HSM Boundary](docs/architecture/image-vs-hsm-boundary.md) —— 哪些属于 Docker 镜像，哪些属于 HSM 脚手架
- [Roadmap](docs/ROADMAP.md) —— 已上线和接下来的计划
- [Contributing](CONTRIBUTING.md) —— 开发环境和 PR 流程
- [Architecture](AGENTS.md) —— 服务层、模式与智能体开发指南

**欢迎用中文提 issue 和 PR。**

---

## 许可证

Swarm Map —— Copyright (C) 2025-2026 Juniper Bevensee 及贡献者。见 [NOTICE](NOTICE)。

采用 [AGPL v3](LICENSE) 许可。你可以自由使用、修改和部署本软件。如果你修改了它并通过网络对外提供（例如作为托管服务），必须以相同许可证公开修改后的源代码。为自己的智能体自托管无需公开源代码。
