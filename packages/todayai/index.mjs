/**
 * magpie provider plugin for TodayAI (todayai.cn / todayai.com.cn).
 *
 * TodayAI exposes NO OpenAI-compatible chat API. It is an async agent
 * timeline: POST /v1/messages returns a 202 ack, and the assistant reply is
 * pulled later from the thread. This plugin adapts that into an
 * OpenAI-compatible /chat/completions endpoint for magpie.
 *
 * Auth: better-auth session token -> short-lived JWT (600 s).
 * Reuses the already signed-in Today CN desktop client when available.
 */
import { randomUUID } from "node:crypto"
import { readDesktopSession, mintAccessToken } from "./desktop-session.mjs"

const AUTH_HOST = "https://auth.todayai.cn"
const API_HOST = "https://api.todayai.cn"
const WEB_ORIGIN = "https://todayai.cn"
const BASE_PATH = "/v1"
const OIDC_CLIENT_ID = "Bh2VwEojzfuJw4kBGuLQf3wxGEoupUnx"
const OAUTH_REDIRECT_URI = "today-connector://auth/callback"
const TOKEN_AUDIENCE = "https://api.todayai.cn"
const CLIENT_VERSION = "1.23.0"
const PROVIDER_ID = "todayai"

const REFRESH_MARGIN_MS = 90_000
const DEFAULT_EXPIRES_IN = 540
const CHAT_TIMEOUT_MS = 180_000
const POLL_INTERVAL_MS = 1200
const POLL_TIMEOUT_MS = 12_000

const PREFERRED_MODELS = [
  { id: "deepseek-v4.1-flash", name: "DeepSeek V4.1 Flash · 额度 1×" },
  { id: "glm-5.3", name: "GLM 5.3 · 额度 4×" },
]

const DEBUG_LOG = String(process.env.TODAYAI_DEBUG || "").trim() !== ""

// TodayAI 的用户 API 不返回任何 token 计数（/v1/pricing/status 只有百分比），
// 所以这里的 in/out 是按字符估算的，用于让 magpie 的 usage 面板有数字可看。
// 规则：CJK/全角字符 ≈ 1 token/字，其它字符 ≈ 3.6 字符/token，偏保守。
function estimateTokens(text) {
  if (!text) return 0
  const s = String(text)
  let cjk = 0
  let other = 0
  for (const ch of s) {
    const cp = ch.codePointAt(0)
    const wide =
      (cp >= 0x1100 && cp <= 0x11ff) ||
      (cp >= 0x2e80 && cp <= 0x9fff) ||
      (cp >= 0xa960 && cp <= 0xa97f) ||
      (cp >= 0xac00 && cp <= 0xd7af) ||
      (cp >= 0xf900 && cp <= 0xfaff) ||
      (cp >= 0xfe30 && cp <= 0xfe4f) ||
      (cp >= 0xff00 && cp <= 0xffef) ||
      (cp >= 0x20000 && cp <= 0x2fa1f)
    if (wide) cjk += 1
    else other += 1
  }
  return Math.max(1, Math.round(cjk * 1.05 + other / 3.6))
}

function usageFor(promptText, replyText) {
  const prompt = estimateTokens(promptText)
  const completion = estimateTokens(replyText)
  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: prompt + completion,
    prompt_tokens_details: { cached_tokens: 0 },
    completion_tokens_details: { reasoning_tokens: 0 },
  }
}

function dbg(label, extra) {
  if (!DEBUG_LOG) return
  const suffix = extra === undefined ? "" : ` ${typeof extra === "string" ? extra : JSON.stringify(extra)}`
  process.stderr.write(`[todayai ${new Date().toISOString()}] ${label}${suffix}\n`)
}

function baseHeaders(extra = {}) {
  return {
    Accept: "application/json",
    Origin: WEB_ORIGIN,
    "User-Agent": "TodayCN/1.23.0",
    "X-App-Version": CLIENT_VERSION,
    "X-Client-Platform": "windows-client",
    ...extra,
  }
}

async function request(url, { method = "GET", body, headers = {}, sessionToken, signal } = {}) {
  const finalHeaders = baseHeaders(headers)
  if (body !== undefined) finalHeaders["Content-Type"] = "application/json"
  if (sessionToken) finalHeaders.Authorization = `Bearer ${sessionToken}`
  const response = await fetch(url, {
    method,
    headers: finalHeaders,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal,
  })
  const text = await response.text()
  let payload = null
  if (text) {
    try {
      payload = JSON.parse(text)
    } catch {
      payload = { raw: text }
    }
  }
  return { status: response.status, ok: response.ok, payload, headers: response.headers }
}

function unwrap(payload) {
  if (!payload || typeof payload !== "object") return payload
  if (payload.success === false) {
    const err = new Error(payload.message || payload.code || "TodayAI request failed")
    err.code = payload.code
    err.status = 400
    throw err
  }
  if (payload.data !== undefined && payload.success === true) return payload.data
  return payload
}

async function callApi(path, options = {}, access) {
  const res = await request(`${API_HOST}${path}`, { ...options, sessionToken: access })
  if (!res.ok) {
    const message = res.payload?.message || res.payload?.error?.message || res.payload?.code || `HTTP ${res.status}`
    const err = new Error(`TodayAI ${path} failed: ${message}`)
    err.status = res.status
    err.code = res.payload?.code
    throw err
  }
  return unwrap(res.payload)
}

async function callAuth(path, options = {}) {
  const res = await request(`${AUTH_HOST}${path}`, options)
  if (!res.ok) {
    const message = res.payload?.message || res.payload?.code || `HTTP ${res.status}`
    const err = new Error(`TodayAI auth failed: ${message}`)
    err.status = res.status
    err.code = res.payload?.code
    throw err
  }
  return res.payload
}

function decodeJwtExpiry(token) {
  if (typeof token !== "string") return null
  const parts = token.split(".")
  if (parts.length !== 3) return null
  try {
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"))
    if (typeof payload.exp === "number") return payload.exp * 1000
  } catch {
    // not a JWT
  }
  return null
}

/** Exchange a better-auth session token for a short-lived API JWT. */
async function mintAccess(sessionToken) {
  const payload = await callAuth("/api/auth/token", {
    sessionToken,
    headers: { Origin: WEB_ORIGIN, "X-Client-Platform": "windows-client" },
  })
  const access = payload?.token
  if (!access) throw new Error("TodayAI did not return an access token")
  const expiresIn = Number(payload?.expiresIn ?? payload?.expires_in ?? DEFAULT_EXPIRES_IN) || DEFAULT_EXPIRES_IN
  const jwtExpiry = decodeJwtExpiry(access)
  const expiresAt = jwtExpiry ?? Date.now() + expiresIn * 1000
  return { access, expiresIn, expiresAt }
}

function authSession(token, extra = {}) {
  return { type: "oauth", access: token, refresh: token, expires: Date.now() + DEFAULT_EXPIRES_IN * 1000, ...extra }
}

function normalizePhone(raw) {
  const digits = String(raw || "").replace(/[^\d]/g, "")
  if (!/^1\d{10}$/.test(digits)) {
    throw new Error("请输入 11 位中国大陆手机号（例如 13800138000）")
  }
  return `+86${digits}`
}

async function readProfile(access) {
  const payload = await callApi("/v1/users/me", {}, access)
  return payload || {}
}

async function describeIdentity(access, fallback = {}) {
  let profile = null
  try {
    profile = await readProfile(access)
  } catch {
    profile = null
  }
  const displayName = profile?.preferredName || fallback.displayName || fallback.email || "TodayAI user"
  return {
    label: displayName,
    email: profile?.email || fallback.email,
    uid: profile?.id || fallback.uid,
    avatarUrl: profile?.avatarUrl || fallback.avatarUrl,
  }
}

async function readPricingStatus(access) {
  const payload = await callApi("/v1/pricing/status", {}, access)
  return payload?.status || payload || {}
}

async function listSelectableModels(access) {
  let status = null
  try {
    status = await readPricingStatus(access)
  } catch {
    status = null
  }
  const options = Array.isArray(status?.modelOptions?.options) ? status.modelOptions.options : []
  const selectable = options
    .filter((o) => typeof o?.id === "string" && o.id.startsWith("model."))
    .map((o) => ({
      id: o.id.slice("model.".length),
      name: o.display?.title || o.display?.description || o.id.slice("model.".length),
      note: o.display?.tagText || o.display?.tailNote || undefined,
      optionId: o.id,
    }))
  if (selectable.length) return { models: selectable, selected: status?.modelOptions?.selectedOptionId, status }
  return {
    models: PREFERRED_MODELS.map((m) => ({ ...m, optionId: `model.${m.id}` })),
    selected: status?.modelOptions?.selectedOptionId,
    status,
  }
}

async function selectModel(access, optionId) {
  try {
    await callApi("/v1/pricing/model-option", { method: "PUT", body: { optionId } }, access)
    return true
  } catch {
    return false
  }
}

function formatTokens2(n) {
  if (!Number.isFinite(n)) return "0"
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`
  return String(Math.round(n))
}

function planLabel(status) {
  const plan = String(status?.plan || "").toUpperCase()
  const state = status?.subscriptionState
  if (plan === "PRO") return state === "active" ? "Pro" : "Pro (赠送)"
  if (plan === "ULTRA") return "Ultra"
  if (plan === "FREE") return "Free"
  return plan || "TodayAI"
}

function formatUsage(status) {
  const usage = status?.usage || {}
  const progress = Number(usage.progress)
  const usedPercent = Number.isFinite(progress) ? Math.max(0, Math.min(100, progress)) : 0
  const leftText = usage.progressText || `${Math.max(0, 100 - usedPercent)}% left`
  const windows = [
    {
      name: planLabel(status),
      used: usedPercent,
      display: leftText,
      aside: usage.period === "monthly" ? "本月" : usage.period || undefined,
    },
  ]
  const items = Array.isArray(usage.breakdown?.items) ? usage.breakdown.items : []
  if (items.length) {
    windows[0].detail = items
      .slice(0, 6)
      .map((item) => `${item.label || item.key || "?"} ${Number(item.usedPercent ?? 0)}%`)
      .join(" · ")
  }
  if (usage.resetAt || status?.currentPeriodEndAt) {
    const resetAt = usage.resetAt || status?.currentPeriodEndAt
    const date = new Date(resetAt)
    if (!Number.isNaN(date.getTime())) windows[0].resetAt = date.toISOString()
  }
  return { windows }
}

/* ------------------------------------------------------------------ */
/* OpenAI-compatible adapter over the TodayAI agent timeline           */
/* ------------------------------------------------------------------ */

function flattenMessages(messages) {
  if (!Array.isArray(messages) || !messages.length) return ""
  const system = []
  const turns = []
  for (const message of messages) {
    const role = message?.role || "user"
    const content = messageContentToText(message?.content)
    if (!content) continue
    if (role === "system") system.push(content)
    else if (role === "assistant") turns.push(`Assistant: ${content}`)
    else turns.push(`User: ${content}`)
  }
  const body = turns.join("\n\n")
  if (system.length) {
    return `${system.join("\n\n")}\n\n${body}`.trim()
  }
  return body.trim()
}

function messageContentToText(content) {
  if (typeof content === "string") return content
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part
        if (part?.type === "text" || part?.type === "input_text") return part.text || ""
        if (part?.messageType === "text") return part?.content?.text || ""
        if (part?.type === "image_url") return "[image omitted]"
        return ""
      })
      .filter(Boolean)
      .join("\n")
  }
  if (content && typeof content === "object") {
    if (typeof content.text === "string") return content.text
    if (Array.isArray(content.parts)) return messageContentToText(content.parts)
  }
  return ""
}

/**
 * Normalise one timeline item into text.
 * v1 items carry `content` (string, or an object for cards).
 * v2 items carry `messages: [{ messageType, content: { text } }]`.
 */
function timelineItemText(item) {
  if (!item || typeof item !== "object") return ""
  if (Array.isArray(item.messages)) {
    const text = messageContentToText(item.messages)
    if (text) return text
  }
  const direct = messageContentToText(item.content)
  if (direct) return direct
  if (item.body) return messageContentToText(item.body)
  return ""
}

function threadAssistantText(messages) {
  if (!Array.isArray(messages)) return ""
  const parts = []
  for (const message of messages) {
    if (message?.role !== "assistant") continue
    if (message?.state && message.state !== "completed") continue
    if (message?.isFinal === false) continue
    const text = timelineItemText(message)
    if (text) parts.push(text)
  }
  return parts.join("\n").trim()
}

async function fetchThreadMessages(access, threadId, signal) {
  // v1 is the documented legacy shape with a flat `content` string; v2 gives
  // typed parts plus state/isFinal. Prefer v1, fall back to v2.
  const attempts = [
    () => callApi(`/v1/messages?threadId=${encodeURIComponent(threadId)}`, { signal }, access),
    () => callApi(`/v2/messages?threadId=${encodeURIComponent(threadId)}&limit=50`, { signal }, access),
  ]
  let lastError = null
  for (const attempt of attempts) {
    try {
      const payload = await attempt()
      const list = Array.isArray(payload?.messages)
        ? payload.messages
        : Array.isArray(payload?.data)
          ? payload.data
          : Array.isArray(payload)
            ? payload
            : []
      if (list.length) return list
    } catch (error) {
      lastError = error
    }
  }
  if (lastError) throw lastError
  return []
}

const sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError())
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(abortError())
    }
    signal?.addEventListener("abort", onAbort, { once: true })
  })

function abortError() {
  const err = new Error("Request aborted")
  err.name = "AbortError"
  return err
}

/**
 * Send one prompt to TodayAI and wait for the final assistant message.
 * Returns { text, threadId, messageId, latencyMs }.
 */
async function runTurn(access, prompt, { signal, model, onDelta } = {}) {
  dbg("runTurn:start", { model, promptChars: String(prompt || "").length })
  const sentAt = Date.now()
  const ack = await callApi(
    "/v1/messages",
    { method: "POST", body: { message: prompt, clientMessageId: `tc:legacy:${randomUUID()}` }, signal },
    access,
  )
  const threadId = ack?.threadId
  if (!threadId) throw new Error("TodayAI did not return a threadId")
  dbg("runTurn:acked", { threadId, ms: Date.now() - sentAt })

  const startedAt = Date.now()
  let emitted = ""
  let lastError = null

  while (Date.now() - startedAt < CHAT_TIMEOUT_MS) {
    const waited = Date.now() - startedAt
    await sleep(waited < 4000 ? 800 : POLL_INTERVAL_MS, signal)
    let messages = []
    try {
      messages = await fetchThreadMessages(access, threadId, signal)
    } catch (error) {
      lastError = error
      continue
    }
    const text = threadAssistantText(messages)
    if (text) {
      if (onDelta && text.length > emitted.length && text.startsWith(emitted)) {
        onDelta(text.slice(emitted.length), text)
      }
      emitted = text
      const assistant = messages.find((m) => m?.role === "assistant" && threadAssistantText([m]))
      return { text, threadId, messageId: assistant?.id, latencyMs: Date.now() - startedAt, model }
    }
  }

  if (emitted) return { text: emitted, threadId, latencyMs: Date.now() - startedAt, model }
  throw new Error(
    `TodayAI 在 ${Math.round(CHAT_TIMEOUT_MS / 1000)}s 内没有返回回复` +
      (lastError ? `：${lastError.message}` : "（账号额度可能已用尽，或该模型暂不可用）"),
  )
}

function openAiResponse({ id, model, text, created, promptText }) {
  return {
    id,
    object: "chat.completion",
    created: created ?? Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: text },
        finish_reason: "stop",
      },
    ],
    usage: usageFor(promptText, text),
  }
}

function sseStream(id, model, created, text, chunk = false) {
  const encoder = new TextEncoder()
  const frame = (delta, finishReason) =>
    `data: ${JSON.stringify({
      id,
      object: "chat.completion.chunk",
      created,
      model,
      choices: [{ index: 0, delta, finish_reason: finishReason }],
    })}\n\n`

  return new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(frame({ role: "assistant", content: "" }, null)))
      if (text) controller.enqueue(encoder.encode(frame({ content: text }, null)))
      controller.enqueue(encoder.encode(frame({}, "stop")))
      controller.enqueue(encoder.encode("data: [DONE]\n\n"))
      controller.close()
    },
  })
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "X-Todayai-Token-Estimate": "1" },
  })
}

function errorResponse(status, message, code) {
  return jsonResponse({ error: { message, type: "todayai_error", code: code || String(status) } }, status)
}

async function handleChatCompletions(ctx, init) {
  const rawBody = init?.body
  if (!rawBody) return errorResponse(400, "Missing request body")
  let body
  try {
    body = typeof rawBody === "string" ? JSON.parse(rawBody) : JSON.parse(new TextDecoder().decode(rawBody))
  } catch {
    return errorResponse(400, "Invalid JSON body")
  }

  const wantsStream = Boolean(body.stream)
  const model = typeof body.model === "string" && body.model ? body.model : "deepseek-v4.1-flash"
  const prompt = flattenMessages(body.messages)
  if (!prompt) return errorResponse(400, "No user message provided")
  dbg("chat:request", { model, wantsStream, promptChars: prompt.length, maxTokens: body.max_tokens ?? null })

  const access = await ctx.access()
  dbg("chat:access", { got: Boolean(access) })
  const optionId = await ctx.resolveOptionId(model)
  dbg("chat:option", { optionId })
  if (optionId) await selectModel(access, optionId)
  dbg("chat:selected", { optionId })

  const id = `chatcmpl-${randomUUID().replace(/-/g, "")}`
  const created = Math.floor(Date.now() / 1000)

  if (!wantsStream) {
    const result = await runTurn(access, prompt, { signal: init?.signal, model })
    return jsonResponse(openAiResponse({ id, model, text: result.text, created, promptText: prompt }))
  }

  // Streaming is emulated: TodayAI has no SSE, so we poll and emit deltas.
  const encoder = new TextEncoder()
  const signal = init?.signal
  const stream = new ReadableStream({
    async start(controller) {
      const frame = (delta, finishReason) =>
        encoder.encode(
          `data: ${JSON.stringify({
            id,
            object: "chat.completion.chunk",
            created,
            model,
            choices: [{ index: 0, delta, finish_reason: finishReason }],
          })}\n\n`,
        )
      try {
        controller.enqueue(frame({ role: "assistant", content: "" }, null))
        let done = false
        const result = await runTurn(access, prompt, {
          signal,
          model,
          onDelta: (delta) => {
            try {
              controller.enqueue(frame({ content: delta }, null))
            } catch {
              done = true
            }
          },
        })
        if (!result) done = true
        if (!done) {
          const usage = usageFor(prompt, result.text)
          // 最后一帧带上 usage，另外补一帧纯 usage（OpenAI 的 include_usage 语义），
          // 这样 magpie 的 usage 面板才有 in/out/total 可记。
          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({
                id,
                object: "chat.completion.chunk",
                created,
                model,
                choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
                usage,
              })}\n\n`,
            ),
          )
          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({
                id,
                object: "chat.completion.chunk",
                created,
                model,
                choices: [],
                usage,
              })}\n\n`,
            ),
          )
          controller.enqueue(encoder.encode("data: [DONE]\n\n"))
        }
      } catch (error) {
        if (error?.name !== "AbortError") {
          try {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify({ error: { message: error.message } })}\n\n`))
          } catch {
            // stream already closed
          }
        }
      } finally {
        try {
          controller.close()
        } catch {
          // already closed
        }
      }
    },
  })

  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Todayai-Token-Estimate": "1",
    },
  })
}

// ---- the plugin ---------------------------------------------------------------------
// magpie calls the export as a factory: TodayaiAuthPlugin({ client }, options).
// `client.auth.set` is how a renewed sign-in is written back to magpie.

function successResult({ access, refresh, expires, accountId, email, label, avatarUrl }) {
  return {
    type: "success",
    provider: PROVIDER_ID,
    access,
    refresh,
    expires,
    ...(accountId ? { accountId } : {}),
    ...(email ? { email } : {}),
    ...(label ? { label } : {}),
    ...(avatarUrl ? { avatarUrl } : {}),
  }
}

function storedBody({ access, refresh, expires, accountId, email, label, avatarUrl }) {
  return {
    type: "oauth",
    access,
    refresh,
    expires,
    ...(accountId ? { accountId } : {}),
    ...(email ? { email } : {}),
    ...(label ? { label } : {}),
    ...(avatarUrl ? { avatarUrl } : {}),
  }
}

function configModel(model) {
  return {
    name: model.name,
    limit: { context: 128_000, output: 8_192 },
    tool_call: false,
    ...(model.reasoning ? { reasoning: true } : {}),
  }
}

function runtimeModel(model) {
  return {
    id: model.id,
    providerID: PROVIDER_ID,
    name: model.name,
    api: { id: model.id, url: `${API_HOST}${BASE_PATH}`, npm: "@ai-sdk/openai-compatible" },
    status: "active",
    headers: {},
    options: {},
    cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
    limit: { context: 128_000, output: 8_192 },
    capabilities: {
      temperature: true,
      reasoning: !!model.reasoning,
      attachment: false,
      toolcall: false,
      input: { text: true, image: false, audio: false, video: false, pdf: false },
      output: { text: true, image: false, audio: false, video: false, pdf: false },
      interleaved: false,
    },
    release_date: "",
    variants: {},
  }
}

export const TodayaiAuthPlugin = async ({ client } = {}, options = {}) => {
  void options
  dbg("factory:created", { hasClient: Boolean(client), hasAuthSet: Boolean(client?.auth?.set) })

  // write a renewed sign-in back to magpie, best effort
  const persist = async (body) => {
    try {
      await client?.auth?.set?.({ path: { id: PROVIDER_ID }, body: storedBody(body) })
    } catch {
      /* the next request renews again */
    }
  }

  const fresh = (auth) => {
    const expires = typeof auth?.expires === "number" ? auth.expires : 0
    return !!auth?.access && expires - Date.now() > REFRESH_MARGIN_MS
  }

  const renew = async (auth) => {
    const sessionToken = auth?.refresh || auth?.access
    if (!sessionToken) throw new Error("TodayAI: no session token to renew")
    const minted = await mintAccess(sessionToken)
    const next = {
      access: minted.access,
      refresh: sessionToken,
      expires: minted.expiresAt,
      accountId: auth?.accountId,
      email: auth?.email,
      label: auth?.label,
      avatarUrl: auth?.avatarUrl,
    }
    await persist(next)
    return next
  }

  const accessOf = async (auth) => (fresh(auth) ? auth.access : (await renew(auth)).access)

  return {
    config: async (cfg) => {
      dbg("config:start")
      cfg.provider = cfg.provider || {}
      cfg.provider[PROVIDER_ID] ??= {
        name: "TodayAI",
        npm: "@ai-sdk/openai-compatible",
        api: `${API_HOST}${BASE_PATH}`,
        models: Object.fromEntries(PREFERRED_MODELS.map((m) => [m.id, configModel(m)])),
      }
      dbg("config:done")
      return cfg
    },

    auth: {
      provider: PROVIDER_ID,

      methods: [
        {
          // the desktop client already holds a better-auth session; reuse it,
          // no SMS needed
          type: "oauth",
          label: "复用 Today CN 桌面客户端已登录的账号（免验证码，推荐）",
          async authorize() {
            return {
              url: "",
              instructions: "使用 Today CN 桌面客户端中已登录的账号",
              method: "auto",
              async callback() {
                const session = await readDesktopSession()
                if (!session?.refresh) {
                  return {
                    type: "failed",
                    error: "没有找到已登录的 Today CN 桌面客户端；请改用手机验证码登录",
                  }
                }
                const stored = { access: session.access, expires: session.expiresAt }
                const { access, expires } = fresh(stored)
                  ? stored
                  : await mintAccess(session.refresh).then((m) => ({
                      access: m.access,
                      expires: m.expiresAt,
                    }))
                const who = await describeIdentity(access, {
                  displayName: session.displayName,
                  uid: session.uid,
                  avatarUrl: session.avatarUrl,
                })
                return successResult({
                  access,
                  refresh: session.refresh,
                  expires,
                  accountId: session.displayName || who.accountId || session.uid,
                  email: who.email,
                  label: who.label,
                  avatarUrl: who.avatarUrl,
                })
              },
            }
          },
        },

        {
          type: "oauth",
          label: "手机验证码登录（+86，桌面客户端未登录时才需要）",
          prompts: [
            {
              type: "text",
              key: "phone",
              message: "手机号（11 位，不要带 +86）",
              placeholder: "13800138000",
              validate: (v) =>
                /^1\d{10}$/.test(String(v ?? "").trim()) ? undefined : "请输入 11 位手机号",
            },
          ],
          // a failure has to throw here: a {type:"failed"} return would be
          // taken for the "auto" branch and callback() called with no code
          async authorize(inputs) {
            const phoneNumber = normalizePhone(inputs?.phone)
            await callAuth("/api/auth/phone-number/send-otp", {
              method: "POST",
              body: { phoneNumber },
              headers: { Origin: WEB_ORIGIN },
            })
            return {
              url: "",
              instructions: `验证码已发送到 ${phoneNumber.slice(0, 3)}****${phoneNumber.slice(-4)}，请输入收到的短信验证码。`,
              method: "code",
              async callback(code) {
                const trimmed = String(code ?? "").trim()
                if (!trimmed) return { type: "failed", error: "请填写短信验证码" }
                const verified = await callAuth("/api/auth/phone-number/verify", {
                  method: "POST",
                  body: { phoneNumber, code: trimmed },
                  headers: { Origin: WEB_ORIGIN },
                })
                const sessionToken =
                  verified?.token ||
                  verified?.session?.token ||
                  verified?.data?.token ||
                  verified?.data?.session?.token
                if (!sessionToken) {
                  return { type: "failed", error: "登录成功但服务器没有返回会话令牌" }
                }
                const minted = await mintAccess(sessionToken)
                const who = await describeIdentity(minted.access, {})
                return successResult({
                  access: minted.access,
                  refresh: sessionToken,
                  expires: minted.expiresAt,
                  accountId: who.accountId,
                  email: who.email,
                  label: who.label,
                  avatarUrl: who.avatarUrl,
                })
              },
            }
          },
        },

        {
          type: "oauth",
          label: "手动粘贴 TodayAI 会话令牌（32 位 session token）",
          prompts: [{ type: "text", key: "token", message: "会话令牌（32 位）" }],
          async authorize(inputs) {
            const sessionToken = String(inputs?.token ?? "").trim()
            if (!sessionToken) throw new Error("请填写会话令牌")
            return {
              url: "",
              instructions: "校验会话令牌",
              method: "auto",
              async callback() {
                try {
                  const minted = await mintAccess(sessionToken)
                  const who = await describeIdentity(minted.access, {})
                  return successResult({
                    access: minted.access,
                    refresh: sessionToken,
                    expires: minted.expiresAt,
                    accountId: who.accountId,
                    email: who.email,
                    label: who.label,
                    avatarUrl: who.avatarUrl,
                  })
                } catch (e) {
                  return { type: "failed", error: `会话令牌无效：${e?.message || e}` }
                }
              },
            }
          },
        },
      ],

      // asked when the access JWT is close to its end; returns only what changed
      async refresh(auth) {
        dbg("refresh:start", {
          hasAccess: Boolean(auth?.access),
          hasRefresh: Boolean(auth?.refresh),
          expiresInSec: typeof auth?.expires === "number" ? Math.round((auth.expires - Date.now()) / 1000) : null,
        })
        const next = await renew(auth)
        dbg("refresh:done", { expiresInSec: Math.round((next.expires - Date.now()) / 1000) })
        return { access: next.access, refresh: next.refresh, expires: next.expires }
      },

      /**
       * baseURL + fetch: the SDK speaks OpenAI's chat-completions dialect, and
       * this fetch turns those calls into TodayAI agent-timeline calls.
       */
      async loader(getAuth) {
        dbg("loader:created")
        const modelCache = new Map()

        const resolveOptionId = async (model, access) => {
          if (!model) return null
          if (model.startsWith("model.")) return model
          if (modelCache.has("__options__")) {
            const hit = modelCache.get("__options__").find((m) => m.id === model)
            if (hit) return hit.optionId
          }
          try {
            const listing = await listSelectableModels(access)
            modelCache.set("__options__", listing.models)
            const hit = listing.models.find((m) => m.id === model)
            return hit?.optionId || `model.${model}`
          } catch {
            return `model.${model}`
          }
        }

        const ctx = {
          access: async () => accessOf(await getAuth()),
          resolveOptionId: async (model) => resolveOptionId(model, await accessOf(await getAuth())),
        }

        const adapt = async (input, init = {}) => {
          const raw = typeof input === "string" ? input : input?.url || String(input)
          let path = raw
          try {
            path = new URL(raw).pathname
          } catch {
            /* relative URL */
          }
          const normalized = path.replace(/^\/v1/, "")

          if (normalized === "/chat/completions" || normalized.endsWith("/chat/completions")) {
            return handleChatCompletions(ctx, init)
          }
          if (normalized === "/models" || normalized.endsWith("/models")) {
            const listing = await listSelectableModels(await ctx.access())
            return jsonResponse({
              object: "list",
              data: listing.models.map((m) => ({
                id: m.id,
                object: "model",
                created: Math.floor(Date.now() / 1000),
                owned_by: "todayai",
              })),
            })
          }

          // anything else is proxied through with a fresh token
          const access = await ctx.access()
          const headers = {}
          for (const [k, v] of Object.entries(init?.headers || {})) {
            const lower = k.toLowerCase()
            if (lower.startsWith("x-magpie-") || lower === "authorization") continue
            headers[k] = v
          }
          return callApi(normalized, {
            method: init?.method || "GET",
            body: init?.body,
            headers,
            signal: init?.signal,
          }, access).then((payload) => jsonResponse(payload))
        }

        return { baseURL: `${API_HOST}${BASE_PATH}`, fetch: adapt, apiKey: "todayai" }
      },

      async usage(getAuth) {
        const auth = await getAuth()
        if (!auth?.access) return { error: "TodayAI 未登录", signIn: "kept" }
        try {
          const status = await readPricingStatus(await accessOf(auth))
          return formatUsage(status)
        } catch (e) {
          return { error: `TodayAI 额度读取失败：${e?.message || e}` }
        }
      },
    },

    provider: {
      id: PROVIDER_ID,
      // the account's own selectable models, as an object map, the default first
      async models(provider, { auth } = {}) {
        void provider
        dbg("models:start", { hasAuth: Boolean(auth?.access) })
        const fallback = Object.fromEntries(PREFERRED_MODELS.map((m) => [m.id, runtimeModel(m)]))
        if (!auth?.access) {
          dbg("models:fallback-no-auth")
          return fallback
        }
        try {
          const listing = await listSelectableModels(await accessOf(auth))
          const out = Object.fromEntries(listing.models.map((m) => [m.id, runtimeModel(m)]))
          dbg("models:live", { count: Object.keys(out).length })
          return Object.keys(out).length ? out : fallback
        } catch (error) {
          dbg("models:fallback-error", String(error?.message || error))
          return fallback
        }
      },
    },
  }
}

// for tests
export const _internal = {
  baseHeaders,
  mintAccess,
  decodeJwtExpiry,
  normalizePhone,
  describeIdentity,
  readPricingStatus,
  listSelectableModels,
  selectModel,
  formatUsage,
  flattenMessages,
  timelineItemText,
  fetchThreadMessages,
  runTurn,
  handleChatCompletions,
  successResult,
  storedBody,
  configModel,
  runtimeModel,
}
