# @magpie-community/opencode-todayai-auth

[magpie](https://usemagpie.ai) / [OpenCode](https://opencode.ai) provider 插件：**TodayAI（todayai.cn / todayai.com.cn）**。

| 供应商 id | 登录方式 | 上游 host | 模型引用 |
|---|---|---|---|
| `todayai` | ① 复用 Today CN 桌面客户端已登录账号（免验证码，推荐）② 手机验证码（+86）③ 手动粘贴 session token | `api.todayai.cn` | `todayai/<model-id>` |

## 一句话说明

TodayAI **没有** OpenAI 兼容的 `/v1/chat/completions`（在官方桌面端 10.3 MB 的 bundle 里 `completions` 出现 0 次）。
它是「异步 Agent 时间线」：`POST /v1/messages` 回 `202` 收条，回复要稍后用游标 `GET /v1/messages?after=` 拉。
本插件把这套协议**适配**成 OpenAI 的 `chat/completions`（含 SSE 伪流式），所以 magpie / OpenCode 能当普通模型用。

## 安装

```sh
# 本地路径安装
magpie plugin add ./packages/todayai

# 登录（推荐第 1 种：免费复用桌面端，不发短信、不消耗任何额度）
magpie plugin login todayai 1
magpie plugin list          # todayai (TodayAI, 2 models)  signed in as <昵称>

# 自检
magpie provider test todayai
magpie models | grep todayai
```

登录后凭据落在 magpie 的 `plugin-auth.json`（`{type:"oauth", access, refresh, expires, ...}`），
不会写进任何明文日志。

## 三种登录方式

> 登录通道全量排查（结论）：TodayAI 一共 5 条通道 —— ①桌面客户端已登录会话（本插件方式 1，免验证码）；
> ②手机验证码 `POST /api/auth/phone-number/send-otp`（方式 2）；③邮箱验证码（better-auth `email-otp`，但本账号没绑邮箱）；
> ④OAuth：`google / apple / github / microsoft`，`GET /api/auth/oauth2/authorize` 实测 302 跳转到 Google，
> 但回调固定是 `today-connector://auth/callback`，只有 Today 桌面端能接，接完只让桌面端登录 —— 所以它最终仍归到方式 1；
> ⑤手动粘贴 32 位 session token（方式 3）。magpie 是 CLI/无浏览器回调环境，因此只实现了 ①②⑤ 三条最直接可用的。

### 1. 复用 Today CN 桌面客户端（推荐，免验证码）

`magpie plugin login todayai 1`

桌面端把会话存在 `%APPDATA%/Today CN/account-credentials.slot-a`（Chromium OSCrypt：`v10` + AES-256-GCM，
密钥由 `Local State` 里的 `os_crypt.encrypted_key` 经 Windows DPAPI 解出）。本插件：

1. 只读该文件与 `Local State`，不修改、不移动、不复制到别处；
2. DPAPI 解密**仅在自己的进程内**完成（`desktop-session.mjs`，`node:crypto` + 一次 `ProtectedData::Unprotect`）；
3. 取到 32 位 better-auth session token 后换 JWT，之后按官方客户端同样的头（`X-App-Version`、`X-Client-Platform: windows-client`、`Origin`）发请求。

桌面端未登录时会明确报错并建议改用方式 2。

### 2. 手机验证码（+86）

`magpie plugin login todayai 2`

1. `POST /api/auth/phone-number/send-otp` `{phoneNumber:"+8613800138000"}` —— **必须 E.164**，裸 11 位会被拒（`INVALID_PHONE_NUMBER`）；
2. 终端提示输入短信验证码；
3. `POST /api/auth/phone-number/verify` `{phoneNumber, code}`，响应里取 `token` / `session.token` 作为 session token。

### 3. 手动粘贴 session token

`magpie plugin login todayai 3` —— 32 位 better-auth session token，适合从别处迁移登录态。

## 鉴权链路（已实测）

```
session token (32 位, better-auth)
   └─ GET https://auth.todayai.cn/api/auth/token
        Authorization: Bearer <session token>
        Origin: https://todayai.cn
      → { token: <JWT>, expiresIn }        # JWT aud=https://api.todayai.cn, 实测 TTL 600s
   └─ Authorization: Bearer <JWT>  →  https://api.todayai.cn/v1/...
```

access JWT 只有 **10 分钟**，插件在到期前 90 秒自动续期，并把新值写回 `plugin-auth.json`；
长对话中途过期也会在下一个请求前续上。

## 对话适配（关键）

- TodayAI **没有** OpenAI 那种 `/v1/chat/completions`（全 bundle 里 `completions` 出现 0 次），也**不支持 SSE**。
  真实链路是异步 Agent 时间线：`POST /v1/messages`（202 ack）→ `GET /v1/messages?threadId=&after=` 轮询。
- 本插件在 loader 里把 `/v1/chat/completions` 适配成上面这条链路，并把多轮 `messages[]` 压平成一段文本发给平台 Agent。
- 流式是**模拟的**：先拿完整回复，再拆成一个 role 帧 + 一个 content 帧 + 带 usage 的收尾帧 + `[DONE]`。
- **它不是通用 LLM 接口**：平台那端是一个有自己人设（ADE）、记忆和工具的 Agent，magpie/Codex 塞进去的
  system prompt 会被弱化甚至忽略；实测回复会带它自己的口吻（例如"我在。要继续 upupload 的提速改造就直说"）。
- 平台侧 `conversationId` 恒等于账号 id，所有调用共享**同一个会话历史**：magpie 的请求会写进你桌面端那条对话里，
  历史越长回复越容易跑偏，这是上游设计决定的，不是插件能隔离的。


```
POST /v1/messages  { message, clientMessageId:"tc:legacy:<uuid>" }   → 202 { threadId, messageId }
GET  /v1/messages?threadId=<id>&after=<cursor>                       → 回复（约 3 秒后到）
```

- 先 `PUT /v1/pricing/model-option {optionId}` 切模型，再发消息；`optionId` 形如 `model.glm-5.3`。
- 回复文本有两种形状：**v1** 顶层 `content` 是字符串；**v2** 文本在 `messages[].content.text`。插件两种都认。
- 上游**没有 SSE**：`stream:true` 时插件轮询后自己发 `chat.completion.chunk` + `[DONE]`，客户端可正常流式渲染。
- 非流式实测 ≈ 3–20 s；流式 ≈ 7–120 s（受上游 Agent 思考时间影响，偶发 200 s+）。
- `usage` 上游不给 token 数，插件按字符**本地估算**后回填，见下一节。

## 模型使用明细（magpie usage / 用量面板）

上游对**用量只做百分比计量**（`/v1/pricing/status` 的 `usage.progress` 与 `breakdown.items[].usedPercent`），
用户 API 里**完全没有** `prompt_tokens` / `completion_tokens` 这种字段（管理端 schema 才有，普通账号取不到）。
所以插件在返回给 magpie 的 OpenAI 兼容响应里补了一份**本地估算**的 usage：

| 字段 | 来源 |
|---|---|
| `prompt_tokens` | 把 system/多轮消息压平后的字符数换算（中文≈1.05 token/字，其它≈3.6 字符/token） |
| `completion_tokens` | 回复文本按同一规则换算 |
| `total_tokens` | 两者之和 |

- 非流式：直接写在 `usage` 里；流式：写在 `finish_reason:"stop"` 那一帧，并额外补一帧 `choices:[]` 的纯 usage 帧，
  与 OpenAI `stream_options.include_usage` 语义一致，magpie 能正常记账。
- 响应头带 `X-Todayai-Token-Estimate: 1`，便于自查这是估算值。
- 效果：`magpie usage today` / `magpie usage --csv today` 里 `todayai/*` 不再是 `0`，
  能看到每次调用的 in/out 与时长；但**额度百分比仍以上游为准**，两者不是同一套计量。
- 成本（`cost_usd`）保持 0：TodayAI 按"额度倍率"扣额度（DeepSeek 1×、GLM 4×），不是按 token 计费，编造金额没有意义。

## 已知模型

账号可选模型由 `GET /v1/pricing/status` 的 `modelOptions.options` 动态给出（`model.*` 前缀即 optionId）：

| 模型 id | 名称 | 额度倍率 |
|---|---|---|
| `deepseek-v4.1-flash` | DeepSeek V4.1 Flash | 1× |
| `glm-5.3` | GLM 5.3 | 4× |

`GET /v1/llm/models` 另有 34 个网关模型 id，但不都能选；插件只暴露账号真正可切换的那些。
上游改版时插件回落到内置的两条。

想改显示名（含倍率提示）可执行：

```bash
magpie model name todayai/deepseek-v4.1-flash "DeepSeek V4.1 Flash · 额度1×"
magpie model name todayai/glm-5.3 "GLM 5.3 · 额度4×"
```

## 额度

`auth.usage` → `GET /v1/pricing/status`。上游**只给百分比**，没有绝对 token 数：

```
Pro (赠送)   14% left   本月   tasks 26% · conversation 58% · scheduled_tasks 0% · daily_brief 0% · memory_updates 2% · cloud_computer 0%
resetAt 2026-11-25T11:24:06.321Z
```

`used` 由 `progress` 换算成 0–100，magpie 的额度条直接可用。

> ⚠️ 实测提醒：经 magpie 每轮对话会消耗上游 `tasks`/`conversation` 额度桶，跑 Codex 这类多轮 Agent 会掉得很快
> （实测一个晚上从 3% used 掉到 86% used）。额度按月重置（`resetAt`），重置前用完只能等。

## 账号安全 / 不触发风控

- **只复用官方会话**，不注册、不接码平台、不撞库。
- 请求头与官方桌面端一致（含 `X-App-Version`、`X-Client-Platform`、`Origin`），无自定义指纹异常。
- 每轮对话 2–3 个请求（1 次切模型 + 1 次 POST + 轮询 1–2 次），与官方客户端同量级；无并发轰炸、无重试风暴。
- 不请求 `/v3/live/*`（该域名对普通账号 403 `auth.forbidden`）、不调用任何管理接口。
- 凭据只在本地进程内解密使用，不上传、不打印。

## 故障排查

| 现象 | 原因 |
|---|---|
| `没有找到已登录的 Today CN 桌面客户端` | 桌面端未登录，或 `%APPDATA%/Today CN` 不在预期位置 → 用方式 2 |
| `magpie: EOF` | `magpie plugin login` 需要真 TTY，别用管道/重定向喂输入 |
| `s.a.callback is not a function` | `authorize()` 必须返回 `{url, instructions, method, callback}` 描述符，不能直接返回 `{type:"success"}` |
| 回复超时 | 上游 Agent 慢（实测 15–115 s）；插件默认等 180 s |
| 额度显示 `读取失败` | JWT 过期且 session token 已失效 → 重新 `magpie plugin login todayai 1` |
| `magpie usage` 里 todayai 的 token 还是 0 | 记账发生在网关里的插件进程，改了插件代码要重启它：结束 `magpie-bun.exe` 进程，下一次请求会自动拉起新代码 |
| `magpie provider test` 报 `starting plugins: context deadline exceeded` | 与本插件无关：是 `lm-detector` 等其它插件启动慢拖过了 magpie 的启动预算；单独调用网关接口正常 |

## 免责声明

非官方社区插件，与 TodayAI 无关联。协议基于对官方桌面客户端的逆向与实测，上游改版可能失效。
账号风险由使用者自行承担；请勿用于批量注册或转售额度。
