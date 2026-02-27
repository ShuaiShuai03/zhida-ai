# 贡献指南

感谢你对 **智答 AI** 项目的关注！我们欢迎所有形式的贡献。

## 如何贡献

### 报告 Bug

1. 在 [Issues](../../issues) 中搜索是否已存在相同问题。
2. 如果没有，请使用 **Bug 报告** 模板创建新 Issue。
3. 提供尽可能详细的复现步骤和浏览器信息。

### 提出新功能

1. 使用 **功能请求** 模板创建 Issue。
2. 描述你希望解决的问题以及建议的方案。

### 提交代码

1. Fork 本仓库并创建你的分支（`git checkout -b feature/my-feature`）。
2. 进行更改并确保代码风格一致。
3. 测试你的更改在最新版 Chrome、Firefox 和 Safari 中正常工作。
4. 提交 Pull Request，使用清晰的描述说明所做更改。

## 开发环境

本项目是纯前端静态应用，无需构建工具。启动本地开发：

```bash
# 方式一：Python
python3 -m http.server 3000

# 方式二：Node.js
npx serve . -p 3000
```

然后打开 `http://localhost:3000`。

## 代码规范

- 使用 2 空格缩进。
- 使用 ES Modules（`import` / `export`）。
- 函数和复杂逻辑添加 JSDoc 注释。
- CSS 类名遵循 BEM 命名约定。
- 用户可见文本使用简体中文。

## 提交信息格式

```
<类型>: <简短描述>

[可选正文]
```

类型包括：`feat`（新功能）、`fix`（修复）、`docs`（文档）、`style`（样式）、`refactor`（重构）、`perf`（性能）、`chore`（杂项）。

## 行为准则

参与本项目即表示你同意遵守我们的 [行为准则](CODE_OF_CONDUCT.md)。
