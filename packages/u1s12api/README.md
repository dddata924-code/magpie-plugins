# u1s12api

把本机已登录的 u1s1 CLI 接入 Magpie 的文本模型插件。模型请求由官方 CLI 发出；插件提供登录、用量展示及 OpenAI Chat Completions 文本适配。

**运行前提**：已安装并登录 u1s1 CLI，Node.js ≥ 22.19.0。本次验证使用 CLI 1.11.2、Node 24.22.0 和 Magpie 0.1.3005。当前调用共用本机 CLI 登录态，不是多账号凭证隔离实现。

## 安装与更新

1. 安装官方 CLI 并运行 `u1s1 login`。
2. 在 Magpie「插件」页添加本目录。
3. 添加 u1s12api 账号，选择「本机 u1s1 CLI 登录态」或浏览器设备授权。
4. 文件更新后，在 Magpie 插件页关闭再开启本插件，让宿主重新加载代码。
5. 通过 Magpie 网关选择 `u1s12api/deepseek-flash`、`u1s12api/qwen3.8-flash` 或 `u1s12api/glm-5.3-flash`。

CLI 可通过 `U1S1_CLI_DIST` 指定其包含 `index.js` 的 dist 目录；默认搜索 Scoop、npm 全局目录和 u1s1 桌面安装目录。

## 验证

离线回归测试使用本地子进程 fixture，不调用模型：

```bash
npm test
```

真实验收通过已经运行的 Magpie HTTP 网关，不直接导入插件，不使用 fixture：

```bash
node magpie-smoke.mjs
```

默认网关是 `http://127.0.0.1:3425`。启用了网关密钥验证时通过 `MAGPIE_API_KEY` 提供密钥；也可使用 `MAGPIE_BASE_URL` 和 `MAGPIE_MODEL` 指定网关和模型。脚本执行两个重叠请求、超长中文/引号输入以及 SSE 请求，要求非空内容、预期标记和终止帧；原始响应与结果保存在 [artifacts](./artifacts/) 中。真实测试会消耗账号额度。

## 请求和额度行为

- 每个请求创建独立 CLI print-mode 进程；不共用 worker，不把前一请求的取消状态带入下一请求。
- 提示词通过 stdin 传递，而非 Windows 命令行参数；参数固定包含 `-p --no-session --no-tools` 和所选 `--model`。
- 提示词保留文本历史，包括 assistant 回合；输入超过 24,000 字符时截取最近内容，并尽量保留最后一个用户回合。超长单回合保留尾部。这是上下文预算，不是 CLI argv 传输限制。
- 取消和十分钟超时终止对应子进程；空输出、非零退出和上游错误按失败处理。
- 流式调用转发 CLI stdout，补充 `finish_reason: stop` 与 `[DONE]`。流式粒度取决于 CLI 的 stdout 输出方式。
- 用量按套餐种类、scope、每日/总量及耗尽状态分组；`amount` 表示已消耗量，`display` 明示剩余量。
- 存在可用套餐或现金余额时，已耗尽套餐标记 `aside: true`，不阻断仍可消费的账号；所有已知套餐与现金均耗尽时保留阻断用量窗口。
- 会话里的「输入 / 输出」token 是本地估算（CLI print 模式不返回用量），输入按请求体字符、输出按回复字符（CJK 按 1 字 1 token、其余按 4 字符 1 token）粗估，用于展示；**实际扣费以 u1s1 服务端为准**。
- 本版是文本桥接：图片转为说明文字，API 工具调用、temperature/max_tokens 等生成参数尚未映射到 CLI。测试覆盖文本聊天，不代表完整多模态或工具协议兼容。

## 登录与签到

登录凭证与官方 CLI 共用 `~/.u1s1/config.json`。签到是原有独立功能，依赖网站登录态与服务端规则；本次传输修复及真实验收不调用签到、不改变签到开关。网站登录态的获取方式见 [login-once.mjs](./login-once.mjs)。

## 0.2.2 修复

- 响应补上 token usage：CLI print 模式不返回用量，本版按请求体与回复文本估算 `prompt_tokens` / `completion_tokens` / `total_tokens`，Magpie 会话里的「输入 / 输出」不再显示 0；流式在终止帧携带同一 usage。
- 工具调用解析容错：被 CLI 截断的 `<tool_call>` 尾巴按尾部残片剥离，不再整请求失败（此前日志里的 `connection lost mid-reply (incomplete external tool call)`）；`<tool_call>` 内嵌散文时按对象 JSON 抢救；不可解析块保留为普通文本。

## 0.2.1 修复

- 修复全局 worker 导致的并发 busy，以及取消后的跨请求状态污染。
- 使用 stdin 解决 `ENAMETOOLONG`；修复零历史预算时截断失效。
- 传递模型选择、保留 assistant 文本、补齐 SSE 终止信息。
- 修正额度 consumed/remaining 语义和全部耗尽时的路由行为。
- 增加真实子进程回归及 Magpie 网关验收脚本。

## 参考

- [Magpie 插件手册](https://usemagpie.ai/docs/zh/plugins)
- [Magpie 社区插件](https://github.com/magpie-community/plugins)
- [u1s1](https://u1s1app.com)
