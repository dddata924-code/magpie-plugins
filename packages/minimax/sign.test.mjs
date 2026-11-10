// MiniMax Code's request signing for its account API (mcode 0.6.2,
// fetchAccountIdentity and postMatrixJson), where Oy is md5 in hex:
//   GET:  yy = Oy(`${encodeURIComponent(path+query)}_{}${Oy(String(ms))}ooui`)
//         x-signature = Oy(`${s}I*7Cf%WZ#S&%1RlZJ&C2`)
//   POST: yy = Oy(`${encodeURIComponent(path+query)}_${body}${Oy(String(ms))}ooui`)
//         x-signature = Oy(`${s}I*7Cf%WZ#S&%1RlZJ&C2${body}`)
// with ms the request's time, s it in whole seconds (x-timestamp). The
// vectors below were worked out with those lines as the bundle has them.
import "./nonet.mjs"
import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { _internal } from "./index.mjs"

const Oy = (e) => createHash("md5").update(e).digest("hex")
const site = { ..._internal.SITES["minimax-code"], agent: "https://agent.minimaxi.com" }
const global = { ..._internal.SITES["minimax-code-global"], agent: "https://agent.minimax.io" }
const now = 1790000000123

test("a GET is signed with an empty body", () => {
  const { url, init } = _internal.signed(site, "/v1/api/user/info", { access: "tok", now, tz: 28800, platform: "darwin" })
  expect(url).toBe("https://agent.minimaxi.com/v1/api/user/info?device_platform=mcode&biz_id=3&app_id=3001&version_code=22201&unix=1790000000123&timezone_offset=28800&sys_language=zh&lang=zh&device_id=0&os_name=darwin&browser_name=mcode&user_id=0&client=mcode")
  expect(init.method).toBe("GET")
  expect(init.body).toBeUndefined()
  expect(init.headers).toEqual({
    Accept: "application/json",
    "Content-Type": "application/json",
    "User-Agent": "MiniMaxCode",
    Authorization: "Bearer tok",
    yy: "ea384f50aae587ea2048557a2e1b30b1",
    "x-timestamp": "1790000000",
    "x-signature": "03015677c012162b07bc060014868ead",
  })
})

test("a POST is signed over its body", () => {
  const { url, init } = _internal.signed(global, "/matrix/api/v1/commerce/get_membership_info", { access: "tok", userID: "u-42", body: { workspace_id: 7 }, now, tz: 0, platform: "linux" })
  expect(url).toBe("https://agent.minimax.io/matrix/api/v1/commerce/get_membership_info?device_platform=mcode&biz_id=3&app_id=3001&version_code=22201&unix=1790000000123&timezone_offset=0&sys_language=en&lang=en&device_id=0&os_name=linux&browser_name=mcode&user_id=u-42&client=mcode")
  expect(init.method).toBe("POST")
  expect(init.body).toBe('{"workspace_id":7}')
  expect(init.headers.yy).toBe("078fc5529cd0bee0e3f4b587421d726d")
  expect(init.headers["x-signature"]).toBe("cdc435f7a98e23c841ecd445dfa82439")
})

test("the signature follows the bundle's formula for any request", () => {
  for (const [path, body] of [["/v1/api/user/info", undefined], ["/matrix/api/v1/user/get_user_extra_info", {}], ["/matrix/api/v1/commerce/get_membership_info", { workspace_id: "w 1" }]]) {
    const t = Date.now()
    const { url, init } = _internal.signed(site, path, { access: "x", userID: "9", body, now: t })
    const u = new URL(url)
    const at = u.pathname + u.search
    const s = Math.floor(t / 1e3)
    const d = body === undefined ? undefined : JSON.stringify(body)
    expect(init.headers.yy).toBe(d === undefined ? Oy(`${encodeURIComponent(at)}_{}${Oy(String(t))}ooui`) : Oy(`${encodeURIComponent(at)}_${d}${Oy(String(t))}ooui`))
    expect(init.headers["x-signature"]).toBe(d === undefined ? Oy(`${s}I*7Cf%WZ#S&%1RlZJ&C2`) : Oy(`${s}I*7Cf%WZ#S&%1RlZJ&C2${d}`))
    expect(init.headers["x-timestamp"]).toBe(String(s))
    expect(u.searchParams.get("user_id")).toBe("9")
  }
})
