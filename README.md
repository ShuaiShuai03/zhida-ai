# 智答 AI — 智能对话助手

[![CI](https://github.com/ShuaiShuai03/zhida-ai/actions/workflows/ci.yml/badge.svg)](https://github.com/ShuaiShuai03/zhida-ai/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

一个纯前端、零构建依赖的 AI 对话 Web 应用，支持 OpenAI 兼容 Chat Completions API、实时流式响应、多模型切换、思考过程展示和本地会话管理。

> **安全与隐私说明**
> 
> 这是浏览器直连 API 的纯前端应用：
> - API 密钥保存在浏览器 `localStorage` 中，不会发送到本仓库或第三方服务器
> - 当你发送消息或获取模型列表时，密钥会直接从浏览器发送到你配置的 API 服务
> - 本仓库不包含服务端代理，无法替你隐藏密钥
> - 你使用的 API 必须能被浏览器直接访问，并正确开启 CORS
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
| **模型** | 默认模型列表、自定义模型、每个对话保留独立模型、保存后自动刷新模型、手动获取模型列表 |
| **内容** | Markdown / 代码高亮 / LaTeX、思考模型 `reasoning_content` / `<think>` 展示 |
| **管理** | 对话搜索、双击重命名、删除、清空全部、Markdown 导出 |
| **输入** | 文本输入、图片上传、代码/文本文件上传、拖拽文件、粘贴图片 |
| **体验** | 深浅色主题、响应式布局、快捷键、系统提示词、温度与最大回复长度设置 |
| **部署** | 本地静态服务器、Docker、GitHub Pages / 任意静态托管 |

## 快速开始

### 方式一：本地启动

```bash
git clone https://github.com/ShuaiShuai03/zhida-ai.git
cd zhida-ai

# macOS / Linux
bash scripts/start.sh

# Windows PowerShell
powershell -ExecutionPolicy Bypass -File scripts\start.ps1
```

或者手动启动任意静态文件服务器：

```bash
# Python（需 3.x）
python3 -m http.server 3000

# Node.js
npx serve . -p 3000
```

打开 `http://localhost:3000`，点击右上角 **设置**，填入 API 地址和密钥后开始对话。

### 方式二：Docker

```bash
git clone https://github.com/ShuaiShuai03/zhida-ai.git
cd zhida-ai
docker compose up -d
```

访问 `http://localhost:3000`。

### 方式三：GitHub Pages / 静态托管

1. Fork 本仓库。
2. 通过 GitHub Pages 或任意静态文件托管服务发布仓库根目录。
3. 打开部署后的页面，配置你的 API。

适用前提：目标 API 必须允许从部署域名发起浏览器跨域请求。仓库本身不提供反向代理或服务端密钥保护。

## 配置 API

首次使用时，点击页面右上角 **设置**，填写以下内容：

| 字段 | 说明 | 示例 |
|------|------|------|
| API 地址 | 浏览器可直接访问、且开启 CORS 的 OpenAI 兼容接口基础 URL | `https://api.openai.com` |
| API 密钥 | 用于身份验证的密钥 | `sk-...` |
| 系统提示词 | 自定义模型行为 | `你是一个严谨的代码审查助手。` |
| 温度 | 控制输出随机性 | `0.7` |
| 最大回复长度 | 限制单次回复 token 数 | `4096` |

支持前提不是“任何 OpenAI 兼容 API”，而是：

1. 提供 `/v1/chat/completions`。
2. 如需自动获取模型列表，还需要提供 `/v1/models`。
3. 浏览器端请求必须被该服务允许，尤其是 CORS、认证头和 SSE。
4. 推荐支持标准 SSE 流式响应；如果服务返回 OpenAI 风格的普通 JSON 成功响应，应用会按非流式结果展示。

### 模型列表

- 默认模型定义在 [js/config.js](js/config.js)。
- 保存 API 配置后，应用会自动请求 `/v1/models` 刷新模型列表。
- 设置弹窗中的 **获取模型列表** 只会校验当前表单配置，不会在未保存时污染当前运行配置。
- 切换历史对话时，应用会恢复该对话保存的模型，继续发送时不会被其他对话当前选中的模型覆盖。

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

# 浏览器 smoke（需要本机可执行 google-chrome）
bash scripts/run_smoke.sh
```

浏览器 smoke 会启动本地静态服务器和 mock API，覆盖设置保存、模型获取、会话模型恢复、流式回答、停止生成、后续请求恢复、Markdown URL 清洗、复制内容一致性以及键盘可达性。若 Chrome 在 CI 或慢机器上需要更长时间，可设置：

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
│   ├── chat.js
│   ├── config.js
│   ├── conversation-utils.js
│   ├── markdown.js
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
├── tests/
│   ├── conversation-utils.test.mjs
│   └── smoke.html
├── .github/
├── Dockerfile
├── docker-compose.yml
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

最常见原因是 CORS。该应用从浏览器直接访问你的 API，因此目标服务必须允许当前页面域名发起跨域请求，并允许 `Authorization` 等请求头及 SSE 响应。
</details>

<details>
<summary><strong>Q: 如何连接本地 Ollama？</strong></summary>

如果浏览器所在机器可以直接访问 Ollama，可将 API 地址填写为 `http://localhost:11434`，密钥可填任意值（例如 `ollama`）。如果页面部署在远程域名，而 Ollama 只监听你本机回环地址，浏览器端将无法直接连通。
</details>

<details>
<summary><strong>Q: 对话数据存在哪里？</strong></summary>

会话、模型缓存、主题和设置都保存在浏览器 `localStorage` 中。清除站点数据会丢失这些内容；密钥不会自动同步到其他设备。
</details>

<details>
<summary><strong>Q: 可以隐藏 API 密钥吗？</strong></summary>

不能。只要是纯前端浏览器直连，密钥就必须由浏览器持有并发送到目标 API。如果你需要真正隐藏密钥，应在你自己的服务端提供代理。
</details>

## 贡献

欢迎贡献。请阅读 [CONTRIBUTING.md](CONTRIBUTING.md) 了解开发约定、测试命令和提交流程。

## 许可证

[MIT License](LICENSE)
