// auth.usage tells what magpie's built-in MiMo account shows
// (internal/provider/mimo_usage.go), against the MiMo server's replies as
// its tests give them (mimo_test.go).
import { afterEach, expect, test } from "bun:test"
import { MimoAuthPlugin, _internal } from "./index.mjs"

const real = globalThis.fetch
afterEach(() => (globalThis.fetch = real))

const BASE = "https://mimo-server-sgp.xiaomimimo.com/api"
const SELF = { code: 0, data: { current: { planCode: "mimo_pro_m", title: "MiMo 高阶", planTier: 3, status: "ACTIVE", renewalMode: "MONTHLY", endTime: "2026-11-01T00:00:00", source: "ORDER_SUB" } } }
const USAGE = { code: 0, data: { percent: 70, resetDate: "2026-10-05" } }

const account = (expires = Date.now() + 3_600_000) => ({
  type: "oauth",
  refresh: JSON.stringify({ userId: "42", passToken: "pt", deviceId: "pc_1", region: "SGP", base: BASE }),
  access: JSON.stringify({ serviceToken: "st-1", userId: "42" }),
  expires,
  accountId: "42",
})

// the open platform with no Token Plan to read: its pages turn away an
// account they can't sign on
const noPlatform = () => json({ code: 401 }, 401)

async function plugin(auth, serve, platform = noPlatform) {
  const seen = []
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(String(url))
    if (u.host === "platform.xiaomimimo.com" || u.host === "account.xiaomi.com") return platform(u, new Headers(init.headers))
    seen.push(u.pathname)
    return serve(u.pathname, new Headers(init.headers))
  }
  const client = { auth: { set: async ({ body }) => (auth = body) } }
  const hooks = await MimoAuthPlugin({ client })
  return { usage: () => hooks.auth.usage(async () => auth), seen }
}

const json = (v, status = 200) => new Response(JSON.stringify(v), { status, headers: { "Content-Type": "application/json" } })

test("the plan, its end and renewal, and the week's allowance", async () => {
  const p = await plugin(account(), (path, h) => {
    expect(h.get("Cookie")).toBe("serviceToken=st-1; userId=42")
    expect(h.get("X-Client-Version")).toBeTruthy()
    return path === "/api/user/usage" ? json(USAGE) : json(SELF)
  })
  expect(await p.usage()).toEqual({
    plan: "MiMo 高阶",
    until: "2026-10-31T16:00:00.000Z", // 2026-11-01 00:00 in UTC+8
    renew: "auto",
    windows: [{ name: "7 days", used: 30, span: 604800, resetsAt: "2026-10-04T16:00:00.000Z" }],
    signIn: "kept",
  })
  expect(p.seen).toEqual(["/api/user/xiaomi/subscription/self", "/api/user/usage"])
})

test("no plan is the free offer, with no allowance shown", async () => {
  const p = await plugin(account(), (path) => (path === "/api/user/usage" ? json({ code: 0, data: { percent: 100, resetDate: null } }) : json({ code: 0, data: { current: null } })))
  expect(await p.usage()).toEqual({ plan: "Free", signIn: "kept" })
})

test("a plan named by its tier, else its code; a one-time plan doesn't renew", async () => {
  const sub = (current) => async () => {
    const p = await plugin(account(), (path) => (path === "/api/user/usage" ? json({ code: 0, data: {} }) : json({ code: 0, data: { current } })))
    return p.usage()
  }
  expect(await sub({ title: " ", planTier: 4, renewalMode: "ONE_TIME", endTime: "2026-11-01 08:30:00" })()).toEqual({ plan: "Ultra", until: "2026-11-01T00:30:00.000Z", renew: "off", signIn: "kept" })
  expect(await sub({ planTier: 9, planCode: "mimo_x" })()).toEqual({ plan: "mimo_x", signIn: "kept" })
  expect(await sub({})()).toEqual({ plan: "MiMo", signIn: "kept" })
})

test("the allowance unread leaves the plan alone; a refused sign-in says so", async () => {
  let p = await plugin(account(), (path) => (path === "/api/user/usage" ? json({ code: 500, msg: "busy" }) : json(SELF)))
  expect(await p.usage()).toEqual({ plan: "MiMo 高阶", until: "2026-10-31T16:00:00.000Z", renew: "auto", signIn: "kept" })

  // the session turned away, and the passToken no longer signs it on
  p = await plugin(account(), (path) => {
    if (path === "/api/user/xiaomi/subscription/self") return new Response("", { status: 401 })
    if (path === "/api/user/xiaomi/me") return new Response("<html>sign in</html>", { status: 200 })
    return new Response("", { status: 404 })
  })
  expect(await p.usage()).toEqual({ error: "42: the Xiaomi MiMo sign-in has expired — sign in again", signIn: "expired" })
})

test("two accounts signing on at once each keep their own session", async () => {
  const stale = (uid, host) => ({
    type: "oauth",
    refresh: JSON.stringify({ userId: uid, passToken: "pt-" + uid, deviceId: "d", base: `https://${host}/api` }),
    access: JSON.stringify({ serviceToken: "old-" + uid }),
    expires: 0,
    accountId: uid,
  })
  const asked = []
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(String(url))
    if (u.host === "platform.xiaomimimo.com") return noPlatform()
    if (u.pathname.endsWith("/user/xiaomi/me")) {
      await new Promise((r) => setTimeout(r, 30))
      const uid = u.host[0].toUpperCase()
      return new Response(JSON.stringify({ code: 0, data: { userId: uid } }), { headers: { "set-cookie": `serviceToken=st-${uid}; Path=/` } })
    }
    asked.push(`${u.host} ${new Headers(init.headers).get("Cookie")}`)
    return u.pathname.endsWith("/self") ? json({ code: 0, data: { current: { title: "plan of " + u.host } } }) : json(USAGE)
  }
  const hooks = await MimoAuthPlugin({ client: { auth: { set: async () => {} } } })
  const A = stale("A", "a.example"),
    B = stale("B", "b.example")
  const [a, b] = await Promise.all([hooks.auth.usage(async () => A), hooks.auth.usage(async () => B)])
  expect(a.plan).toBe("plan of a.example")
  expect(b.plan).toBe("plan of b.example")
  for (const x of asked) expect(x).toContain(x.startsWith("a.") ? "serviceToken=st-A" : "serviceToken=st-B")
})

// the open platform's Token Plan, as the reporter's account answered
// (Lite, 2026-10-07): a page asked with no session is 401 with a
// serviceLogin URL, which the passToken follows through /sts back to it
const LOGIN = "https://account.xiaomi.com/pass/serviceLogin?callback=https%3A%2F%2Fplatform.xiaomimimo.com%2Fsts%3Fsign%3DsJaoCJbfw5dWz7lcIbXMHnGQnS0%253D%26followup%3Dhttp%253A%252F%252Fplatform.xiaomimimo.com%252Fapi%252Fv1%252FtokenPlan%252Fdetail&sid=api-platform&_group=DEFAULT"
const DETAIL = '{"code":0,"message":"","data":{"planCode":"lite","planName":"Lite","currentPeriodEnd":"2026-11-06 23:59:59","expired":false,"enableAutoRenew":true,"autoRenewDiscount":null,"hasAutoRenewSubscribed":true,"clawEnabled":false,"clawPeriodEnd":null,"clawPurchased":false}}'
const TP_USAGE = '{"code":0,"message":"","data":{"monthUsage":{"percent":0.0017,"items":[{"name":"month_total_token","used":6809408,"limit":4100000000,"percent":0.0017}]},"usage":{"percent":0.00,"items":[{"name":"plan_total_token","used":6809408,"limit":4100000000,"percent":0.00},{"name":"compensation_total_token","used":0,"limit":0,"percent":0}]}}}'
const TP_WINDOW = { name: "Token Plan · API key", used: (100 * 6809408) / 4100000000, display: "6.81M / 4.1B credits", aside: true, resetsAt: "2026-11-06T23:59:59.000Z" }

function platformOf(detail = DETAIL) {
  const p = { signOns: 0, cookies: [], key: "tp-one" }
  p.serve = (u, h) => {
    if (u.host === "account.xiaomi.com") {
      p.signOns++
      expect(h.get("Cookie")).toContain("passToken=pt")
      expect(u.searchParams.get("sid")).toBe("api-platform")
      return new Response("", { status: 302, headers: { location: "https://platform.xiaomimimo.com/sts?sign=x&followup=" + encodeURIComponent("http://platform.xiaomimimo.com/api/v1/tokenPlan/detail") } })
    }
    if (u.pathname === "/sts") {
      const r = new Response("", { status: 307, headers: { location: "http://platform.xiaomimimo.com/api/v1/tokenPlan/detail" } })
      r.headers.append("set-cookie", "api-platform_serviceToken=pst; Path=/; HttpOnly")
      r.headers.append("set-cookie", "userId=42; Domain=xiaomimimo.com; Path=/")
      return r
    }
    const c = h.get("Cookie") ?? ""
    p.cookies.push(c)
    if (!c.includes("api-platform_serviceToken=pst")) return json({ code: 401, loginUrl: LOGIN }, 401)
    if (u.pathname === "/api/v1/tokenPlan/detail") return new Response(detail, { headers: { "Content-Type": "application/json" } })
    if (u.pathname === "/api/v1/tokenPlan/usage") return new Response(TP_USAGE, { headers: { "Content-Type": "application/json" } })
    if (u.pathname === "/api/v1/tokenPlan/apiKey") return json({ code: 0, data: { id: 1, redactedApiKey: "tp-c****", openaiBaseUrl: "https://token-plan-cn.xiaomimimo.com/v1", anthropicBaseUrl: "https://token-plan-cn.xiaomimimo.com/anthropic" } })
    if (u.pathname === "/api/v1/tokenPlan/apiKey/raw") return json({ code: 0, data: p.key })
    return json({ code: 404 }, 404)
  }
  return p
}

test("no app plan but a Token Plan at the open platform: the card is the Token Plan's, its credits the allowance", async () => {
  const tp = platformOf()
  const noPlan = (path) => (path === "/api/user/usage" ? json({ code: 0, data: { percent: 0.0, resetDate: null, resetAt: null } }) : json({ code: 0, data: { groupCode: null, current: null, subscriptions: [] } }))
  const p = await plugin(account(), noPlan, tp.serve)
  // the account's requests go to the Token Plan (the app refuses them), so its credits are no aside
  const { aside, ...own } = TP_WINDOW
  const want = { plan: "Token Plan Lite", until: "2026-11-06T23:59:59.000Z", renew: "auto", windows: [{ ...own, name: "Token Plan" }], signIn: "kept" }
  expect(await p.usage()).toEqual(want)
  // the platform's session is kept: the next read doesn't sign on again
  expect(await p.usage()).toEqual(want)
  expect(tp.signOns).toBe(1)
})

test("an app plan stays the card's plan, the Token Plan's credits beside its week", async () => {
  const p = await plugin(account(), (path) => (path === "/api/user/usage" ? json(USAGE) : json(SELF)), platformOf().serve)
  expect(await p.usage()).toEqual({
    plan: "MiMo 高阶",
    until: "2026-10-31T16:00:00.000Z",
    renew: "auto",
    windows: [{ name: "7 days", used: 30, span: 604800, resetsAt: "2026-10-04T16:00:00.000Z" }, TP_WINDOW],
    signIn: "kept",
  })
})

test("no Token Plan, an expired one, or a platform that can't be read: the free offer as before", async () => {
  const noPlan = (path) => (path === "/api/user/usage" ? json({ code: 0, data: { percent: 100, resetDate: null } }) : json({ code: 0, data: { current: null } }))
  for (const detail of ['{"code":0,"message":"","data":null}', DETAIL.replace('"expired":false', '"expired":true')]) {
    const p = await plugin(account(), noPlan, platformOf(detail).serve)
    expect(await p.usage()).toEqual({ plan: "Free", signIn: "kept" })
  }
  const p = await plugin(account(), noPlan, () => json({ message: "down" }, 503))
  expect(await p.usage()).toEqual({ plan: "Free", signIn: "kept" })
})

test("credits, short", () => {
  expect(_internal.credits(6809408)).toBe("6.81M")
  expect(_internal.credits(4100000000)).toBe("4.1B")
  expect(_internal.credits(1500)).toBe("1.5K")
  expect(_internal.credits(0)).toBe("0")
})

test("a failure is the page's and the server's word", async () => {
  let p = await plugin(account(), () => json({ code: 10001, msg: "no such user" }))
  expect(await p.usage()).toEqual({ error: "Xiaomi MiMo /user/xiaomi/subscription/self: code 10001 no such user", signIn: "kept" })
  p = await plugin(account(), () => json({ message: "down" }, 503))
  expect(await p.usage()).toEqual({ error: "Xiaomi MiMo /user/xiaomi/subscription/self: down", signIn: "kept" })
})

test("the server's times", () => {
  expect(_internal.serverTime("2026-10-05")).toBe("2026-10-04T16:00:00.000Z")
  expect(_internal.serverTime("2026-10-05T12:00:00")).toBe("2026-10-05T04:00:00.000Z")
  expect(_internal.serverTime("2026-10-05T12:00:00Z")).toBe("2026-10-05T12:00:00.000Z")
  expect(_internal.serverTime("soon")).toBeUndefined()
})

// the loader's fetch, as OpenCode's engine calls it
async function loaderFetch(auth, serve) {
  const sent = []
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(String(url))
    if (u.pathname.endsWith("/route/chat/completions")) sent.push(typeof init.body === "string" ? init.body : init.body)
    return serve(u.pathname, init)
  }
  const hooks = await MimoAuthPlugin({ client: { auth: { set: async ({ body }) => (auth = body) } } })
  const l = await hooks.auth.loader(async () => auth)
  return { fetch: l.fetch, sent }
}

test("a chat body in bytes has mimo-auto asked as mimo-pro, as a string one does", async () => {
  const { fetch, sent } = await loaderFetch(account(), () => json({ ok: true }))
  const req = JSON.stringify({ model: "mimo-auto", messages: [] })
  await fetch(BASE + "/route/chat/completions", { method: "POST", body: new TextEncoder().encode(req) })
  await fetch(BASE + "/route/chat/completions", { method: "POST", body: Buffer.from(req) })
  expect(sent.map((b) => JSON.parse(b).model)).toEqual(["mimo-pro", "mimo-pro"])
})

test("a sign-in Xiaomi no longer takes is magpie's 502 in the built-in's words, marking the account, not a thrown fetch", async () => {
  const { fetch } = await loaderFetch(account(0), (path) => {
    if (path === "/api/user/xiaomi/me") return new Response("<html>sign in</html>", { status: 200 })
    return new Response("", { status: 401 })
  })
  const res = await fetch(BASE + "/route/chat/completions", { method: "POST", body: JSON.stringify({ model: "mimo-pro", messages: [] }) })
  expect(res.status).toBe(502)
  expect(res.headers.get("X-Magpie-Sign-In")).toBe("expired")
  const b = await res.json()
  expect(b.error.message).toBe("42: the Xiaomi MiMo sign-in has expired — sign in again")
  expect(b.error.type).toBe("api_error")
})

test("the server's 401 goes through as the built-in's did: not signed on again, the account unmarked", async () => {
  const asked = []
  const { fetch } = await loaderFetch(account(), (path) => {
    asked.push(path)
    return path === "/api/user/xiaomi/me" ? json({ code: 0, data: { userId: "42" } }) : json({ error: { message: "stale" } }, 401)
  })
  const res = await fetch(BASE + "/route/chat/completions", { method: "POST", body: JSON.stringify({ model: "mimo-pro", messages: [] }) })
  expect(res.status).toBe(401)
  expect(res.headers.get("X-Magpie-Sign-In")).toBe("kept")
  expect((await res.json()).error.message).toBe("stale")
  expect(asked).toEqual(["/api/route/chat/completions"])
})

test("a success takes the mark off only when the account was signed on again", async () => {
  let p = await loaderFetch(account(), () => json({ ok: true }))
  let res = await p.fetch(BASE + "/route/chat/completions", { method: "POST", body: "{}" })
  expect(res.status).toBe(200)
  expect(res.headers.get("X-Magpie-Sign-In")).toBe("kept")
  p = await loaderFetch(account(0), (path) =>
    path === "/api/user/xiaomi/me" ? new Response(JSON.stringify({ code: 0, data: { userId: "42" } }), { headers: { "set-cookie": "serviceToken=st-2; Path=/" } }) : json({ ok: true }),
  )
  res = await p.fetch(BASE + "/route/chat/completions", { method: "POST", body: "{}" })
  expect(res.status).toBe(200)
  expect(res.headers.get("X-Magpie-Sign-In")).toBe("renewed")
})

test("a failure after signing on again still takes the mark off, as mimoFresh did before the request", async () => {
  const p = await loaderFetch(account(0), (path) =>
    path === "/api/user/xiaomi/me" ? new Response(JSON.stringify({ code: 0, data: { userId: "42" } }), { headers: { "set-cookie": "serviceToken=st-2; Path=/" } }) : json({ error: { message: "stale" } }, 401),
  )
  const res = await p.fetch(BASE + "/route/chat/completions", { method: "POST", body: "{}" })
  expect(res.status).toBe(401)
  expect(res.headers.get("X-Magpie-Sign-In")).toBe("renewed")
})

test("a sign-on that can't reach the server is a thrown fetch (magpie's 502) in the built-in's words, the account unmarked", async () => {
  const noSession = { ...account(0), access: "{}" }
  const { fetch } = await loaderFetch(noSession, () => {
    throw new Error("connection refused")
  })
  await expect(fetch(BASE + "/route/chat/completions", { method: "POST", body: "{}" })).rejects.toThrow(/^Xiaomi MiMo sign-in: connection refused$/)
})

// the built-in's mimoFresh took the lapse mark off when it signed the
// account on again, and mimoLapse put it on; whichever came last stands
const signOn = () => new Response(JSON.stringify({ code: 0, data: { userId: "42" } }), { headers: { "set-cookie": "serviceToken=st-2; Path=/" } })

test("a read that signed the account on again says so, whatever the pages then answer", async () => {
  let p = await plugin(account(0), (path) => (path === "/api/user/xiaomi/me" ? signOn() : path === "/api/user/usage" ? json(USAGE) : json(SELF)))
  expect((await p.usage()).signIn).toBe("renewed")
  p = await plugin(account(0), (path) => (path === "/api/user/xiaomi/me" ? signOn() : json({ message: "down" }, 503)))
  expect(await p.usage()).toEqual({ error: "Xiaomi MiMo /user/xiaomi/subscription/self: down", signIn: "renewed" })
  // a stale session turned away, signed on again, then the allowance unread
  let n = 0
  p = await plugin(account(), (path) => {
    if (path === "/api/user/xiaomi/me") return signOn()
    if (path === "/api/user/xiaomi/subscription/self") return n++ ? json(SELF) : new Response("", { status: 401 })
    return json({ code: 500, msg: "busy" })
  })
  expect(await p.usage()).toEqual({ plan: "MiMo 高阶", until: "2026-10-31T16:00:00.000Z", renew: "auto", signIn: "renewed" })
})

test("the allowance's page refused after the plan's read marks the account", async () => {
  const p = await plugin(account(), (path) => {
    if (path === "/api/user/xiaomi/me") return new Response("<html>sign in</html>", { status: 200 })
    if (path === "/api/user/usage") return new Response("", { status: 401 })
    return json(SELF)
  })
  expect(await p.usage()).toEqual({ plan: "MiMo 高阶", until: "2026-10-31T16:00:00.000Z", renew: "auto", error: "42: the Xiaomi MiMo sign-in has expired — sign in again", signIn: "expired" })
})

// an account with no app membership but a Token Plan, as the reporter's
// (Lite, 2026-10-09): the app's /route answers every model 403
// membership_required, and the plan's endpoint takes its tp- key
const REFUSED = '{"error":{"message":"未开通会员或会员已到期，请订阅后使用","type":"permission_error","code":"membership_required","biz_code":30012}}'

async function planFetch(platform, plan) {
  const asked = []
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(String(url))
    const h = new Headers(init.headers)
    if (u.host === "platform.xiaomimimo.com" || u.host === "account.xiaomi.com") return platform.serve(u, h)
    asked.push({ host: u.host, path: u.pathname, auth: h.get("Authorization"), cookie: h.get("Cookie"), model: JSON.parse(init.body).model })
    if (u.host === "token-plan-cn.xiaomimimo.com") return plan(h)
    return new Response(REFUSED, { status: 403, headers: { "Content-Type": "application/json;charset=UTF-8" } })
  }
  const hooks = await MimoAuthPlugin({ client: { auth: { set: async () => {} } } })
  const auth = account()
  const l = await hooks.auth.loader(async () => auth)
  const ask = (model) => l.fetch(l.baseURL + "/chat/completions", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model, messages: [] }) })
  return { ask, asked }
}

test("the app refusing an account with no membership: the request goes to its Token Plan with its key, as the plan names the model", async () => {
  const tp = platformOf()
  const { ask, asked } = await planFetch(tp, (h) => json({ choices: [] }))
  let res = await ask("mimo-pro")
  expect(res.status).toBe(200)
  expect(res.headers.get("X-Magpie-Sign-In")).toBe("kept")
  expect(asked).toEqual([
    { host: "mimo-server-sgp.xiaomimimo.com", path: "/api/route/chat/completions", auth: null, cookie: "serviceToken=st-1; userId=42", model: "mimo-pro" },
    { host: "token-plan-cn.xiaomimimo.com", path: "/v1/chat/completions", auth: "Bearer tp-one", cookie: null, model: "mimo-v2.6-pro" },
  ])
  // from then on straight to the plan, the key not read again
  asked.length = 0
  res = await ask("mimo-flash")
  expect(res.status).toBe(200)
  expect(asked.map((a) => `${a.host} ${a.model}`)).toEqual(["token-plan-cn.xiaomimimo.com mimo-v2.6-flash"])
  expect(tp.signOns).toBe(1)
})

test("a key reset at the platform is read again after the plan turns the old one away", async () => {
  const tp = platformOf()
  const { ask, asked } = await planFetch(tp, (h) => (h.get("Authorization") === "Bearer " + tp.key ? json({ choices: [] }) : json({ error: { message: "Invalid API Key" } }, 401)))
  expect((await ask("mimo-pro")).status).toBe(200)
  tp.key = "tp-two"
  expect((await ask("mimo-pro")).status).toBe(401)
  expect((await ask("mimo-pro")).status).toBe(200)
  expect(asked.filter((a) => a.host.startsWith("token-plan")).map((a) => a.auth)).toEqual(["Bearer tp-one", "Bearer tp-one", "Bearer tp-two"])
})

test("no Token Plan, or one with no key: the app's refusal goes through as it is", async () => {
  for (const tp of [platformOf('{"code":0,"message":"","data":null}'), Object.assign(platformOf(), { key: null })]) {
    const { ask, asked } = await planFetch(tp, () => json({ choices: [] }))
    const res = await ask("mimo-pro")
    expect(res.status).toBe(403)
    expect(await res.text()).toBe(REFUSED)
    expect(res.headers.get("X-Magpie-Sign-In")).toBe("kept")
    expect(asked.every((a) => a.host.startsWith("mimo-server"))).toBe(true)
  }
})
