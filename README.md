# 智答 AI — 智能对话助手

[![CI](https://github.com/ShuaiShuai03/zhida-ai/actions/workflows/ci.yml/badge.svg)](https://github.com/ShuaiShuai03/zhida-ai/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

一个零前端构建依赖的 AI 对话 Web 应用，支持 OpenAI 兼容 Chat Completions API、Responses API 网络搜索、实时流式响应、多模型切换、思考过程展示、本地会话管理，以及同源 Node.js API 代理。

> **安全与隐私说明**
> 
> 聊天能力必须通过本仓库的 Node 后端代理：
> - 浏览器只请求同源 `/api/models`、`/api/chat/completions` 和 `/api/responses`
> - API 密钥不会写入浏览器 `localStorage`、备份 JSON 或前端请求头
> - 在设置中填写的 API 地址和密钥会提交给同源后端；后端使用 `ZHIDA_CONFIG_SECRET` 派生的 AES-256-GCM 密钥加密保存
> - GitHub Pages 和纯静态托管不能隐藏密钥，也不能作为可直接调用 API 的安全部署形态；需要聊天能力时请运行 Node 后端
> 
> **内容安全**
> 
> - 应用使用自定义 HTML 清洗器处理 AI 返回的内容，移除潜在危险标签和属性
> - 清洗器基于白名单机制，但不能保证 100% 防御所有 XSS 攻击向量
> - 如果你的 API 返回不可信内容，请自行评估风险

## 功能特性

| 分类 | 功能 |
|------|------|
| **对话** | 多轮上下文、SSE 实时流式输出、停止生成、重新生成 |
| **模型** | 默认模型列表、自定义模型、每个对话保留独立模型、保存后自动刷新模型、按模型能力启用 Responses / Web Search / 推理深度 |
| **内容** | Markdown / 代码高亮 / LaTeX、思考模型 `reasoning_content` / `<think>` 展示、Responses URL citation 来源链接 |
| **工具** | Responses API 网络搜索、支持模型的推理深度选择；不支持时禁用并明确提示 |
| **管理** | 对话搜索、置顶、标签、双击重命名、删除、清空全部、Markdown 导出、全量备份恢复、旧对话清理 |
| **模板** | 内置提示词模板、自定义模板增删改、点击插入输入框 |
| **输入** | 文本输入、图片上传、代码/文本文件上传、拖拽文件、粘贴图片 |
| **体验** | 深浅色主题、响应式布局、快捷键、系统提示词、温度与最大回复长度设置 |
| **部署** | Node 后端代理、Docker 后端代理；静态托管仅适合查看前端，不提供安全 API 调用能力 |

## 快速开始

### 方式一：Node 后端代理

```bash
git clone https://github.com/ShuaiShuai03/zhida-ai.git
cd zhida-ai

ZHIDA_CONFIG_SECRET="change-this-to-a-long-random-secret" \
ZHIDA_PORT=3000 \
node server/server.js
```

也可以使用脚本启动：

```bash
ZHIDA_CONFIG_SECRET="change-this-to-a-long-random-secret" bash scripts/start.sh 3000
```

打开 `http://localhost:3000`，点击右上角 **设置**，填入 API 地址和密钥，然后点击 **保存配置并获取模型列表**。API 地址可以填写 `https://api.openai.com` 或 `https://api.openai.com/v1`；后端会统一归一化，避免重复拼接 `/v1`。后端会将配置加密保存到 `server/data/config.enc.json`，随后代理会转发：

| 浏览器请求 | 上游请求 |
|------------|----------|
| `GET /api/config/status` | 读取脱敏配置状态，不返回密钥 |
| `PUT /api/config` | 加密保存 API 地址和密钥 |
| `GET /api/models` | `${apiBaseUrl}/v1/models` |
| `POST /api/chat/completions` | `${apiBaseUrl}/v1/chat/completions` |
| `POST /api/responses` | `${apiBaseUrl}/v1/responses` |
| `POST /api/responses/:id/cancel` | `${apiBaseUrl}/v1/responses/:id/cancel` |

可选环境变量：

| 变量 | 说明 | 默认 |
|------|------|------|
| `ZHIDA_CONFIG_SECRET` | 加密 API 密钥的服务端密钥，必须设置 | 必填 |
| `ZHIDA_CONFIG_PATH` | 加密配置文件路径 | `server/data/config.enc.json` |
| `ZHIDA_PORT` | 本地监听端口 | `3000` |
| `ZHIDA_PROXY_TIMEOUT_MS` | 代理请求超时 | `120000` |
| `ZHIDA_PROXY_MAX_BODY_BYTES` | 单次代理请求体上限 | `10485760` |

### 方式二：Docker 后端代理

```bash
git clone https://github.com/ShuaiShuai03/zhida-ai.git
cd zhida-ai

ZHIDA_CONFIG_SECRET="change-this-to-a-long-random-secret" \
docker compose -f docker-compose.proxy.yml up -d
```

访问 `http://localhost:3000`，在设置中填写 API 地址和密钥。`docker-compose.proxy.yml` 使用命名卷保存加密配置文件。

### 方式三：静态托管

你仍可以用任意静态服务器查看界面：

```bash
npx serve . -p 3000
python3 -m http.server 3000
```

但 `npx serve . -p 3000`、`python3 -m http.server 3000` 和 GitHub Pages 都只是纯静态托管。它们没有 `/api/config/status`、`PUT /api/config`、`/api/models`、`/api/chat/completions` 和 `/api/responses` 后端能力，不能安全保存或隐藏 API key，也不能直接完成模型获取、聊天、网络搜索或 Responses 取消请求。需要完整功能时，请改用 `ZHIDA_CONFIG_SECRET="..." node server/server.js` 或 `scripts/start.sh` 启动 Node 后端代理。

## 配置 API

首次使用时，点击页面右上角 **设置**，填写以下内容：

| 字段 | 说明 | 示例 |
|------|------|------|
| API 地址 | OpenAI 兼容接口基础 URL，由后端代理使用，可带或不带尾部 `/v1` | `https://api.openai.com` 或 `https://api.openai.com/v1` |
| API 密钥 | 用于服务端代理访问上游 API；保存成功后输入框清空 | `sk-...` |
| 系统提示词 | 自定义模型行为 | `你是一个严谨的代码审查助手。` |
| 温度 | 控制输出随机性 | `0.7` |
| 最大回复长度 | 限制单次回复 token 数 | `4096` |

上游 API 需要：

1. 提供 `/v1/chat/completions`。
2. 如需自动获取模型列表，还需要提供 `/v1/models`。
3. 如需使用网络搜索或 Responses 推理深度，还需要提供 `/v1/responses`。
4. 推荐支持标准 SSE 流式响应；如果服务返回 OpenAI 风格的普通 JSON 成功响应，应用会按非流式结果展示。

浏览器不会直接访问上游 API，也不会向上游发送 `Authorization`。所有上游认证都由 Node 后端使用已加密保存的配置完成。

### 网络搜索与推理深度

- 网络搜索使用 Responses API 的 `web_search` 工具。只有当前模型明确支持 Responses 时才会启用网络搜索开关。
- 如果 `/v1/models` 返回 `call_methods` / `callMethods` / `capabilities.call_methods`，应用以该字段为准；只有包含 `responses` 的模型才会允许网络搜索。
- 如果模型没有声明能力，第三方或 OpenAI-compatible 服务默认不启用 Responses / Web Search，避免把只支持 Chat Completions 的模型误发到 `/v1/responses`。
- 官方 OpenAI API 地址下的 GPT-5、GPT-4.1 和 o 系列按内置规则允许 Responses；支持推理深度的模型才会显示可用的“思考深度”控件。
- 不支持时应用不会伪造搜索、不会静默降级为普通聊天、也不会自动切换模型；发送前会阻止请求并提示用户切换支持网络搜索的模型。
- Responses 上游返回 `call_methods must include responses`、`does not support this API` 等能力错误时，后端会归一化为中文提示，并继续脱敏上游错误内容。

## 数据管理与模板

- **提示词模板**：点击输入框右侧模板按钮或侧边栏 **提示词模板**，可插入内置模板，或创建、编辑、删除自定义模板。插入模板只会填入输入框，不会自动发送。
- **对话组织**：对话支持置顶和标签；搜索会匹配标题、消息内容、模型名和标签，也可以输入 `#标签名` 进行标签筛选。
- **备份恢复**：侧边栏 **数据管理** 可导出全部本地数据为 JSON，包含对话、当前激活对话、模型选择、模型缓存、非敏感设置、自定义模板、导出版本和 BJT 导出时间。备份不包含 API 密钥。导入采用合并模式，同 ID 对话以导入文件为准。
- **清理旧对话**：可配置保留数量，应用会优先保留置顶对话，普通对话按 `updatedAt` 从旧到新删除。
- **Markdown 导出**：单对话 Markdown 导出会包含模型、BJT 创建时间、置顶状态、标签和消息数。

### 模型列表

- 默认模型定义在 [js/config.js](js/config.js)。
- 保存 API 配置后，应用会通过同源 `/api/models` 刷新模型列表。
- 设置弹窗中的 **保存配置并获取模型列表** 会先把配置加密保存到后端，再同步更新实际对话模型下拉框。
- 切换历史对话时，应用会恢复该对话保存的模型，继续发送时不会被其他对话当前选中的模型覆盖。
- 如果历史会话保存的模型已经不在当前模型列表中，界面会显示“模型不可用”，并要求重新选择可用模型；不会静默替换成当前模型。

### 文件与图片上传

支持：

- 文本/代码文件：`.txt`、`.md`、`.js`、`.ts`、`.jsx`、`.tsx`、`.py`、`.json`、`.csv`、`.html`、`.css`、`.xml`、`.yaml`、`.yml`、`.sh`、`.bat`、`.ps1`、`.sql`、`.go`、`.rs`、`.java`、`.c`、`.cpp`、`.h`、`.rb`、`.php`、`.log`、`.conf`、`.ini`、`.toml`、`.env`、`.swift`、`.kt`、`.scala`、`.r`
- 图片：`.png`、`.jpg`、`.jpeg`、`.gif`、`.webp`、`.bmp`、`.svg`

限制：

- 文本/代码文件单个不超过 `100 KB`
- 图片单个不超过 `5 MB`

支持点击上传、拖拽到输入区、以及在输入框中直接粘贴图片。

## 快捷键

| 快捷键 | 功能 |
|--------|------|
| `Enter` | 发送消息 |
| `Shift + Enter` | 换行 |
| `Ctrl/Cmd + N` | 新建对话 |
| `Ctrl/Cmd + Shift + S` | 切换侧边栏 |
| `Ctrl/Cmd + Shift + L` | 切换主题 |
| `Esc` | 关闭弹窗 / 停止生成 |
| 双击对话标题 | 重命名对话 |

## 测试与校验

本仓库提供无需额外依赖管理器的最小测试集：

```bash
# 文档和链接校验
python3 scripts/check_markdown.py

# JavaScript 语法校验
for f in js/*.js; do node --check "$f"; done

# 纯逻辑单测
node --test tests/*.test.mjs

# 可选 Node 代理语法校验
node --check server/server.js

# 浏览器 smoke（需要本机可执行 google-chrome）
bash scripts/run_smoke.sh
```

浏览器 smoke 会启动本地 Node 后端和 mock API，覆盖加密配置保存、模型获取、会话模型恢复、网络搜索禁用态、Responses `web_search`、推理深度、流式回答、停止生成、后续请求恢复、提示词模板、对话置顶/标签搜索、备份导入恢复、Markdown URL 清洗、复制内容一致性以及键盘可达性。若 Chrome 在 CI 或慢机器上需要更长时间，可设置：

```bash
CHROME_TIMEOUT=180s bash scripts/run_smoke.sh
```

## 项目结构

```text
zhida-ai/
├── index.html
├── css/
├── js/
│   ├── api.js
│   ├── app.js
│   ├── backup-utils.js
│   ├── chat.js
│   ├── config.js
│   ├── conversation-utils.js
│   ├── long-text.js
│   ├── markdown.js
│   ├── prompt-templates.js
│   ├── state.js
│   ├── storage.js
│   ├── theme.js
│   ├── ui.js
│   └── utils.js
├── assets/
├── scripts/
│   ├── check_markdown.py
│   ├── mock_api.py
│   ├── run_smoke.sh
│   ├── start.ps1
│   └── start.sh
├── server/
│   └── server.js
├── tests/
│   ├── app-features.test.mjs
│   ├── conversation-utils.test.mjs
│   ├── server.test.mjs
│   └── smoke.html
├── .github/
├── Dockerfile
├── Dockerfile.server
├── docker-compose.yml
├── docker-compose.proxy.yml
├── CONTRIBUTING.md
├── CODE_OF_CONDUCT.md
├── SECURITY.md
└── LICENSE
```

## 技术栈

| 技术 | 用途 |
|------|------|
| HTML5 + CSS3 + ES Modules | 前端应用主体 |
| [marked.js](https://github.com/markedjs/marked) | Markdown 解析 |
| [highlight.js](https://highlightjs.org/) | 代码高亮 |
| [KaTeX](https://katex.org/) | 数学公式渲染 |
| Node.js 18+ 内置 `http` / `fetch` / `crypto` | 静态服务、配置加密和 API 代理 |
| Nginx | Docker 静态部署 |
| Google Chrome Headless | 浏览器 smoke 测试 |

运行时会从 CDN 加载 `marked.js`、`highlight.js` 和 `KaTeX`。如果部署环境不能访问这些 CDN，需要自行 vendoring 或替换为可访问的静态资源。

## 常见问题

<details>
<summary><strong>Q: 为什么直接打开 index.html 后页面空白？</strong></summary>

本项目使用 ES Modules（`<script type="module">`），`file://` 协议下模块和部分浏览器能力不可用。请通过 HTTP 服务器访问，例如 `python3 -m http.server 3000`。
</details>

<details>
<summary><strong>Q: 为什么配置正确仍然请求失败？</strong></summary>

请确认你正在运行 `node server/server.js` 或 `scripts/start.sh`，并且设置了 `ZHIDA_CONFIG_SECRET`。`npx serve . -p 3000`、`python3 -m http.server 3000` 和 GitHub Pages 只是纯静态服务器，没有同源 `/api/*` 后端能力，不能保存 API key、获取模型列表或完成聊天请求。
</details>

<details>
<summary><strong>Q: 如何连接本地 Ollama？</strong></summary>

如果 Node 后端和 Ollama 在同一台机器，可将 API 地址填写为 `http://localhost:11434`，密钥可填任意值（例如 `ollama`）。如果 Node 后端部署在远程服务器，而 Ollama 只监听你本机回环地址，后端将无法连通。
</details>

<details>
<summary><strong>Q: 对话数据存在哪里？</strong></summary>

会话、模型缓存、主题和非敏感设置保存在浏览器 `localStorage` 中。API 密钥加密保存在 Node 后端的配置文件里；清除站点数据不会删除服务端加密配置。
</details>

<details>
<summary><strong>Q: 可以隐藏 API 密钥吗？</strong></summary>

可以。当前版本只支持服务端代理调用上游 API；浏览器不会持久化或向上游发送 API 密钥。需要注意的是，拥有服务器进程权限和 `ZHIDA_CONFIG_SECRET` 的人仍可解密配置，这是服务端代理模式的正常信任边界。
</details>

## 贡献

欢迎贡献。请阅读 [CONTRIBUTING.md](CONTRIBUTING.md) 了解开发约定、测试命令和提交流程。

## 许可证

[MIT License](LICENSE)
