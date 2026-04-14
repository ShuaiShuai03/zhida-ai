# 贡献指南

感谢你关注 **智答 AI**。本仓库是静态前端应用，但包含浏览器行为、文档和最小自动化测试；提交前请同时关注实现与说明的一致性。

## 报告问题

### Bug

1. 先在 [Issues](https://github.com/ShuaiShuai03/zhida-ai/issues) 中搜索是否已有相同问题。
2. 没有重复项时，使用 **Bug 报告** 模板创建 Issue。
3. 请尽量提供以下信息：
   - 复现步骤
   - 浏览器与系统版本
   - 部署方式（本地静态服务器 / Docker / GitHub Pages / 其他）
   - API 提供商、Base URL、所选模型
   - Console 报错、Network 截图、是否为 CORS 问题

### 功能请求

1. 使用 **功能请求** 模板创建 Issue。
2. 说明你想解决的痛点、预期行为以及替代方案。

## 提交代码

1. Fork 本仓库并创建分支，例如 `git checkout -b fix/stream-abort-state`。
2. 修改代码时请同步更新受影响的文档、帮助文案和模板。
3. 提交前运行本仓库提供的校验命令。
4. 发起 Pull Request，并清楚说明问题、修复思路和验证方式。

## 本地开发

本项目运行时不依赖构建工具；你只需要一个静态文件服务器：

```bash
# 方式一：项目脚本
bash scripts/start.sh

# 方式二：Python
python3 -m http.server 3000

# 方式三：Node.js
npx serve . -p 3000
```

然后打开 `http://localhost:3000`。

## 提交前检查

```bash
# Markdown 链接和占位符校验
python3 scripts/check_markdown.py

# JavaScript 语法检查
for f in js/*.js; do node --check "$f"; done

# 纯逻辑单测
node --test tests/*.test.mjs

# 浏览器 smoke（需要本机安装 google-chrome）
bash scripts/run_smoke.sh
```

如果你的改动影响 UI，请至少手工确认：

- Chrome
- Firefox
- Safari（如改动影响跨浏览器行为）
- 移动端布局
- 深浅色主题
- 无 Console 错误

## 代码约定

- 使用 2 空格缩进。
- 使用 ES Modules（`import` / `export`）。
- 新增或修改的复杂逻辑写清楚 JSDoc。
- 用户可见文本默认使用简体中文。
- 不要写死只适用于单一 API 提供商的行为。
- 修改实现时，不要遗漏 README、设置文案、Issue/PR 模板等配套文档。

## 提交信息格式

```text
<type>: <summary>

[optional body]
```

推荐 `type`：`feat`、`fix`、`docs`、`style`、`refactor`、`perf`、`test`、`chore`

## 行为准则

参与本项目即表示你同意遵守 [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)。
