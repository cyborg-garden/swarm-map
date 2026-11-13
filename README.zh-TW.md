<!-- 譯自 README.md @ fbe08cc；如有出入，以英文版為準。 -->
<!-- Translated from README.md @ fbe08cc. The English README is authoritative. -->

# Swarm Map

[English](README.md) | [简体中文](README.zh-CN.md) | **繁體中文**

> **Swarm Map (SM)** —— 原名 Hermes Swarm Map / HSM。

[Cyborg Garden](https://www.cyborg.garden/) 的公共財（commons）開源專案。

**專為異質代理執行環境打造的多人協作管理與編排平台。** 一個儀表板，管理一整支 [Hermes](https://github.com/cyborg-garden/hermes-agent-mt) 代理隊伍，每個代理都在自己的容器中。多租戶安全、模型級聯和平台連線都來自同一個控制平面。

*同類首創：一個點選式圖形介面，不僅管理代理管理代理執行環境，還管理「誰能在哪裡做什麼」。解決多租戶代理問題。正視複雜性的全貌，而不迷失其中。共享運算資源。*

**目前只提供一種執行環境。** Hermes 是受支援的路徑。先前的 Letta 整合已移除：它針對的是 Letta 的自託管伺服器，而 Letta 已將其退役。哪些已上線、哪些已移除、哪些在計畫中，請看 [Runtimes](docs/runtimes.md)（英文）。我們寧願你讀一頁枯燥的說明，也不願你部署之後才發現缺口。

<img width="1352" height="763" alt="Swarm Map 儀表板截圖" src="https://github.com/user-attachments/assets/4b94f0d1-d9b8-4a81-8b47-b2dae1940741" />
*平靜的介面，展示跨多種代理執行環境的設定項*

---

## 為什麼需要 Swarm Map？

代理在「隨時在線」時最有用：跑在伺服器上，手機上隨時能找到它，跨對話記住上下文。但要為*多個*使用者、在*多個*平台上執行*多個*代理，事情就難了。

Swarm Map 就是這個控制平面。一個介面即可部署、設定和管理一整支代理隊伍——每個代理都有自己的人格、記憶、平台連線和預算。單個代理能做的一切，現在可以成倍放大，並且多人共用。

當你的代理並非都跑在同一種 harness 上時，事情同樣會變難，因為每種 harness 處理聊天存取、金鑰和記憶的方式都不一樣。目前 Swarm Map 透過單一執行環境介面（`ContainerRuntimeAdapter`）驅動 Hermes。以 Swarm Map 不認識的執行環境儲存的代理資料列，絕不會被當成 Hermes 處理。

## 大家用它做什麼

**獨立開發者**執行 3 個代理：Telegram 上的客服機器人、Signal 上的研究助理，以及透過 API 呼叫的程式設計助手。每個都有自己的模型級聯（複雜任務用 Claude，簡單任務用 Gemini Flash）、自己的預算上限和自己的人格。SM 在一個儀表板裡管理這三個。

**小團隊**在 Mattermost 上給每位成員配一個專屬 AI 助手。記憶按頻道隔離——工程頻道討論的內容只留在工程頻道。團隊負責人在 SM 裡管理 API 金鑰、監控成本、審核新的群組連線。

**AI 研究者**在 Signal 和 Telegram 上為不同研究方向執行 8 個專用代理。SM 負責整個隊伍的群組審核政策、模型備援鏈和成本追蹤。新代理透過精靈幾分鐘即可部署。

## 你能得到什麼

🧙 **設定精靈** —— 5 次點選部署一個新代理。壓縮、記憶、安全和語音轉文字都有合理的預設值，開箱即用。

🔀 **模型級聯** —— 跨服務供應商的有序備援鏈。先用 Claude，失敗時改用 Gemini，再改用本機 Ollama。可針對每個代理個別設定。

🔐 **多租戶安全** —— 依上下文隔離記憶、群組審核政策、僅管理員可用的指令、加密儲存的 API 金鑰。每個對話執行緒都是一座有圍牆的花園。

📊 **隊伍總覽** —— 一眼看清所有代理：健康狀態、成本、工作階段數、模型用量。可在介面上停止、重啟或重建任意容器。

🔌 **平台連線** —— 將代理連線到 Signal、Telegram、Mattermost，或透過 API 對外提供。在介面上管理各連線管道。

💰 **預算約束** —— 為每個 API 金鑰設定每月花費上限。超出預算時代理會自行節流。

🧩 **單一執行環境介面** —— Hermes（每個代理一個容器）是受支援的執行環境。未來計畫在相同規則下納入更多 harness；最新狀態見 [Runtimes](docs/runtimes.md)。

---

## 執行環境

Swarm Map 目前驅動一種代理執行環境。

| | **Hermes** |
|---|---|
| 代理是 | 一個容器 |
| 透過精靈部署 | 支援 |
| 啟動 / 停止 / 重啟 / 重建 | 支援 |
| 訊息平台（Signal / Telegram / Mattermost / Discord） | 支援，直連 |
| 群組審核 + 稽核 | 支援 |
| 預算約束 | 支援 |

舊的 Letta 整合（一個針對 Letta 已退役自託管伺服器的用戶端，以及一個向其轉送請求的 Hermes 前端）已移除。標記為已退役或未知執行環境的已儲存資料列會單獨列出，絕不會被當成 Hermes 處理，只能被遺忘（forget）。

哪些已上線、哪些已移除、哪些在計畫中：[docs/runtimes.md](docs/runtimes.md)。

---

## 快速開始

```bash
git clone https://github.com/cyborg-garden/swarm-map.git
cd swarm-map
pnpm install
pnpm seed         # 首次執行：寫入設定與分層組態
pnpm dev          # http://localhost:3000
```

首次啟動時，設定精靈會自動偵測你的 Hermes compose 目錄。指向你的代理目錄即可開始。

**第一次來？** 閱讀 [Getting Started 指南](docs/getting-started.md)（英文）取得完整步驟。

### 系統需求

- **Node.js 18+**
- 本機執行的 **Docker**——Docker Desktop 或 OrbStack，用於容器管理（Swarm Map 呼叫你 PATH 中的 `docker` CLI）
- **Hermes Agent** 執行個體——Swarm Map 部署的是多租戶分支 [cyborg-garden/hermes-agent-mt](https://github.com/cyborg-garden/hermes-agent-mt)，它是 [NousResearch/hermes-agent](https://github.com/NousResearch/hermes-agent) 的一個分支

---

## 功能

- **自動發現** —— 自動偵測 Hermes 代理容器和 compose 檔案
- **個別代理設定** —— 編輯環境變數、SOUL.md 人格設定、平台連線
- **模型級聯** —— 跨服務供應商（Anthropic、OpenAI、Bedrock 等）的有序備援鏈
- **連線管道管理** —— 將代理連線到 Telegram、Signal、Mattermost
- **重啟 / 重建 / 清除** —— 透過介面或 API 管理容器生命週期
- **政策執行** —— 群組存取控制、私訊審核、管理員判定
- **代理建立精靈** —— 在介面上建立並部署新代理
- **API 金鑰管理** —— 使用 AES-256-GCM 加密儲存
- **稽核紀錄** —— 記錄誰在什麼時候改了什麼

<img width="911" height="742" alt="設定介面截圖" src="https://github.com/user-attachments/assets/68a7f594-4e17-419a-8cb6-180b94cac40a" />

<img width="680" height="686" alt="代理建立精靈" src="https://github.com/user-attachments/assets/62ff24dc-d266-4c18-9542-038ac1b09eaa" />

---

## 在遠端伺服器上執行

建置一次，以生產模式執行：

```bash
pnpm build
npx next start --port 3000 --hostname 0.0.0.0
```

在同一網路中的任何機器上存取 `http://<hostname>:3000`。如需 HTTPS 或外部網路存取，請放在 nginx 或 Tailscale 之後。

在遠端機器上使用開發模式時，在 `.env` 中設定 `ALLOWED_DEV_ORIGINS`（見「設定」）。

---

## 架構

<img width="1023" height="724" alt="架構截圖" src="https://github.com/user-attachments/assets/a2ad3118-81a2-433a-ae02-289546e7e02d" />

- **Next.js 16**（App Router）+ **TypeScript**
- **Tailwind CSS v4** + **shadcn/ui** + **Lucide Icons**
- 透過 shell 呼叫 **Docker CLI** 管理容器
- 使用 **Vitest** 測試
- 使用 **AES-256-GCM** 加密儲存金鑰
- 以檔案為基礎的代理設定，位於 `~/.hermes-swarm-map/`

---

## 安全模型

SM 假設使用者屬於一個**基本可信的團隊**——所有能存取儀表板的使用者都可以管理全部代理、金鑰和設定。同一部署內沒有按使用者劃分的角色或權限範圍。

**受保護的部分：**
- API 金鑰使用本機金鑰以 AES-256-GCM 加密儲存
- 稽核紀錄記錄誰改了什麼
- 依代理劃分的記憶範圍隔離各對話上下文
- 群組審核政策控制代理可以加入哪些平台

**未做範圍隔離的部分：**
- 儀表板存取是全有或全無——任何能開啟介面的人都能管理整個隊伍
- 技能、工具和代理設定在所有操作者之間共享
- 底層 Hermes 代理和任何以 LLM 為基礎的系統一樣，仍會受到惡意外部內容（訊息、匯入的文件）的提示注入攻擊

**實際建議：** 將 SM 執行在私有網路中，或放在身分驗證機制之後（Tailscale、nginx basic auth 等），只讓你信得過、可以託付 API 金鑰和代理設定的人存取。

---

## API 參考

任何 AI 代理（Claude Code、Hermes 等）都可以透過 REST API 編排整個隊伍，無需圖形介面。完整路由表見[英文 README 的 API Reference 章節](README.md#api-reference)。

```bash
# 範例
curl http://localhost:3000/api/harnesses
curl -X POST http://localhost:3000/api/harnesses/h_myagent/restart \
  -H "Content-Type: application/json" -d '{"mode":"quick"}'
curl http://localhost:3000/api/harnesses/h_myagent/logs?lines=50
```

---

## 設定

將 `.env.example` 複製為 `.env` 並設定：

| 變數 | 預設值 | 說明 |
|---|---|---|
| `HERMES_DIR` | — | 現有 Hermes docker-compose 檔案所在路徑 |
| `DATA_DIR` | `~/.hermes-swarm-map` | 設定、金鑰、稽核紀錄、獨立 compose 檔案 |
| `PORT` | `3000` | Swarm Map 介面連接埠 |
| `ALLOWED_DEV_ORIGINS` | — | 允許遠端開發存取的主機名稱，逗號分隔 |

設定儲存在 `~/.hermes-swarm-map/settings.json`。API 金鑰使用位於 `~/.hermes-swarm-map/.key` 的本機金鑰加密儲存。

---

## 文件（英文）

- [Getting Started](docs/getting-started.md) —— 5 分鐘部署你的第一個代理
- [Runtimes](docs/runtimes.md) —— 哪些已上線、哪些已移除、哪些在計畫中
- [Migrating Existing Agents](docs/migrating.md) —— 現有 Hermes 使用者的升級路徑
- [Platform Setup](docs/platforms.md) —— Signal、Telegram、Mattermost、Google Workspace 指南
- [Image vs HSM Boundary](docs/architecture/image-vs-hsm-boundary.md) —— 哪些屬於 Docker 映像檔，哪些屬於 HSM 鷹架
- [Roadmap](docs/ROADMAP.md) —— 已上線和接下來的計畫
- [Contributing](CONTRIBUTING.md) —— 開發環境和 PR 流程
- [Architecture](AGENTS.md) —— 服務層、模式與代理開發指南

**歡迎用中文提 issue 和 PR。**

---

## 授權條款

Swarm Map —— Copyright (C) 2025-2026 Juniper Bevensee 及貢獻者。見 [NOTICE](NOTICE)。

採用 [AGPL v3](LICENSE) 授權。你可以自由使用、修改和部署本軟體。如果你修改了它並透過網路對外提供（例如作為託管服務），必須以相同授權條款公開修改後的原始碼。為自己的代理自託管無需公開原始碼。
