// magpie's auth.refresh: the session signed on again ahead of time, as the
// fields that changed, once for the account with the request path's own
// renewal, and a passToken Xiaomi no longer takes is signIn "expired".
import { afterEach, expect, test } from "bun:test"
import { MimoAuthPlugin } from "./index.mjs"

const real = globalThis.fetch
afterEach(() => (globalThis.fetch = real))

const BASE = "https://mimo-server-sgp.xiaomimimo.com/api"
const CREDS = JSON.stringify({ userId: "42", passToken: "pt", deviceId: "pc_1", region: "SGP", base: BASE })
const account = (expires) => ({ type: "oauth", refresh: CREDS, access: JSON.stringify({ serviceToken: "st-1", userId: "42" }), expires, accountId: "42" })

// serve answers the sign-on (/user/xiaomi/me) with me, and a chat with 200;
// signOns counts the sign-ons, saves what the plugin saved itself
function serve(me = () => signedOn("st-2")) {
  const s = { signOns: 0, saves: [], chats: [] }
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(String(url))
    if (u.pathname.endsWith("/user/xiaomi/me")) {
      s.signOns++
      await new Promise((r) => setTimeout(r, 30))
      return me()
    }
    s.chats.push(new Headers(init.headers).get("Cookie"))
    return new Response("{}", { headers: { "content-type": "application/json" } })
  }
  s.client = { auth: { set: async ({ body }) => s.saves.push(body) } }
  return s
}
const signedOn = (token) => new Response(JSON.stringify({ code: 0, data: { userId: "42" } }), { headers: { "set-cookie": `serviceToken=${token}; Path=/` } })

test("signs on again and gives the new session, saving nothing itself", async () => {
  const s = serve()
  const hooks = await MimoAuthPlugin({ client: s.client })
  expect(hooks.auth.refreshLead).toBe(10 * 60 * 1000)
  const before = Date.now()
  const got = await hooks.auth.refresh(account(Date.now() + 60_000))
  expect(Object.keys(got).sort()).toEqual(["access", "expires"])
  expect(JSON.parse(got.access)).toEqual({ serviceToken: "st-2" })
  expect(got.expires).toBeGreaterThanOrEqual(before + 24 * 3600 * 1000)
  expect(s.signOns).toBe(1)
  expect(s.saves).toEqual([])
  // handed the old sign-in again before magpie's save landed, it gives the
  // session it got rather than signing on again
  expect(await hooks.auth.refresh(account(Date.now() + 60_000))).toEqual(got)
  expect(s.signOns).toBe(1)
})

test("one sign-on with a request renewing at the same time", async () => {
  const s = serve()
  const hooks = await MimoAuthPlugin({ client: s.client })
  const stale = account(Date.now() - 1)
  const opts = await hooks.auth.loader(async () => stale)
  const [got, res] = await Promise.all([
    hooks.auth.refresh(stale),
    opts.fetch(opts.baseURL + "/chat/completions", { method: "POST", body: '{"model":"mimo-pro"}' }),
  ])
  expect(s.signOns).toBe(1)
  expect(JSON.parse(got.access)).toEqual({ serviceToken: "st-2" })
  expect(res.headers.get("X-Magpie-Sign-In")).toBe("renewed")
  expect(s.chats).toEqual(["serviceToken=st-2"])
})

test("a passToken Xiaomi no longer takes is signIn expired", async () => {
  const s = serve(() => new Response("<html>sign in</html>", { status: 200 }))
  const hooks = await MimoAuthPlugin({ client: s.client })
  const e = await hooks.auth.refresh(account(Date.now() + 60_000)).catch((e) => e)
  expect(e).toBeInstanceOf(Error)
  expect(e.signIn).toBe("expired")
  expect(e.message).toContain("sign in again")
})

test("any other failure throws plainly", async () => {
  const s = serve(() => {
    throw new TypeError("connection reset")
  })
  const hooks = await MimoAuthPlugin({ client: s.client })
  const e = await hooks.auth.refresh(account(Date.now() + 60_000)).catch((e) => e)
  expect(e).toBeInstanceOf(Error)
  expect(e.signIn).toBeUndefined()
  expect(e.message).toContain("connection reset")
})

test("nothing to renew with is undefined", async () => {
  const s = serve()
  const hooks = await MimoAuthPlugin({ client: s.client })
  expect(await hooks.auth.refresh({ type: "api", key: "k" })).toBeUndefined()
  expect(await hooks.auth.refresh({ type: "oauth", refresh: "not json", access: "{}", expires: 1 })).toBeUndefined()
  expect(await hooks.auth.refresh({ type: "oauth", refresh: JSON.stringify({ userId: "42" }), access: "{}", expires: 1 })).toBeUndefined()
  expect(s.signOns).toBe(0)
})
