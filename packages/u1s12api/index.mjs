// u1s12api — a magpie/OpenCode provider plugin for u1s1. It signs in with the
// browser (the CLI's device flow) and then routes model calls through the
// account's u1s1 CLI process, exactly as the local u1s1 install does.
//
//   - sign-in: POST /auth/device/start with a fresh P-256 keypair, open the
//     verify_url in the browser, poll /auth/device/poll until the account
//     approves, keep the device credential, and register the account with
//     magpie (the success result carries refresh/access — host.js's save()
//     keeps an oauth sign-in only then). A second method takes the CLI's
//     existing sign-in without a browser.
//   - requests: the plugin spawns the installed u1s1 CLI and translates the
//     provider's messages into a prompt. The CLI signs every request itself
//     (DPoP + attestation + x-u1s1-* headers) so the gateway sees an
//     official client. Free quotas (gift packs) require the CLI process;
//     a plain-HTTP DPoP replay is refused with client_integrity_review.
//     Each request gets an independent print-mode process. Prompts go through
//     stdin; --no-session and --no-tools keep gateway inference isolated.
//     The installed CLI's RPC mode is not used by this adapter.
//   - usage: /v1/me through the CLI session (read-only), as the dashboard
//     shows it: its 用量包 groups with the account's cash balance.
//   - check-in: the daily pack is claimed over the website session
//     (u1s1_session in ~/.u1s1/web-session.json, written once by
//     login-once.mjs or refreshed from a signed-in browser over CDP). The
//     site's captcha widgets are fail-open — its own page sends null tokens
//     when they fail and the server accepts that path (verified with a real
//     claim), so the plugin pays no captcha cost.
//   - models: /v1/models through the CLI session.
//
// The account credential lives in ~/.u1s1/config.json (the CLI's own file),
// so the same device can use the CLI and the plugin interchangeably.
//
// IMPORTANT: u1s1's free quotas (gift packs) require the official CLI process.
// If you need quota to be consumed, run `u1s1 login` first, or upgrade to a
// paid plan (paid balance has no client restriction).

import fs from "node:fs"
import os from "node:os"
import { spawn } from "node:child_process"
import { createHash, randomUUID } from "node:crypto"
import { homedir, platform, arch } from "node:os"
import { dirname, join } from "node:path"
import { ExternalToolOutput, offeredTools, parseToolOutput, toolProtocol } from "./tools.mjs"

const PROVIDER = "u1s12api"

// the u1s1 site the account is on: the CN site is u1s1app.com, its API on
// api.u1s1app.com/v1; the intl site is u1s1.dev. config.baseUrl names the API
// base, so the origin and the site are derived from it.
const SITES = {
  "u1s1app.com": { apiBase: "https://api.u1s1app.com/v1", site: "https://u1s1app.com", name: "u1s1 (CN)" },
  "u1s1.dev": { apiBase: "https://api.u1s1.dev/v1", site: "https://u1s1.dev", name: "u1s1 (intl)" },
}
const LEGACY_API = "https://api.u1s1.io/v1" // old CN API, migrated to u1s1app.com
const ICON = "https://u1s1app.com/favicon.svg"
const DEVICE_NAME = "u1s12api plugin"

const CONFIG_PATH = join(homedir(), ".u1s1", "config.json")
// WEB_SESSION_PATH keeps the u1s1app.com website session (the u1s1_session
// cookie) that the daily check-in claim accepts. The CLI device credential
// reaches api.u1s1.io but not the website's /api/packages endpoints, so the
// check-in needs this second credential; login-once.mjs writes it from the
// browser the user is already signed in to.
const WEB_SESSION_PATH = join(homedir(), ".u1s1", "web-session.json")
const AUTH_TIMEOUT_MS = 60_000
const POLL_INTERVAL_MS = 2000
const POLL_TIMEOUT_MS = 5 * 60 * 1000
const RPC_TIMEOUT_MS = 600_000
// Bound the flattened text context; transport itself uses stdin, never argv.
const MAX_PROMPT_CHARS = 24_000

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const clip = (s, n = 200) => {
  const v = String(s ?? "").trim()
  return v.length > n ? v.slice(0, n) + "…" : v || "empty response"
}

// isB64Url encodes bytes as base64url
const isB64Url = (v) => Buffer.from(typeof v === "string" ? Buffer.from(v, "utf8") : v).toString("base64url")
const htu = (raw) => {
  const u = new URL(raw)
  u.search = ""
  u.hash = ""
  return u.toString()
}

// findCliDist locates the installed u1s1 CLI, the same candidates the local
// relay bridge probes (u1s1-cli-relay.mjs's findCliDist).
function findCliDist() {
  const candidates = [
    process.env.U1S1_CLI_DIST,
    // Scoop installations (nodejs, nodejs24, etc.)
    join(process.env.SCOOP || "", "persist", "nodejs", "bin", "node_modules", "u1s1-cli", "dist"),
    join(process.env.SCOOP || "", "persist", "nodejs24", "bin", "node_modules", "u1s1-cli", "dist"),
    // the desktop install keeps the CLI under its bundled server
    join(process.env.ProgramFiles || "C:\\Program Files", "u1s1", "resources", "server", "node_modules", "u1s1-cli", "dist"),
    "E:\\Program Files\\u1s1\\resources\\server\\node_modules\\u1s1-cli\\dist",
    join(process.env.LOCALAPPDATA || "", "Programs", "u1s1", "resources", "server", "node_modules", "u1s1-cli", "dist"),
    join(process.env.APPDATA || "", "npm", "node_modules", "u1s1-cli", "dist"),
    join(process.env.USERPROFILE || "", "AppData", "Roaming", "npm", "node_modules", "u1s1-cli", "dist"),
  ]
  for (const d of candidates) {
    if (d && fs.existsSync(join(d, "index.js"))) return d
  }
  return null
}

// findNode picks the node the CLI runs on: the desktop install's bundled one
// (matched to its native modules) else the PATH node
function findNode(cliDist) {
  const bundled = join(cliDist, "..", "..", "..", "..", "node", "node.exe")
  return fs.existsSync(bundled) ? bundled : "node"
}

// cliEntry is the real CLI's entry script, if it is installed at all. Without
// it the plugin still signs in and reads usage, but model calls are refused
// (the gateway requires an official client process for the free quota).
function cliEntry() {
  const dist = findCliDist()
  return dist ? { dist, node: findNode(dist), index: join(dist, "index.js") } : null
}

// siteFor names the u1s1 site a config.baseUrl is on
function siteFor(baseUrl) {
  try {
    const host = new URL(baseUrl).hostname
    if (host.startsWith("api.u1s1app.com")) return SITES["u1s1app.com"]
    if (host.startsWith("api.u1s1.dev")) return SITES["u1s1.dev"]
  } catch {}
  return SITES["u1s1app.com"]
}

// writeConfig persists the CLI's credential file.
function writeConfig(cfg) {
  fs.mkdirSync(dirname(CONFIG_PATH), { recursive: true })
  const tmp = CONFIG_PATH + ".magpie-tmp"
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2) + "\n", { mode: 0o600 })
  fs.renameSync(tmp, CONFIG_PATH)
}

// migrateBaseUrl migrates legacy config.baseUrl (api.u1s1.io) to the current
// CN apiBase (api.u1s1app.com). Called on config read.
const LEGACY_BASES = new Set(["https://api.u1s1.io/v1"])
function migrateBaseUrl(cfg) {
  if (cfg?.baseUrl && LEGACY_BASES.has(cfg.baseUrl)) {
    cfg.baseUrl = SITES["u1s1app.com"].apiBase
    writeConfig(cfg)
  }
  return cfg
}

// readConfig reads ~/.u1s1/config.json (the CLI's credential file). A config
// written by this plugin's sign-in is shaped the same as the CLI's own, so
// the two share the device credential.
function readConfig() {
  try {
    const raw = fs.readFileSync(CONFIG_PATH, "utf8")
    return migrateBaseUrl(JSON.parse(raw))
  } catch {
    return null
  }
}

// readWebSession reads the website session login-once.mjs saved.
function readWebSession() {
  try {
    return JSON.parse(fs.readFileSync(WEB_SESSION_PATH, "utf8"))
  } catch {
    return null
  }
}

// writeWebSession stores a website session for the daily claim.
function writeWebSession(session) {
  fs.mkdirSync(dirname(WEB_SESSION_PATH), { recursive: true })
  const tmp = WEB_SESSION_PATH + ".magpie-tmp"
  fs.writeFileSync(tmp, JSON.stringify(session, null, 2) + "\n", { mode: 0o600 })
  fs.renameSync(tmp, WEB_SESSION_PATH)
}

// refreshWebSessionViaCdp re-extracts the website cookie from a running
// Chrome that exposes CDP on 127.0.0.1:9222 (the browser the user signed in
// to). It keeps the "sign in once" promise: as long as that browser is still
// signed in, an expired saved cookie is replaced without user action. A
// failure (no Chrome, no CDP, not signed in) returns null.
async function refreshWebSessionViaCdp() {
  try {
    const ver = await fetch("http://127.0.0.1:9222/json/version", { signal: AbortSignal.timeout(1500) })
    const info = await ver.json()
    if (!info.webSocketDebuggerUrl) return null
    const ws = new WebSocket(info.webSocketDebuggerUrl)
    await new Promise((resolve, reject) => {
      ws.onopen = resolve
      ws.onerror = () => reject(new Error("cdp connect failed"))
      setTimeout(() => reject(new Error("cdp connect timed out")), 3000)
    })
    const result = await new Promise((resolve, reject) => {
      ws.onmessage = (ev) => {
        let msg
        try {
          msg = JSON.parse(String(ev.data))
        } catch {
          return
        }
        if (msg.id !== 1) return
        try { ws.close() } catch {}
        msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result)
      }
      ws.send(JSON.stringify({ id: 1, method: "Storage.getCookies", params: {} }))
      setTimeout(() => reject(new Error("cdp read timed out")), 5000)
    })
    const cookies = (result.cookies ?? []).filter((c) => (c.domain ?? "").replace(/^\./, "").endsWith("u1s1app.com"))
    if (!cookies.length) return null
    const farthest = cookies.reduce((m, c) => Math.max(m, Number(c.expires) || 0), 0)
    const session = {
      cookieHeader: cookies.map((c) => `${c.name}=${c.value}`).join("; "),
      savedAt: new Date().toISOString(),
      expiresAt: farthest > 0 ? new Date(farthest * 1000).toISOString() : null,
    }
    writeWebSession(session)
    return session
  } catch {
    return null
  }
}

// ensureWebSession returns a website session: the saved one while it has not
// expired, else a fresh extraction from the running browser.
async function ensureWebSession() {
  const saved = readWebSession()
  if (saved?.cookieHeader) {
    const expires = saved.expiresAt ? Date.parse(saved.expiresAt) : Infinity
    if (expires > Date.now() + 60_000) return saved
  }
  return refreshWebSessionViaCdp()
}

// claimDailyCheckin claims today's login_checkin pack over the website
// session (POST /api/packages/login-checkin/claim). The site's own page sends
// null cap-token / cf-turnstile-response whenever its invisible widgets fail
// to load, and the server accepts that fail-open path — verified: a null-null
// claim returned 200 with the 2,000,000-token pack. Returns null when there is
// no usable session or the call fails, so the caller falls back to the
// status-only path.
async function claimDailyCheckin(site) {
  const session = await ensureWebSession()
  if (!session?.cookieHeader) return null
  try {
    const res = await fetch(site.site + "/api/packages/login-checkin/claim", {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        origin: site.site,
        referer: site.site + "/dashboard",
        cookie: session.cookieHeader,
      },
      body: JSON.stringify({ "cap-token": null, "cf-turnstile-response": null }),
      signal: AbortSignal.timeout(20_000),
    })
    const text = await res.text()
    let body
    try {
      body = JSON.parse(text)
    } catch {
      body = null
    }
    if (res.status === 200 && body?.ok) {
      const tokens = Number(body.tokens) || 0
      const streak = Number(body.streak) || 0
      const bonus = Number(body.bonus_tokens) || 0
      return {
        outcome: "claimed",
        credit: tokens + bonus,
        streak,
        message:
          (bonus > 0 ? `${tokens.toLocaleString("en-US")} Token 已到账，连签奖励 +${bonus.toLocaleString("en-US")}` : `${tokens.toLocaleString("en-US")} Token 已到账`) +
          `（连续 ${streak} 天）`,
      }
    }
    if (res.status === 409 || /已经打过卡|already/i.test(body?.error?.message ?? text)) {
      return { outcome: "done", credit: 0, streak: 0, message: "今日已在 u1s1 打卡" }
    }
    if (res.status === 401 || res.status === 403) {
      // the saved cookie went stale and Chrome has nothing better: drop it so
      // the next run tries the browser again, and report the manual path
      try { fs.rmSync(WEB_SESSION_PATH, { force: true }) } catch {}
      return null
    }
    return null
  } catch {
    return null
  }
}

// configFor merges a device credential onto the CLI's config shape, keeping
// the baseUrl an existing device credential already has (never downgrading
// it). existing is the config to merge onto, defaulting to the CLI's own file.
function configFor(baseUrl, apiKey, deviceToken, deviceId, privateJwk, publicJwk, existing = readConfig()) {
  const keep = existing?.deviceToken ? existing.baseUrl : baseUrl
  return {
    apiKey,
    deviceToken,
    deviceId,
    devicePrivateJwk: privateJwk,
    devicePublicJwk: publicJwk,
    baseUrl: keep,
    model: existing?.model ?? "deepseek-flash",
    modelProvider: "u1s1",
  }
}

// generateKeyPair makes the P-256 device keypair the sign-in offers
async function generateKeyPair() {
  const key = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])
  const [privateJwk, publicJwk] = await Promise.all([
    crypto.subtle.exportKey("jwk", key.privateKey),
    crypto.subtle.exportKey("jwk", key.publicKey),
  ])
  delete privateJwk.key_ops
  delete privateJwk.ext
  delete publicJwk.key_ops
  delete publicJwk.ext
  return { privateJwk, publicJwk }
}

// deviceAuth starts the CLI's device sign-in: offer the public key, get a
// verify_url to open in the browser, then poll until the account approves.
// A failure before the poll (the server unreachable, an incomplete answer)
// throws: the host surfaces an authorize() that throws, while only the
// callback's result is read for {type:"failed"}.
async function deviceAuth(origin, site) {
  const { privateJwk, publicJwk } = await generateKeyPair()
  const body = {
    public_jwk: publicJwk,
    device_name: DEVICE_NAME,
    client_version: "1.14.1",
  }
  let start
  try {
    start = await fetch(origin + "/auth/device/start", {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(AUTH_TIMEOUT_MS),
    })
  } catch (e) {
    throw new Error("can't reach the u1s1 server: " + clip(e?.message ?? e))
  }
  const text = await start.text()
  let data
  try {
    data = JSON.parse(text)
  } catch {
    throw new Error("the u1s1 sign-in answer wasn't JSON: " + clip(text))
  }
  if (!start.ok) throw new Error("the u1s1 sign-in returned " + start.status + ": " + clip(data?.error?.message ?? text))
  if (!data?.verify_url || !data?.poll_secret) throw new Error("the u1s1 sign-in came back incomplete")

  const callback = async () => {
    const deadline = Date.now() + POLL_TIMEOUT_MS
    while (Date.now() < deadline) {
      const poll = await fetch(origin + "/auth/device/poll", {
        method: "POST",
        headers: { accept: "application/json", "content-type": "application/json" },
        body: JSON.stringify({ poll_secret: data.poll_secret }),
        signal: AbortSignal.timeout(AUTH_TIMEOUT_MS),
      }).catch(() => null)
      if (poll) {
        let answer
        try {
          answer = await poll.json()
        } catch {}
        if (answer?.status === "ok" && answer.api_key && answer.device_token && answer.device_id) {
          const cfg = configFor(site.apiBase, answer.api_key, answer.device_token, answer.device_id, privateJwk, publicJwk)
          writeConfig(cfg)
          // /v1/me names the account as magpie shows it; a failure there
          // leaves the device number in its place
          const me = await apiGET(cfg, "/me").catch(() => null)
          const email = typeof me?.body?.email === "string" ? me.body.email : ""
          return signInResult(cfg, email, "browser", site?.name)
        }
        if (answer?.status === "expired" || answer?.error) {
          return { type: "failed", error: "the u1s1 sign-in expired — start it again" }
        }
      }
      await sleep(data.interval > 0 ? data.interval * 1000 : POLL_INTERVAL_MS)
    }
    return { type: "failed", error: "the u1s1 sign-in timed out; start it again" }
  }

  return {
    url: data.verify_url,
    instructions: "Approve this device in the u1s1 browser page. The sign-in finishes on its own.",
    method: "auto",
    callback,
  }
}

// signInResult is a device credential as the sign-in's success result.
// magpie's host keeps an oauth sign-in only when the result carries refresh
// (its save()), so the device token goes there and the API key in access;
// the fields beside them are the account record magpie shows and matches a
// second sign-in of the same account against. The credential itself stays
// in ~/.u1s1/config.json, the file the CLI and the loader both read.
function signInResult(cfg, email, method, siteName) {
  return {
    type: "success",
    accountId: email || "u1s1 device #" + cfg.deviceId,
    method,
    refresh: cfg.deviceToken,
    access: cfg.apiKey,
    ...(siteName ? { site: siteName } : {}),
  }
}

// apiOrigin gives the sign-in origin a baseUrl is on
function apiOrigin(baseUrl) {
  return new URL(baseUrl).origin
}

// signHeaders builds the DPoP proof the account's credential requires, so
// read-only API reads work even when the CLI isn't installed.
async function signHeaders(cfg, method, url) {
  if (!cfg?.deviceToken || !cfg.devicePrivateJwk || !cfg.devicePublicJwk) return {}
  const header = isB64Url(JSON.stringify({ typ: "dpop+jwt", alg: "ES256", jwk: cfg.devicePublicJwk }))
  const ath = createHash("sha256").update(cfg.deviceToken).digest("base64url")
  const payload = isB64Url(JSON.stringify({
    jti: randomUUID().replace(/-/g, ""),
    htm: method,
    htu: htu(url),
    iat: Math.floor(Date.now() / 1000),
    ath,
  }))
  const key = await crypto.subtle.importKey("jwk", cfg.devicePrivateJwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"])
  const sig = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, new TextEncoder().encode(header + "." + payload)))
  return { authorization: "DPoP " + cfg.deviceToken, dpop: `${header}.${payload}.${isB64Url(sig)}` }
}

// apiGET does a read-only DPoP-signed GET against the account's API base.
// A device credential is always present after sign-in, so the proof is real.
async function apiGET(cfg, path) {
  const url = cfg.baseUrl + path
  const signed = await signHeaders(cfg, "GET", url)
  const res = await fetch(url, {
    headers: { accept: "application/json", "x-u1s1-version": "1.14.1", "x-u1s1-client": "terminal", "x-u1s1-platform": `${platform()}-${arch()}`, ...signed },
    signal: AbortSignal.timeout(AUTH_TIMEOUT_MS),
  })
  const text = await res.text()
  let body
  try {
    body = JSON.parse(text)
  } catch {
    body = text.slice(0, 300)
  }
  return { status: res.status, body }
}

// ---- usage ---------------------------------------------------------------

// PACKAGE_LABELS maps a package kind to the name u1s1 shows for it, copied
// from the dashboard's own PKG_LABEL (app.js). The CLI's usage.js says
// 登录打卡 / 打卡加成 for the two check-in kinds; the dashboard says
// 登录打卡赠送 / 连续打卡奖励, and the dashboard is what a user reads.
const PACKAGE_LABELS = {
  free_first: "首月免费包",
  free_yearly: "年度免费包",
  invite: "邀请赠送",
  new_user: "新用户赠送",
  payment_delay_gift: "临时加量包",
  login_checkin: "登录打卡赠送",
  login_checkin_bonus: "连续打卡奖励",
  topup_daily: "每日加量包",
  admin_grant: "官方赠送",
}

// packageLabel names one kind's group the way the dashboard does, 邀请赠送 × 6.
function packageLabel(kind, count = 1) {
  const label = PACKAGE_LABELS[kind] ?? kind
  return count > 1 ? `${label} × ${count}` : label
}

// packageGroups merges packages by kind, scope and daily-ness. Spent packs
// stay visible for accounting, but usageOf marks them aside so Magpie's router
// will choose a window that still has allowance.
function packageGroups(packs) {
  const groups = new Map()
  for (const p of packs) {
    const daily = p.daily_tokens != null
    const remaining = Number(p.remaining) || 0
    const key = `${p.kind}|${p.scope}|${daily}|${remaining > 0 ? "left" : "spent"}`
    const g = groups.get(key) ?? { kind: p.kind, daily, spent: remaining <= 0, count: 0, remaining: 0, limit: 0, soonest: null }
    g.count += 1
    g.remaining += remaining
    g.limit += Number(daily ? p.daily_tokens : p.total_tokens) || 0
    if (p.expires_at) {
      if (!g.soonest || p.expires_at < g.soonest.at) g.soonest = { at: p.expires_at, amount: remaining }
      else if (p.expires_at === g.soonest.at) g.soonest.amount += remaining
    }
    groups.set(key, g)
  }
  // what is left to spend leads, what is spent follows; each in the API's order
  return [...groups.values()].sort((a, b) => Number(a.spent) - Number(b.spent))
}

// nextBeijingMidnight is when a daily allowance comes back, 00:00 Beijing —
// what the dashboard's 用量包 card means by 0 点恢复.
function nextBeijingMidnight(now = Date.now()) {
  const day = new Date(now + 8 * 3600 * 1000)
  day.setUTCHours(0, 0, 0, 0)
  return new Date(day.getTime() + 16 * 3600 * 1000).toISOString() // next Beijing day, back to UTC
}

// usageOf is a /v1/me answer as the account's usage card: one window per
// dashboard 用量包 group (a package's tokens are lost when it ends, which is
// magpie's runsOutAt, not a reset) and the account's cash — the dashboard's
// 可用余额 — as the balance line.
function usageOf(me) {
  const out = { plan: "u1s1" }
  const groups = packageGroups(Array.isArray(me.packages) ? me.packages : [])
  // A spent package is informational only while another funding source remains.
  const cash = (Number(me.paid_balance_usd) || 0) + (Number(me.gift_balance_usd) || 0)
  const hasAllowance = cash > 0 || groups.some((g) => g.remaining > 0)
  if (groups.length) {
    out.windows = groups.map((g) => {
      const window = {
        name: packageLabel(g.kind, g.count),
        used: g.limit > 0 ? Math.max(0, Math.min(100, (100 * (g.limit - g.remaining)) / g.limit)) : undefined,
        display: "剩余 " + g.remaining + " / " + g.limit + " tokens",
        amount: Math.max(0, g.limit - g.remaining),
        limit: g.limit,
        unit: "tokens",
        ...(g.spent && hasAllowance ? { aside: true } : {}),
      }
      if (g.daily) window.resetsAt = nextBeijingMidnight()
      else if (g.soonest && g.remaining > 0) {
        window.runsOutAt = g.soonest.at // the dashboard's 最早 X 到期
        window.runsOut = g.soonest.amount
      }
      return window
    })
  }
  // Cash only: remaining_usd also counts package value already shown above.
  if (cash > 0) out.balance = "$" + cash.toFixed(4)
  return out
}

// checkinOf decides today's check-in state from a /v1/me answer: the newest
// login_checkin pack's created_at is today (Beijing time) iff the account has
// already checked in. The plugin claims over the website session first; this
// fallback reports done when today's pack exists and inactive (pointing at
// login-once.mjs) when it doesn't.
function checkinOf(me, site) {
  const packs = Array.isArray(me.packages) ? me.packages : []
  const checkins = packs.filter((p) => p.kind === "login_checkin")
  const latest = checkins.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))[0]
  const today = new Date()
  const beijing = new Date(today.getTime() + 8 * 3600 * 1000)
  const todayKey = beijing.toISOString().slice(0, 10)
  const madeKey = latest?.created_at ? String(latest.created_at).slice(0, 10) : ""
  if (madeKey === todayKey) {
    return { outcome: "done", credit: 0, streak: 0, message: "今日已在 u1s1 打卡（登录打卡包已到账）" }
  }
  const made = latest ? new Date(latest.created_at.replace(" ", "T") + "Z") : null
  const streak = made && made.getTime() + 8 * 3600 * 1000 ? 0 : 0 // streak is server-side; the card doesn't know it
  return {
    outcome: "inactive",
    credit: 0,
    streak,
    message: "今日尚未打卡：网站登录态不可用或领取失败，请运行一次 login-once.mjs（或在浏览器打开 " + site.site + "/dashboard#sec-usage 手动领取）",
  }
}

// ---- CLI RPC -------------------------------------------------------------

// One worker owns one one-shot CLI process. Magpie controls account concurrency;
// separate requests never share the CLI's process or cancellation state.
class RpcWorker {
  constructor(cli) {
    this.cli = cli
    this.dead = false
    this.proc = null
    this.cancel = null
  }

  prompt(message, images, { onText, signal, model, timeoutMs = RPC_TIMEOUT_MS } = {}) {
    if (signal?.aborted) return Promise.reject(new Error("the request was aborted"))
    if (this.dead) return Promise.reject(new Error("the u1s1 CLI process exited"))
    if (this.proc) return Promise.reject(new Error("the u1s1 CLI worker already has a request"))
    if (images?.length) message += "\n\n[附 " + images.length + " 张图片，文本模式未携带]"
    const args = [this.cli.index, "-p", "--no-session", "--no-tools"]
    if (model) args.push("--model", "u1s1/" + String(model).replace(/^(?:u1s12api|u1s1)\//, ""))
    return new Promise((resolve, reject) => {
      let proc, timer, settled = false, out = "", errOut = ""
      const finish = (error) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        signal?.removeEventListener("abort", onAbort)
        if (this.proc === proc) this.proc = null
        this.cancel = null
        if (error) {
          try { proc?.kill("SIGKILL") } catch {}
          reject(error)
        } else {
          resolve({ text: out.trim(), usage: null, model: model ?? null, stopReason: "stop" })
        }
      }
      const onAbort = () => finish(new Error("the request was aborted"))
      this.cancel = onAbort
      try {
        proc = spawn(this.cli.node, args, {
          cwd: homedir(),
          env: { ...process.env, PI_TELEMETRY: "0", U1S1_TELEMETRY: "0" },
          stdio: ["pipe", "pipe", "pipe"],
          windowsHide: true,
        })
        this.proc = proc
        proc.on("error", finish)
        proc.stdin.on("error", finish)
        proc.stdout.setEncoding("utf8")
        proc.stdout.on("data", (chunk) => {
          if (settled) return
          out += chunk
          try { onText?.(chunk) } catch (error) { finish(error) }
        })
        proc.stderr.setEncoding("utf8")
        proc.stderr.on("data", (chunk) => { errOut = (errOut + chunk).slice(-4000) })
        proc.on("close", (code) => {
          if (code !== 0) finish(new Error("the u1s1 CLI exited with code " + code + (errOut ? ": " + errOut.slice(-300) : "")))
          else if (!out.trim()) finish(new Error("the u1s1 CLI returned an empty response"))
          else finish()
        })
        timer = setTimeout(() => finish(new Error("the u1s1 CLI timed out after " + Math.round(timeoutMs / 1000) + "s")), timeoutMs)
        signal?.addEventListener("abort", onAbort, { once: true })
        if (signal?.aborted) return onAbort()
        // Official CLI print mode reads piped stdin. No prompt bytes enter argv,
        // so quotes, Unicode and long transcripts cannot exceed CreateProcess.
        proc.stdin.end(message)
      } catch (error) {
        finish(error)
      }
    })
  }

  abort() { this.cancel?.() }
  kill() { this.dead = true; this.abort() }
}

// ---- the plugin -----------------------------------------------------------

export const U1s12apiPlugin = async (_input) => {
  const runCLI = async (messages, options = {}) => {
    if (options.signal?.aborted) throw new Error("the request was aborted")
    const cli = cliEntry()
    if (!cli) throw Object.assign(new Error("未找到本地 u1s1 CLI，请安装官方 CLI 并登录。"), { noCli: true })
    const worker = new RpcWorker(cli)
    const { prompt, images } = packPrompt(messages, options)
    try {
      return await worker.prompt(prompt, images, options)
    } finally {
      worker.kill()
    }
  }

  const site = () => siteFor(readConfig()?.baseUrl ?? SITES["u1s1app.com"].apiBase)

  return {
    config: async (cfg) => {
      cfg.provider ??= {}
      const base = readConfig()?.baseUrl ?? SITES["u1s1app.com"].apiBase
      const was = cfg.provider[PROVIDER] ?? {}
      cfg.provider[PROVIDER] = {
        name: "u1s12api",
        npm: "@ai-sdk/openai-compatible",
        api: base,
        ...was,
        models: {
          "deepseek-flash": { name: "DeepSeek Flash", limit: { context: 1048576 }, tool_call: true },
          "qwen3.8-flash": { name: "Qwen3.8 Flash", limit: { context: 1000000 }, tool_call: true },
          "glm-5.3-flash": { name: "GLM-5.3 Flash", limit: { context: 1048576 }, tool_call: true },
        },
      }
    },
    auth: {
      provider: PROVIDER,
      icon: ICON,
      methods: [
        {
          type: "oauth",
          label: "浏览器授权（u1s1 设备登录）",
          async authorize() {
            const cfg = readConfig()
            const base = cfg?.baseUrl ?? SITES["u1s1app.com"].apiBase
            const origin = apiOrigin(base)
            const s = siteFor(base)
            return deviceAuth(origin, s)
          },
        },
        {
          type: "oauth",
          label: "本机 u1s1 CLI 登录态",
          // the credential is already on disk (the CLI signed in some time
          // ago): a proper oauth method with nothing to open — the callback
          // verifies the credential and registers the account with magpie
          async authorize() {
            const cfg = readConfig()
            if (!cfg?.deviceToken) {
              throw new Error("本机 ~/.u1s1/config.json 没有设备凭证 — 先跑 u1s1 login 或选浏览器授权")
            }
            return {
              url: "",
              instructions: "复用本机 u1s1 CLI 已登录的设备凭证（~/.u1s1/config.json），无需浏览器操作。",
              method: "auto",
              async callback() {
                const now = readConfig()
                if (!now?.deviceToken) return { type: "failed", error: "本机 ~/.u1s1/config.json 没有设备凭证" }
                const me = await apiGET(now, "/me").catch(() => null)
                if (!me || me.status !== 200) {
                  return { type: "failed", error: "本机登录态不可用（/v1/me 返回 " + (me ? me.status : "网络错误") + "）" }
                }
                const email = typeof me.body?.email === "string" ? me.body.email : ""
                return signInResult(now, email, "cli")
              },
            }
          },
        },
      ],
      loader: async (getAuth) => {
        const auth = await getAuth()
        if (auth?.type !== "oauth") return {}
        return {
          apiKey: "u1s1",
          async fetch(url, init) {
            const body = bodyText(init?.body)
            const method = (init?.method ?? "GET").toUpperCase()
            // only model calls go through the CLI; anything else (the AI SDK's
            // count_tokens probe) is answered locally or refused
            if (new URL(url).pathname === "/v1/messages/count_tokens" || new URL(url).pathname.endsWith("/count_tokens")) {
              return textResponse(200, JSON.stringify({ input_tokens: estimateTokens(body) }))
            }
            if (method !== "POST" || !/\/v1\/messages$|\/v1\/chat\/completions$/.test(new URL(url).pathname)) {
              return textResponse(501, JSON.stringify({ error: { message: "u1s12api only answers model calls; " + new URL(url).pathname + " is not one" } }))
            }
            let req
            try {
              req = JSON.parse(body)
            } catch {
              return textResponse(400, JSON.stringify({ error: { message: "a request that isn't JSON" } }))
            }
            const stream = req?.stream ?? false
            const tools = offeredTools(req?.tools, req?.tool_choice)
            const toolOptions = { tools, toolChoice: req?.tool_choice }
            // only the streaming path builds a ReadableStream; the non-stream
            // path waits for the CLI run and returns one JSON body. Building
            // the stream for a non-stream request would start the CLI run in
            // the stream's start(), then run it again below and collide.
            if (init?.signal?.aborted) throw new Error("the request was aborted")
            if (stream) {
              const aborter = new AbortController()
              const signal = init?.signal ? AbortSignal.any([init.signal, aborter.signal]) : aborter.signal
              const id = "chatcmpl-" + randomUUID().slice(0, 12)
              const created = Math.floor(Date.now() / 1000)
              const encoder = new TextEncoder()
              const inputTokens = estimateTokens(body)
              let cancelled = false
              let spoken = ""
              const output = new ExternalToolOutput(tools)
              const reader = new ReadableStream({
                start(controller) {
                  const emit = (delta, finish_reason = null, usage = null) => controller.enqueue(encoder.encode("data: " + JSON.stringify({
                    id, object: "chat.completion.chunk", created, model: req.model,
                    ...(usage ? { usage } : {}),
                    choices: [{ delta, index: 0, finish_reason }],
                  }) + "\n\n"))
                  runCLI(req.messages ?? [], { ...toolOptions, model: req.model, signal, onText: (text) => {
                    const content = output.push(text)
                    if (content) {
                      spoken += content
                      emit({ content })
                    }
                  } })
                    .then(() => {
                      if (cancelled) return
                      const result = output.finish()
                      if (result.content) {
                        spoken += result.content
                        emit({ content: result.content })
                      }
                      for (const [index, call] of result.calls.entries()) emit({ tool_calls: [{ index, ...call }] })
                      if (result.calls.length) spoken += JSON.stringify(result.calls)
                      emit({}, result.calls.length ? "tool_calls" : "stop", estimatedUsage(result, body, spoken, inputTokens))
                      controller.enqueue(encoder.encode("data: [DONE]\n\n"))
                      controller.close()
                    })
                    .catch((error) => { if (!cancelled) controller.error(error) })
                },
                cancel() { cancelled = true; aborter.abort() },
              })
              return new Response(reader, { headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache" } })
            }
            const r = await runCLI(req.messages ?? [], { ...toolOptions, model: req.model, signal: init?.signal })
            const result = parseToolOutput(r.text, tools)
            const spoken = (result.content ?? "") + (result.calls.length ? JSON.stringify(result.calls) : "")
            return textResponse(200, JSON.stringify({
              id: "chatcmpl-" + randomUUID().slice(0, 12),
              object: "chat.completion",
              created: Math.floor(Date.now() / 1000),
              model: r.model ?? req.model,
              choices: [{ index: 0, message: { role: "assistant", content: result.content || (result.calls.length ? null : ""), ...(result.calls.length ? { tool_calls: result.calls } : {}) }, finish_reason: result.calls.length ? "tool_calls" : "stop" }],
              usage: estimatedUsage(result, body, spoken, estimateTokens(body)),
            }))
          },
        }
      },
      usage: async (getAuth) => {
        const cfg = readConfig()
        if (!cfg?.deviceToken) return { error: "not signed in", signIn: "kept" }
        try {
          const me = await apiGET(cfg, "/me")
          if (me.status !== 200) return { error: "the u1s1 API returned " + me.status + ": " + clip(me.body?.error?.message ?? me.body), signIn: me.status === 401 ? "expired" : "kept" }
          return usageOf(me.body)
        } catch (e) {
          return { error: e?.message ?? String(e) }
        }
      },
      checkin: async (getAuth) => {
        const cfg = readConfig()
        if (!cfg?.deviceToken) throw new Error("not signed in")
        const s = site()
        // claim first: this is what actually credits the daily pack. It needs
        // the website session (login-once.mjs), not the CLI device token.
        const claimed = await claimDailyCheckin(s)
        if (claimed) return claimed
        // no usable website session: report today's state and point the user
        // at the one-time login (or the dashboard)
        const me = await apiGET(cfg, "/me")
        if (me.status !== 200) throw new Error("the u1s1 API returned " + me.status + ": " + clip(me.body?.error?.message ?? me.body))
        const state = checkinOf(me.body, s)
        if (state.outcome === "inactive" && !readWebSession()?.cookieHeader) {
          state.message = "今日尚未打卡，且没有网站登录态：运行一次 login-once.mjs（浏览器已登录 u1s1 即可），之后每天自动打卡。"
        }
        return state
      },
    },
    provider: {
      id: PROVIDER,
      models: async (p, { auth } = {}) => {
        const cfg = readConfig()
        if (!cfg?.deviceToken) return p.models
        try {
          const answer = await apiGET(cfg, "/models")
          if (answer.status !== 200 || !Array.isArray(answer.body?.data)) return p.models
          const out = {}
          for (const m of answer.body.data) {
            if (!m?.id) continue
            const was = p.models?.[m.id] ?? {}
            out[m.id] = {
              ...was,
              id: m.id,
              name: was?.name ?? m.name ?? m.id,
              limit: { ...(was?.limit ?? {}), context: m.context_length > 0 ? m.context_length : undefined },
              tool_call: was?.tool_call ?? true,
            }
          }
          return Object.keys(out).length ? out : p.models
        } catch {
          return p.models
        }
      },
    },
  }
}

// ---- helpers --------------------------------------------------------------

function bodyText(body) {
  if (body == null) return ""
  if (typeof body === "string") return body
  if (body instanceof Uint8Array) return Buffer.from(body).toString("utf8")
  return String(body)
}

function textResponse(status, text) {
  return new Response(text, { status, headers: { "content-type": "application/json" } })
}

// estimatedUsage builds the usage block Magpie's session view reads as 输入/输出.
// The CLI's print mode reports no token accounting (verified: stdout carries
// only the reply), so input is the request body estimate (which the SDK's own
// count_tokens probe already uses) and output is the reply text estimate.
function estimatedUsage(result, body, spoken, inputTokens) {
  const prompt_tokens = inputTokens || estimateTokens(body)
  const completion_tokens = estimateTextTokens(spoken)
  return { prompt_tokens, completion_tokens, total_tokens: prompt_tokens + completion_tokens }
}

// estimateTokens is a rough count for the SDK's count_tokens probe; it counts
// the request body the way the model sees it. The CLI would count the real
// thing, but print mode does not expose it.
function estimateTokens(body) {
  try {
    const req = JSON.parse(body)
    const text = JSON.stringify(req?.messages ?? []).length
    return Math.ceil(text / 4)
  } catch {
    return 0
  }
}

// estimateTextTokens approximates output tokens from reply text: CJK glyphs
// are close to one token each, most latin scripts average ~4 chars/token.
function estimateTextTokens(text) {
  const value = typeof text === "string" ? text : text == null ? "" : String(text)
  if (!value) return 0
  let cjk = 0
  for (const char of value) {
    const code = char.codePointAt(0)
    if (code >= 0x4e00 && code <= 0x9fff) cjk += 1 // CJK unified
    else if (code >= 0x3000 && code <= 0x30ff) cjk += 1 // CJK punctuation / kana
  }
  const latin = Math.max(0, value.length - cjk)
  return cjk + Math.ceil(latin / 4)
}

function packPrompt(messages, options = {}) {
  const items = Array.isArray(messages) ? messages : []
  const images = []
  const contentText = (content) => {
    if (typeof content === "string") return content
    if (!Array.isArray(content)) return content == null ? "" : JSON.stringify(content)
    return content.map((block) => {
      if (block?.type === "text" || block?.type === "input_text") return block.text ?? ""
      if (block?.type === "image" || block?.type === "image_url") {
        images.push(block)
        return "[图片：文本模式未携带]"
      }
      if (block?.type === "tool_result") return "[工具结果 " + (block.tool_use_id ?? "") + "] " + contentText(block.content)
      if (block?.type === "tool_use") return "[外部工具调用] " + JSON.stringify({ id: block.id, name: block.name, arguments: block.input })
      return ""
    }).filter(Boolean).join("\n")
  }
  const parts = items.map((message) => {
    const calls = (message?.tool_calls ?? []).map(call => "[外部工具调用] " + JSON.stringify({ id: call.id, name: call.function?.name, arguments: call.function?.arguments }))
    const text = [contentText(message?.content), ...calls].filter(Boolean).join("\n")
    if (!text) return ""
    const label = message?.role === "tool" ? "工具结果 " + (message.tool_call_id ?? "") : { system: "系统", developer: "开发者", assistant: "助手" }[message?.role]
    return label ? "[" + label + "] " + text : message?.role === "user" ? text : ""
  })
  const text = parts.filter(Boolean).join("\n\n") || "(继续)"
  const protocol = toolProtocol(options.tools, options.toolChoice)
  const packed = prompt => ({ prompt: protocol ? prompt + "\n\n" + protocol : prompt, images })
  if (text.length <= MAX_PROMPT_CHARS) return packed(text)
  const marker = "[工具结果已截断，保留最近对话以避免 CLI 参数过长]\n\n"
  const latestIndex = items.findLastIndex((message) => message?.role === "user")
  const latest = latestIndex < 0 ? "" : parts[latestIndex]
  const available = MAX_PROMPT_CHARS - marker.length
  if (latest.length >= available) return packed(marker + latest.slice(-available))
  const history = parts.filter((_, index) => index !== latestIndex).filter(Boolean).join("\n\n")
  const separator = latest ? "\n\n" : ""
  const budget = Math.max(0, available - latest.length - separator.length)
  return packed(marker + (budget ? history.slice(-budget) : "") + separator + latest)
}

export const _internal = {
  PROVIDER,
  SITES,
  ICON,
  CONFIG_PATH,
  WEB_SESSION_PATH,
  cliEntry,
  siteFor,
  readConfig,
  writeConfig,
  readWebSession,
  writeWebSession,
  refreshWebSessionViaCdp,
  ensureWebSession,
  claimDailyCheckin,
  configFor,
  generateKeyPair,
  deviceAuth,
  signInResult,
  signHeaders,
  apiGET,
  usageOf,
  checkinOf,
  packageLabel,
  packageGroups,
  nextBeijingMidnight,
  RpcWorker,
  bodyText,
  estimateTokens,
  estimateTextTokens,
  estimatedUsage,
  packPrompt,
  MAX_PROMPT_CHARS,
  htu,
  isB64Url,
}
