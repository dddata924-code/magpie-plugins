// Signing in with MiniMax Code's device flow, against a fake account host:
// the device code asked for as mcode asks (client mcode-public, PKCE S256),
// polled until it is approved, the account named by MiniMax's own user info.
import "./nonet.mjs"
import { afterEach, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { MiniMaxCodeAuthPlugin, MiniMaxCodeGlobalAuthPlugin } from "./index.mjs"
import { fakeMiniMax, json, jwtOf } from "./fake.mjs"

let f
afterEach(() => f?.close())

const userInfo = () => json({ statusInfo: { code: 0 }, data: { userInfo: { realUserID: "u-42", userEmail: "a@example.com", name: "Ann" } } })

test("the device flow signs in, the account named by its email", async () => {
  f = fakeMiniMax()
  let polls = 0
  f.route("POST /oauth2/device/code", () => json({
    device_code: "dev-1", user_code: "ABCD-EFGH", verification_uri: "https://account.example/device",
    verification_uri_complete: "https://account.example/device?code=ABCD-EFGH", expires_in: 60, interval: 0.01,
  }))
  f.route("POST /oauth2/token", () => (++polls < 3
    ? json({ error: "authorization_pending" }, 400)
    : json({ access_token: jwtOf({ sub: "s-1", account_id: "acc-1" }), refresh_token: "r-1", token_type: "Bearer", expires_in: 3600, scope: "agent.default" })))
  f.route("GET /v1/api/user/info", userInfo)

  const hooks = await MiniMaxCodeAuthPlugin({ client: {} })
  const [method] = hooks.auth.methods
  expect(method.type).toBe("oauth")
  const a = await method.authorize()
  expect(a.method).toBe("auto")
  expect(a.url).toBe("https://account.example/device?code=ABCD-EFGH")
  expect(a.instructions).toContain("ABCD-EFGH")
  const got = await a.callback()
  expect(got.type).toBe("success")
  expect(got.refresh).toBe("r-1")
  expect(got.accountId).toBe("a@example.com")
  expect(got.uid).toBe("u-42")
  expect(got.realUserID).toBe("u-42")
  expect(got.expires).toBeGreaterThan(Date.now() + 3500_000)

  const dev = f.seen.find((r) => r.path === "/oauth2/device/code")
  expect(dev.form).toMatchObject({ client_id: "mcode-public", scope: "agent.default", audience: "agent-backend", code_challenge_method: "S256" })
  const tok = f.seen.filter((r) => r.path === "/oauth2/token")
  expect(tok.length).toBe(3)
  for (const t of tok) {
    expect(t.form).toMatchObject({ grant_type: "urn:ietf:params:oauth:grant-type:device_code", device_code: "dev-1", client_id: "mcode-public" })
    // the verifier sent is the one the challenge was made of
    expect(createHash("sha256").update(t.form.code_verifier, "ascii").digest("base64url")).toBe(dev.form.code_challenge)
  }
  // the account was asked for with MiniMax Code's signature
  const info = f.seen.find((r) => r.path === "/v1/api/user/info")
  expect(info.headers.get("authorization")).toStartWith("Bearer ")
  expect(info.headers.get("x-signature")).toMatch(/^[0-9a-f]{32}$/)
})

test("MiniMax's own variant: no device code, the user code polled for, ends and interval in ms", async () => {
  f = fakeMiniMax()
  let polls = 0
  f.route("POST /oauth2/device/code", () => json({ user_code: "U-CODE", verification_url: "https://account.example/d", expired_in: Date.now() + 60_000, interval: 10 }))
  f.route("POST /oauth2/token", () => (++polls < 2
    ? json({ status: "pending" })
    : json({ access_token: "plain-token", refresh_token: "r-2", token_type: "Bearer", expires_in: 3600 })))
  f.route("GET /v1/api/user/info", () => json({}, 500)) // the account can't be named: the token's own says who

  const hooks = await MiniMaxCodeGlobalAuthPlugin({ client: {} })
  const a = await hooks.auth.methods[0].authorize()
  expect(a.url).toBe("https://account.example/d")
  const got = await a.callback()
  expect(got.type).toBe("success")
  expect(got.access).toBe("plain-token")
  expect(got.accountId).toBe("MiniMax Code (Global)")
  for (const t of f.seen.filter((r) => r.path === "/oauth2/token")) {
    expect(t.form.user_code).toBe("U-CODE")
    expect(t.form.device_code).toBeUndefined()
  }
})

test("a sign-in turned down fails, saying so", async () => {
  f = fakeMiniMax()
  f.route("POST /oauth2/device/code", () => json({ device_code: "d", user_code: "c", verification_uri: "https://x/", expires_in: 60, interval: 0.01 }))
  f.route("POST /oauth2/token", () => json({ status: "denied" }))
  const hooks = await MiniMaxCodeAuthPlugin({ client: {} })
  const got = await (await hooks.auth.methods[0].authorize()).callback()
  expect(got.type).toBe("failed")
  expect(got.error).toContain("turned down")
})

test("an error that isn't pending ends the sign-in", async () => {
  f = fakeMiniMax()
  f.route("POST /oauth2/device/code", () => json({ device_code: "d", user_code: "c", verification_uri: "https://x/", expires_in: 60, interval: 0.01 }))
  f.route("POST /oauth2/token", () => json({ error: "invalid_client" }, 401))
  const hooks = await MiniMaxCodeAuthPlugin({ client: {} })
  const got = await (await hooks.auth.methods[0].authorize()).callback()
  expect(got.type).toBe("failed")
  expect(got.error).toContain("invalid_client")
})
