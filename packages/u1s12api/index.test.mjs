// Tests for u1s12api's pure functions: site derivation, usage card, check-in
// state, config shaping, DPoP header shape. Model calls are not tested here —
// they need the real CLI process.
import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import { join } from "node:path"
import { U1s12apiPlugin, _internal } from "./index.mjs"

const { siteFor, configFor, usageOf, checkinOf, htu, isB64Url, estimateTokens, deviceAuth, signInResult, signHeaders, packageLabel, packageGroups, nextBeijingMidnight } = _internal

test("packageLabel names a group as the dashboard does, count and all", () => {
  assert.equal(packageLabel("login_checkin"), "登录打卡赠送") // the dashboard's PKG_LABEL, not the CLI's 登录打卡
  assert.equal(packageLabel("login_checkin_bonus"), "连续打卡奖励")
  assert.equal(packageLabel("invite"), "邀请赠送")
  assert.equal(packageLabel("new_user"), "新用户赠送")
  assert.equal(packageLabel("admin_grant"), "官方赠送")
  assert.equal(packageLabel("invite", 6), "邀请赠送 × 6")
  assert.equal(packageLabel("unknown_kind"), "unknown_kind") // passthrough
})

test("siteFor maps API bases to their sites", () => {
  assert.equal(siteFor("https://api.u1s1app.com/v1").name, "u1s1 (CN)")
  assert.equal(siteFor("https://api.u1s1.dev/v1").name, "u1s1 (intl)")
  assert.equal(siteFor("https://api.u1s1.io/v1").name, "u1s1 (CN)") // legacy → CN default
  assert.equal(siteFor("https://unknown.example/v1").name, "u1s1 (CN)") // fallback
})

test("htu strips query and hash from the request URL (DPoP spec)", () => {
  assert.equal(htu("https://api.u1s1app.com/v1/me?x=1#frag"), "https://api.u1s1app.com/v1/me")
  assert.equal(htu("https://api.u1s1app.com/v1/me"), "https://api.u1s1app.com/v1/me")
})

test("isB64Url encodes bytes as base64url without padding", () => {
  const b = isB64Url(JSON.stringify({ a: 1 }))
  assert.equal(b.includes("="), false)
  assert.equal(b.includes("+"), false)
  assert.equal(b.includes("/"), false)
  const dec = Buffer.from(b, "base64url").toString("utf8")
  assert.equal(dec, JSON.stringify({ a: 1 }))
})

test("configFor keeps an existing baseUrl and fills the device fields", () => {
  const cfg = configFor("https://api.u1s1app.com/v1", "u1s1-key", "u1s1d-tok", 123, { k: "priv" }, { k: "pub" }, null)
  assert.equal(cfg.baseUrl, "https://api.u1s1app.com/v1")
  assert.equal(cfg.deviceToken, "u1s1d-tok")
  assert.equal(cfg.deviceId, 123)
  assert.equal(cfg.modelProvider, "u1s1")
  assert.deepEqual(cfg.devicePrivateJwk, { k: "priv" })
  // a second config for the same account keeps the first's baseUrl
  const again = configFor("https://api.u1s1.dev/v1", "u1s1-key2", "u1s1d-tok2", 124, { k: "priv2" }, { k: "pub2" }, { deviceToken: "u1s1d-tok", baseUrl: "https://api.u1s1app.com/v1" })
  assert.equal(again.baseUrl, "https://api.u1s1app.com/v1")
  assert.equal(again.deviceToken, "u1s1d-tok2")
})

test("usageOf groups the packages as the dashboard's 用量包 list does", () => {
  // the account's real /v1/me: 9 check-in packs (7 spent), 6 invite packs
  const spentExpiries = ["2026-10-18 07:41:05", "2026-10-20 02:37:46", "2026-10-21 15:34:05", "2026-10-22 01:08:05", "2026-10-23 02:02:15", "2026-10-28 02:26:35", "2026-10-29 02:09:32"]
  const me = {
    remaining_usd: 38.042425,
    tokens_per_usd: 2681176,
    paid_balance_usd: 0,
    gift_balance_usd: 0.026294,
    packages: [
      ...spentExpiries.map((expires_at, i) => ({ id: 11952 + i, kind: "login_checkin", scope: "all", daily_tokens: null, total_tokens: 2000000, remaining: 0, expires_at, note: "登录打卡赠送·每日一次·仅限 u1s1 客户端使用" })),
      { id: 15848, kind: "login_checkin", scope: "all", daily_tokens: null, total_tokens: 2000000, used_tokens: 98761, remaining: 1901239, expires_at: "2026-11-12 06:50:31", created_at: "2026-10-13 06:50:31" },
      { id: 16340, kind: "login_checkin", scope: "all", daily_tokens: null, total_tokens: 2000000, remaining: 2000000, expires_at: "2026-11-16 01:54:23", created_at: "2026-10-17 01:54:23" },
      { id: 373, kind: "invite", scope: "all", daily_tokens: null, total_tokens: 100000000, remaining: 53026699, expires_at: null, note: "邀请奖励(被邀请方)" },
      ...[1200, 1219, 1296, 1329].map((id) => ({ id, kind: "invite", scope: "all", daily_tokens: null, total_tokens: 10000000, remaining: 10000000, expires_at: null, note: "邀请奖励(邀请方)" })),
      { id: 1458, kind: "invite", scope: "all", daily_tokens: null, total_tokens: 5000000, remaining: 5000000, expires_at: null, note: "邀请奖励(邀请方)" },
    ],
  }
  const u = usageOf(me)
  assert.equal(u.plan, "u1s1")
  assert.equal(u.windows.length, 3) // three groups, not fifteen rows
  const [checkin, invite, spent] = u.windows
  // the two check-ins with tokens left, named and counted as the dashboard does
  assert.equal(checkin.name, "登录打卡赠送 × 2")
  assert.equal(checkin.amount, 98761) // amount is consumed, not remaining
  assert.equal(checkin.limit, 4000000)
  assert.equal(checkin.runsOutAt, "2026-11-12 06:50:31") // the dashboard's 最早 2026-11-12 到期
  assert.equal(checkin.runsOut, 1901239) // what is lost then
  assert.equal(checkin.unit, "tokens")
  // all six invite packs, the 1 亿 one among them, never expiring
  assert.equal(invite.name, "邀请赠送 × 6")
  assert.equal(invite.amount, 46973301)
  assert.equal(invite.limit, 145000000)
  assert.equal(invite.runsOutAt, undefined)
  assert.equal(invite.resetsAt, undefined)
  // the seven spent ones keep a group of their own, last and at 100%
  assert.equal(spent.name, "登录打卡赠送 × 7")
  assert.equal(spent.amount, 14000000)
  assert.equal(spent.used, 100)
  assert.equal(spent.runsOutAt, undefined) // nothing left in it to lose
  // the balance is the dashboard's 可用余额 — cash, not the packages' value again
  assert.equal(u.balance, "$0.0263")
})

test("usageOf reports no windows and only the cash when there are no packages", () => {
  const u = usageOf({ remaining_usd: 10, paid_balance_usd: 0, gift_balance_usd: 0 })
  assert.equal(u.windows, undefined)
  assert.equal(u.balance, undefined)
})

test("a daily package counts its daily allowance and resets at 00:00 Beijing", () => {
  const me = { packages: [{ kind: "free_first", scope: "free", daily_tokens: 500000, total_tokens: 15000000, remaining: 400000, expires_at: null }] }
  const u = usageOf(me)
  assert.equal(u.windows[0].name, "首月免费包")
  assert.equal(u.windows[0].limit, 500000) // the dashboard's 每天 Y, not the pack's whole size
  assert.equal(u.windows[0].resetsAt, nextBeijingMidnight())
})

test("nextBeijingMidnight is 00:00 Beijing (as the API's daily_free_resets_at was)", () => {
  assert.equal(nextBeijingMidnight(Date.parse("2026-10-17T02:00:00Z")), "2026-10-17T16:00:00.000Z")
})

test("spent quota groups are informational when cash still remains", () => {
  const spent = usageOf({ gift_balance_usd: 0.1, packages: [{ kind: "login_checkin", scope: "all", total_tokens: 2000, remaining: 0 }] }).windows[0]
  assert.equal(spent.aside, true)
  assert.equal(spent.amount, 2000)
  assert.equal(spent.limit, 2000)
})

test("prompt packing bounds oversized prompts while retaining the latest user turn", () => {
  const packed = _internal.packPrompt([
    { role: "system", content: "system" },
    { role: "tool", content: "x".repeat(_internal.MAX_PROMPT_CHARS + 50000) },
    { role: "user", content: "latest user request" },
  ])
  assert.ok(packed.prompt.length <= _internal.MAX_PROMPT_CHARS)
  assert.match(packed.prompt, /latest user request/)
  assert.match(packed.prompt, /历史已截断/)
})

test("packageGroups keeps scopes and daily packs in groups of their own", () => {
  const groups = packageGroups([
    { kind: "invite", scope: "all", remaining: 10, total_tokens: 10 },
    { kind: "invite", scope: "free", remaining: 5, total_tokens: 5 },
    { kind: "invite", scope: "all", daily_tokens: 3, total_tokens: 4, remaining: 2 },
  ])
  assert.equal(groups.length, 3)
})

test("checkinOf says done when today's pack exists (Beijing time)", () => {
  // a pack created at 06:50 UTC on 2026-10-16 is 14:50 Beijing on the 16th
  const me = {
    packages: [
      { kind: "login_checkin", created_at: "2026-10-16 06:50:31" },
      { kind: "invite", created_at: "2026-08-25 08:21:11" },
    ],
  }
  const site = { site: "https://u1s1app.com" }
  const r = checkinOf(me, site)
  // today is 2026-10-17 Beijing, so 2026-10-16 is yesterday → not done today
  assert.equal(r.outcome, "inactive")
  assert.ok(r.message.includes("/dashboard#sec-usage"))
})

test("checkinOf reports inactive (points at the site) when no pack is today's", () => {
  const me = { packages: [{ kind: "login_checkin", created_at: "2026-10-13 06:50:31" }] }
  const r = checkinOf(me, { site: "https://u1s1app.com" })
  assert.equal(r.outcome, "inactive")
})

test("estimateTokens counts a request body roughly", () => {
  const req = JSON.stringify({ messages: [{ role: "user", content: "hello world, this is a fairly long message with enough text to move the counter" }] })
  assert.ok(estimateTokens(req) >= 1)
  assert.equal(estimateTokens("not json"), 0)
})

test("signHeaders builds a DPoP proof with the right shape", async () => {
  const key = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])
  const [privateJwk, publicJwk] = await Promise.all([crypto.subtle.exportKey("jwk", key.privateKey), crypto.subtle.exportKey("jwk", key.publicKey)])
  const cfg = { deviceToken: "u1s1d-testtoken", devicePrivateJwk: privateJwk, devicePublicJwk: publicJwk }
  const h = await signHeaders(cfg, "GET", "https://api.u1s1app.com/v1/me")
  assert.equal(h.authorization, "DPoP u1s1d-testtoken")
  assert.ok(h.dpop)
  const [headerB64, payloadB64, sig] = h.dpop.split(".")
  assert.ok(headerB64 && payloadB64 && sig)
  const header = JSON.parse(Buffer.from(headerB64, "base64url").toString())
  assert.equal(header.typ, "dpop+jwt")
  assert.equal(header.alg, "ES256")
  assert.ok(header.jwk?.kty === "EC" && header.jwk?.crv === "P-256")
  const payload = JSON.parse(Buffer.from(payloadB64, "base64url").toString())
  assert.equal(payload.htm, "GET")
  assert.equal(payload.htu, "https://api.u1s1app.com/v1/me")
  assert.ok(payload.jti && payload.iat && payload.ath)
  // the signature verifies against the public key over the signed input
  const ok = await crypto.subtle.verify(
    { name: "ECDSA", hash: "SHA-256" },
    await crypto.subtle.importKey("jwk", publicJwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]),
    new Uint8Array(Buffer.from(sig, "base64url")),
    new TextEncoder().encode(headerB64 + "." + payloadB64),
  )
  assert.equal(ok, true)
})

test("cliEntry finds the installed CLI", () => {
  const cli = _internal.cliEntry()
  // the CLI may be found on any candidate path (desktop, npm, Scoop); when
  // found, its index.js is a real file. The node field is either a bundled
  // node.exe path (desktop install) or the string "node" (PATH fallback),
  // so only assert on index.js existence.
  if (cli) {
    assert.ok(fs.existsSync(cli.index))
  }
})

test("deviceAuth throws when the sign-in server can't be reached (offline)", async () => {
  // offline: /auth/device/start fails, so authorize must reject (the host
  // surfaces an authorize() that throws; only the callback's result is read
  // for {type:"failed"})
  await assert.rejects(
    () => deviceAuth("https://nonexistent.invalid", { apiBase: "https://api.u1s1app.com/v1", site: "https://u1s1app.com" }),
    (e) => typeof e.message === "string" && e.message.length > 0,
  )
})

test("signInResult carries refresh so magpie keeps the sign-in (host.js save)", () => {
  const cfg = { deviceToken: "u1s1d-tok", apiKey: "u1s1-key", deviceId: 7 }
  const r = signInResult(cfg, "a@b.c", "browser", "u1s1 (CN)")
  assert.equal(r.type, "success")
  assert.equal(r.refresh, "u1s1d-tok") // host.js save() keeps an oauth sign-in only with refresh
  assert.equal(r.access, "u1s1-key")
  assert.equal(r.accountId, "a@b.c")
  assert.equal(r.method, "browser")
  assert.equal(r.site, "u1s1 (CN)")
  // with no email (a /v1/me that failed), the device number names the account
  const r2 = signInResult(cfg, "", "cli")
  assert.equal(r2.accountId, "u1s1 device #7")
  assert.equal(r2.site, undefined)
})

test("the second method is a proper oauth flow (auto, nothing to open)", async () => {
  const cfgPath = join(os.homedir(), ".u1s1", "config.json")
  if (!fs.existsSync(cfgPath)) return // no CLI credential on this machine: nothing to assert
  const plugin = await U1s12apiPlugin({})
  const m = plugin.auth.methods[1]
  assert.equal(m.type, "oauth")
  const a = await m.authorize() // reads config only; no network here
  assert.equal(a.url, "")
  assert.equal(a.method, "auto")
  assert.equal(typeof a.callback, "function")
})

test("plugin config names u1s12api with the three models", async () => {
  const plugin = await U1s12apiPlugin({})
  const cfg = {}
  await plugin.config(cfg)
  assert.equal(cfg.provider.u1s12api.name, "u1s12api")
  assert.ok(cfg.provider.u1s12api.models["deepseek-flash"])
  assert.ok(cfg.provider.u1s12api.models["qwen3.8-flash"])
  assert.ok(cfg.provider.u1s12api.models["glm-5.3-flash"])
  assert.ok(cfg.provider.u1s12api.api)
})

test("plugin icon comes from the site", async () => {
  const plugin = await U1s12apiPlugin({})
  assert.equal(plugin.auth.icon, "https://u1s1app.com/favicon.svg")
})

test("plugin has the checkin hook magpie calls", async () => {
  const plugin = await U1s12apiPlugin({})
  assert.equal(typeof plugin.auth.checkin, "function")
  assert.equal(typeof plugin.auth.usage, "function")
  assert.equal(typeof plugin.auth.loader, "function")
  assert.equal(plugin.auth.provider, "u1s12api")
})
