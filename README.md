# 智答 AI — 智能对话助手

[![CI](../../actions/workflows/ci.yml/badge.svg)](../../actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

一个功能完整、设计精美的 AI 对话 Web 应用。纯前端架构，零构建依赖，支持任何 OpenAI 兼容 API、多模型切换、深度思考推理和实时流式响应。

> **安全提示：** API 密钥仅存储在你的浏览器 `localStorage` 中，不会上传到任何服务器。

---

## 功能特性

| 分类 | 功能 |
|------|------|
| **对话** | 多轮上下文记忆、SSE 实时流式输出、Markdown / 代码高亮 / LaTeX 公式渲染 |
| **模型** | 多模型自由切换、思考模型推理过程展示（`reasoning_content` + `<think>` 标签） |
| **管理** | 对话搜索、重命名（双击标题）、删除、Markdown 导出 |
| **体验** | 深色/浅色主题、响应式移动端适配、快捷键、自定义系统提示词与温度 |
| **安全** | HTML 白名单消毒防 XSS、API 密钥浏览器本地存储、无服务端依赖 |

## 快速开始

### 方式一：本地启动（推荐）

```bash
git clone https://github.com/your-username/zhida-ai.git
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

打开 `http://localhost:3000` → 点击右上角 **设置** → 填入你的 API 地址和密钥 → 开始对话。

### 方式二：Docker

```bash
git clone https://github.com/your-username/zhida-ai.git
cd zhida-ai
docker compose up -d
```

访问 `http://localhost:3000`。

### 方式三：直接部署到 GitHub Pages

1. Fork 本仓库。
2. 进入仓库 Settings → Pages → Source 选择 `main` 分支 `/ (root)`。
3. 等待部署完成后访问 `https://<你的用户名>.github.io/zhida-ai/`。

## 配置 API

首次使用时，点击页面右上角 **设置** 按钮，填写：

| 字段 | 说明 | 示例 |
|------|------|------|
| API 地址 | OpenAI 兼容接口的基础 URL | `https://api.openai.com` |
| API 密钥 | 对应服务的身份验证密钥 | `sk-...` |

支持任何 OpenAI 兼容 API（OpenAI、通义千问、DeepSeek、Moonshot、本地 Ollama 等）。

### 自定义模型列表

编辑 `js/config.js` 中的 `MODELS` 数组即可添加、移除或修改模型：

```javascript
export const MODELS = [
  {
    id: 'gpt-4o',           // API 模型 ID
    name: 'GPT-4o',         // 显示名称
    badge: '🌟 旗舰',       // 标签文字
    badgeClass: 'badge--premium',
    type: 'standard',       // 'standard' 或 'thinking'
    description: 'OpenAI 旗舰模型',
  },
  // ...
];
```

## 快捷键

| 快捷键 | 功能 |
|--------|------|
| `Enter` | 发送消息 |
| `Shift + Enter` | 换行 |
| `Ctrl/Cmd + N` | 新建对话 |
| `Ctrl/Cmd + Shift + S` | 切换侧边栏 |
| `Ctrl/Cmd + Shift + L` | 切换深色/浅色模式 |
| `Esc` | 关闭弹窗 / 停止生成 |
| 双击对话标题 | 重命名对话 |

## 项目结构

```
zhida-ai/
├── index.html              # 主页面
├── css/
│   ├── variables.css       # CSS 变量、主题 Token
│   ├── base.css            # 重置样式
│   ├── layout.css          # 布局、侧边栏、头部
│   ├── components.css      # 按钮、弹窗、表单
│   ├── chat.css            # 消息气泡、代码块
│   ├── animations.css      # 动画关键帧
│   └── responsive.css      # 响应式断点
├── js/
│   ├── config.js           # 默认配置、模型定义
│   ├── state.js            # 响应式状态管理
│   ├── api.js              # API 通信、SSE 流式解析
│   ├── chat.js             # 对话逻辑
│   ├── ui.js               # DOM 操作、组件渲染
│   ├── storage.js          # localStorage 持久化
│   ├── markdown.js         # Markdown + 代码高亮 + KaTeX
│   ├── theme.js            # 主题切换
│   ├── utils.js            # 工具函数
│   └── app.js              # 入口、事件绑定
├── assets/
│   └── favicon.svg
├── scripts/
│   ├── start.sh            # macOS/Linux 启动脚本
│   └── start.ps1           # Windows 启动脚本
├── Dockerfile              # Docker 镜像构建
├── docker-compose.yml      # Docker 一键启动
├── .github/
│   ├── workflows/ci.yml    # CI 流水线
│   ├── ISSUE_TEMPLATE/     # Issue 模板
│   └── PULL_REQUEST_TEMPLATE.md
├── CONTRIBUTING.md          # 贡献指南
├── CODE_OF_CONDUCT.md       # 行为准则
├── SECURITY.md              # 安全策略
└── LICENSE                  # MIT 许可证
```

## 技术栈

| 技术 | 用途 |
|------|------|
| HTML5 + CSS3 + ES2024+ | 纯前端，零框架依赖 |
| [marked.js](https://github.com/markedjs/marked) | Markdown 解析 |
| [highlight.js](https://highlightjs.org/) | 代码语法高亮 |
| [KaTeX](https://katex.org/) | 数学公式渲染 |
| Nginx (Docker) | 生产部署 Web 服务器 |

## 常见问题

<details>
<summary><strong>Q: 为什么打开 index.html 后页面空白？</strong></summary>

本项目使用 ES Modules（`<script type="module">`），浏览器的 `file://` 协议不支持模块加载。你必须通过 HTTP 服务器访问，例如 `python3 -m http.server 3000`。
</details>

<details>
<summary><strong>Q: 如何连接本地 Ollama？</strong></summary>

在设置中将 API 地址填写为 `http://localhost:11434`，API 密钥可填任意值（如 `ollama`）。确保 Ollama 已启动并提供 OpenAI 兼容接口。
</details>

<details>
<summary><strong>Q: 对话数据存在哪里？</strong></summary>

所有数据保存在浏览器 `localStorage` 中。清除浏览器数据会丢失对话记录。建议定期使用导出功能备份重要对话。
</details>

<details>
<summary><strong>Q: 如何部署到自己的服务器？</strong></summary>

使用 Docker：`docker compose up -d`。或将所有文件复制到任意 Web 服务器（Nginx/Apache/Caddy）的静态文件目录中。
</details>

## 贡献

欢迎贡献！请阅读 [贡献指南](CONTRIBUTING.md) 了解详情。

## 许可证

[MIT License](LICENSE) — 自由使用、修改和分发。
