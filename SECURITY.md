# 安全策略

## 关键事实

- 本项目的聊天能力必须通过同源 Node 后端代理访问上游 API。
- API 密钥不会保存在浏览器 `localStorage`、备份 JSON 或前端请求头中。
- 在设置中填写的 API 地址和密钥只会提交到同源后端；后端使用 `ZHIDA_CONFIG_SECRET` 派生的 AES-256-GCM 密钥加密保存到本地配置文件。
- 纯静态托管和 GitHub Pages 不能隐藏 API 密钥，也不能作为可直接调用 API 的安全部署形态。
- 应用使用自定义 HTML 清洗器处理 AI 返回的内容，但不能保证 100% 防御所有 XSS 攻击向量。

这意味着：

1. 生产部署必须设置足够长且随机的 `ZHIDA_CONFIG_SECRET`。
2. 请使用 HTTPS 部署，避免 API 配置提交过程被中间人观察。
3. 服务器进程权限和 `ZHIDA_CONFIG_SECRET` 属于信任边界；拥有二者的人可以解密本地配置文件。
4. 不要提交 `server/data/config.enc.json`、`.env` 或任何包含密钥的本地配置。
5. 如果你的 API 可能返回不可信内容，请自行评估风险。

## 报告漏洞

请不要在公开 Issue 中披露安全漏洞细节。

优先使用以下私密渠道：

1. GitHub Private vulnerability reporting：
   `https://github.com/ShuaiShuai03/zhida-ai/security/advisories/new`
2. 如果上面的入口不可用，请通过仓库所有者 GitHub 主页联系维护者：
   `https://github.com/ShuaiShuai03`

报告时请尽量包含：

- 影响范围
- 复现步骤
- 触发条件
- 浏览器 / 部署环境
- 相关请求与响应样本

## 支持范围

当前仓库没有维护独立的 release 分支或历史安全分支。

| 分支 / 版本 | 状态 |
|-------------|------|
| `main` | 支持 |
| 历史提交快照 | 不承诺提供补丁 |
