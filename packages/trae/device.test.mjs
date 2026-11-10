// Renewing the JWT for the account's device, as Trae CN's clients do
// (yetone/magpie#808): a JWT renewed at /cloudide/… is bound to no device,
// and Trae CN answers its daily check-in claim 9074 every time.
import "./nonet.mjs"
import { afterEach, expect, test } from "bun:test"
import { verify } from "node:crypto"
import { TraeCNAuthPlugin, TraeGlobalAuthPlugin, _internal } from "./index.mjs"
import { fakeTrae, json, signedIn } from "./fake.mjs"

const V3 = "POST /trae/api/v3/oauth/ExchangeToken"
const OLD = "POST /cloudide/api/v3/trae/oauth/ExchangeToken"

let f
afterEach(() => f?.close())

// signed is whether the request's DeviceProof is its device key's signature
// of what the clients sign
const signed = (r) => {
  const { ClientID, RefreshToken, DeviceInfo, DeviceProof } = r.json
  const text = ["POST", "/trae/api/v3/oauth/ExchangeToken", ClientID, RefreshToken, String(DeviceProof.Timestamp), DeviceProof.Nonce].join("\n")
  return verify("sha256", Buffer.from(text), DeviceInfo.DevicePublicKey, Buffer.from(DeviceProof.Signature, "base64"))
}

test("proofOf signs the method, path, client, refresh token, time and nonce with the device key", () => {
  const k = _internal.newDevice()
  const p = _internal.proofOf("/trae/api/v3/oauth/ExchangeToken", "en1oxy7wnw8j9n", "r-1", k.devicePrivateKey, 1700000000, "n0")
  expect(p.Timestamp).toBe(1700000000)
  expect(p.Nonce).toBe("n0")
  const text = "POST\n/trae/api/v3/oauth/ExchangeToken\nen1oxy7wnw8j9n\nr-1\n1700000000\nn0"
  expect(verify("sha256", Buffer.from(text), k.devicePublicKey, Buffer.from(p.Signature, "base64"))).toBe(true)
  expect(verify("sha256", Buffer.from(text + "x"), k.devicePublicKey, Buffer.from(p.Signature, "base64"))).toBe(false)
  // a new nonce each time
  const q = _internal.proofOf("/p", "c", "r", k.devicePrivateKey)
  expect(q.Nonce).toMatch(/^[0-9a-f]{32}$/)
  expect(Math.abs(q.Timestamp - Date.now() / 1000)).toBeLessThan(5)
})

test("a renewal goes to the device-bound ExchangeToken as TRAE SOLO CN, keeps the refresh token, and the key made for the account is kept", async () => {
  f = fakeTrae()
  f.route(V3, () => json({ Result: { Token: "jwt-2", RefreshToken: "r-1", TokenExpireAt: 2000000000, RefreshExpireAt: 2100000000 } }))
  f.route(OLD, () => json({ Result: { Token: "jwt-old", RefreshToken: "r-spent" } }))
  const hooks = await TraeCNAuthPlugin({ client: {} })
  const x = await hooks.auth.refresh(signedIn({ expires: Date.now() + 60_000 }))
  expect(f.seen.map((r) => r.path)).toEqual(["/trae/api/v3/oauth/ExchangeToken"])
  const r = f.seen[0]
  expect(r.headers.get("authorization")).toBe("Cloud-IDE-JWT jwt-1")
  expect(r.json.ClientID).toBe("en1oxy7wnw8j9n")
  expect(r.json.RefreshToken).toBe("r-1")
  expect(r.json.IDEVersion).toBe("0.1.64")
  expect(r.json.DeviceInfo).toMatchObject({ DeviceID: "1234567890123456789", MachineID: "ab".repeat(16), PlatformCode: "SOLO_PC", DeviceType: "PC", ClientVersion: "0.1.64" })
  expect(r.json.DeviceInfo.DevicePublicKey).toContain("BEGIN PUBLIC KEY")
  expect(signed(r)).toBe(true)
  expect(x).toMatchObject({ access: "jwt-2", refresh: "r-1", expires: 2000000000 * 1000 })
  expect(x.devicePublicKey).toBe(r.json.DeviceInfo.DevicePublicKey)
  expect(x.devicePrivateKey).toContain("BEGIN PRIVATE KEY")
})

test("an account with a device key signs with it, and its renewals aren't taken for one another though the refresh token stays", async () => {
  f = fakeTrae()
  let n = 0
  f.route(V3, () => json({ Result: { Token: `jwt-${++n + 1}`, RefreshToken: "r-1", TokenExpireAt: Math.floor(Date.now() / 1000) + 7200 } }))
  const k = _internal.newDevice()
  const hooks = await TraeCNAuthPlugin({ client: {} })
  const a = signedIn({ expires: Date.now() + 60_000, devicePublicKey: k.devicePublicKey, devicePrivateKey: k.devicePrivateKey })
  const x = await hooks.auth.refresh(a)
  expect(f.seen[0].json.DeviceInfo.DevicePublicKey).toBe(k.devicePublicKey)
  expect(signed(f.seen[0])).toBe(true)
  expect(x).toEqual({ access: "jwt-2", refresh: "r-1", expires: x.expires }) // its keys as they were
  // asked again with the sign-in from before, it gives the one it got
  expect(await hooks.auth.refresh(a)).toEqual(x)
  expect(n).toBe(1)
  // and with the one it got, when that is near its end, it renews again
  const y = await hooks.auth.refresh({ ...a, access: "jwt-2", expires: Date.now() + 60_000 })
  expect(y.access).toBe("jwt-3")
  expect(n).toBe(2)
})

test("SOLO turned away, it is tried as Trae CN's IDE, then at /cloudide/… as before", async () => {
  f = fakeTrae()
  f.route(V3, () => json({ ResponseMetadata: { Error: { Code: 20101, Message: "refresh token is invalid" } } }, 400))
  f.route(OLD, () => json({ Result: { Token: "jwt-2", RefreshToken: "r-2", TokenExpireAt: 2000000000 } }))
  const hooks = await TraeCNAuthPlugin({ client: {} })
  const x = await hooks.auth.refresh(signedIn({ expires: Date.now() + 60_000 }))
  expect(f.seen.map((r) => r.json.ClientID + " " + r.path)).toEqual([
    "en1oxy7wnw8j9n /trae/api/v3/oauth/ExchangeToken",
    "ono9krqynydwx5 /trae/api/v3/oauth/ExchangeToken",
    "ono9krqynydwx5 /cloudide/api/v3/trae/oauth/ExchangeToken",
  ])
  expect(f.seen[1].json.DeviceInfo.PlatformCode).toBe("IDE_PC")
  expect(signed(f.seen[1])).toBe(true)
  expect(x).toMatchObject({ access: "jwt-2", refresh: "r-2" })
  // the key made for it is kept even so, for the next renewal
  expect(x.devicePublicKey).toBe(f.seen[0].json.DeviceInfo.DevicePublicKey)
})

test("Trae Global renews at /cloudide/… only", async () => {
  f = fakeTrae("trae-global")
  f.route(OLD, () => json({ Result: { Token: "jwt-2", RefreshToken: "r-2", TokenExpireAt: 2000000000 } }))
  const hooks = await TraeGlobalAuthPlugin({ client: {} })
  const x = await hooks.auth.refresh(signedIn({ expires: Date.now() + 60_000 }))
  expect(f.seen.map((r) => r.path)).toEqual(["/cloudide/api/v3/trae/oauth/ExchangeToken"])
  expect(x.access).toBe("jwt-2")
})

test("a sign-in's token is renewed for the device at once", async () => {
  f = fakeTrae()
  f.route(V3, () => json({ Result: { Token: "jwt-bound", RefreshToken: "r-1", TokenExpireAt: 2000000000 } }))
  const hooks = await TraeCNAuthPlugin({ client: {} })
  const a = await hooks.auth.methods[0].authorize()
  const q = new URL(a.url).searchParams
  const cb = new URL(q.get("auth_callback_url"))
  cb.searchParams.set("userJwt", JSON.stringify({ Token: "jwt-1", RefreshToken: "r-1", TokenExpireAt: Math.floor(Date.now() / 1000) + 7200 }))
  cb.searchParams.set("userInfo", JSON.stringify({ UserID: "u-1", ScreenName: "Ann" }))
  await fetch(cb)
  const got = await a.callback()
  expect(got.type).toBe("success")
  expect(got.access).toBe("jwt-bound")
  expect(got.refresh).toBe("r-1")
  expect(got.expires).toBe(2000000000 * 1000)
  const r = f.seen.find((r) => r.path === "/trae/api/v3/oauth/ExchangeToken")
  expect(r.headers.get("authorization")).toBe("Cloud-IDE-JWT jwt-1")
  expect(r.json.DeviceInfo.DeviceID).toBe(q.get("device_id"))
  expect(got.devicePublicKey).toBe(r.json.DeviceInfo.DevicePublicKey)
  expect(signed(r)).toBe(true)
})
