// The usage card: the credits left, the M Plan's tier and end, and its
// windows read as magpie's own MiniMax plan reader (readMiniMaxPlan) reads
// them. Nothing is claimed: no check-in is made.
import "./nonet.mjs"
import { afterEach, expect, test } from "bun:test"
import { MiniMaxCodeAuthPlugin, _internal } from "./index.mjs"
import { fakeMiniMax, json } from "./fake.mjs"

let f
afterEach(() => f?.close())

const h = 3600 * 1000

// readMiniMaxPlan's own test (magpie internal/provider/planquota_test.go)
test("plan windows are read as magpie's MiniMax plan reader reads them", () => {
  const ws = _internal.planWindows({
    model_remains: [
      { model_name: "general", start_time: 1790800000000, end_time: 1790800000000 + 5 * h, current_interval_remaining_percent: 72, current_interval_status: 1, current_interval_total_count: 0,
        weekly_start_time: 1790500000000, weekly_end_time: 1790500000000 + 168 * h, current_weekly_remaining_percent: 90, current_weekly_status: 1, current_weekly_total_count: 0 },
      { model_name: "video", start_time: 1790800000000, end_time: 1790800000000 + 24 * h, current_interval_remaining_percent: 40, current_interval_status: 2, current_interval_total_count: 3,
        current_weekly_status: 3, current_weekly_total_count: 0 },
      { model_name: "music", current_interval_remaining_percent: 100, current_interval_status: 3, current_interval_total_count: 0,
        current_weekly_remaining_percent: 100, current_weekly_status: 3, current_weekly_total_count: 0 },
    ],
    base_resp: { status_code: 0, status_msg: "success" },
  })
  expect(ws.length).toBe(3)
  expect(ws[0]).toEqual({ name: "5 hours", used: 28, span: 5 * 3600, resetsAt: new Date(1790800000000 + 5 * h).toISOString() })
  expect(ws[1]).toMatchObject({ name: "7 days", used: 10, span: 7 * 86400 })
  expect(ws[1].aside).toBeUndefined()
  expect(ws[2]).toMatchObject({ name: "Video · 24 hours", used: 100, aside: true })
  expect(() => _internal.planWindows({ base_resp: { status_code: 1004, status_msg: "login fail" } })).toThrow("login fail")
  expect(_internal.planWindows({ model_remains: [], base_resp: { status_code: 0 } })).toEqual([])
})

test("a membership is read from the answer or its data", () => {
  expect(_internal.membershipOf({ data: { has_token_plan: true, op_group_id: "g1", token_plan_tier: "Plus", token_plan_expires_at: 1800000000000, op_credit_summary: { total_remaining_amount: "1234.50" } } }))
    .toEqual({ hasTokenPlan: true, opGroupId: "g1", tier: "Plus", expiresAt: 1800000000000, balance: "1234.50" })
  expect(_internal.membershipOf({ opcredit_balance: 300 })).toEqual({ balance: "300" })
  expect(_internal.usageOf({ balance: "1234.50" })).toEqual({ plan: "Free", balance: "1234.5 credits", windows: [] })
  expect(_internal.usageOf({ hasTokenPlan: true, tier: "Plus", expiresAt: 1800000000000, balance: "0" }))
    .toEqual({ plan: "M Plan Plus", until: new Date(1800000000000).toISOString(), balance: "0 credits", windows: [] })
})

const auth = { type: "oauth", access: "tok", refresh: "r", expires: Date.now() + 3600_000, accountId: "user@example.invalid" }

function account(f, { plan = false } = {}) {
  f.route("GET /v1/api/user/info", () => json({ statusInfo: { code: 0 }, data: { userInfo: { realUserID: "u-42", userEmail: "user@example.invalid" } } }))
  f.route("POST /matrix/api/v1/user/get_user_extra_info", () => json({ statusInfo: { code: 0 }, data: { workspaces: [
    { workspace_id: 9, workspace_type: 1 },
    { workspace_id: 7, workspace_type: 0, op_group_id: "grp-7", opcredit_balance: "50" },
  ] } }))
  f.route("POST /matrix/api/v1/commerce/get_membership_info", () => json({ statusInfo: { code: 0 }, data: plan
    ? { has_token_plan: true, token_plan_tier: "Plus", token_plan_expires_at: 1800000000000, op_credit_summary: { total_remaining_amount: "88.5" } }
    : { has_token_plan: false, op_credit_summary: { total_remaining_amount: "1200" } } }))
  f.route("GET /v1/api/openplatform/coding_plan/remains", () => json({ model_remains: [
    { model_name: "general", start_time: 1790800000000, end_time: 1790800000000 + 5 * h, current_interval_remaining_percent: 60, current_interval_status: 1,
      weekly_start_time: 1790500000000, weekly_end_time: 1790500000000 + 168 * h, current_weekly_remaining_percent: 75, current_weekly_status: 1 },
  ], base_resp: { status_code: 0 } }))
}

test("a free account shows its credits", async () => {
  f = fakeMiniMax()
  account(f)
  const hooks = await MiniMaxCodeAuthPlugin({ client: {} })
  const u = await hooks.auth.usage(async () => auth)
  expect(u).toEqual({ plan: "Free", balance: "1200 credits", windows: [], user: "user@example.invalid", signIn: "kept" })
  // its own workspace's membership was asked for, signed, with its user id
  const m = f.seen.find((r) => r.path === "/matrix/api/v1/commerce/get_membership_info")
  expect(m.json).toEqual({ workspace_id: 7 })
  expect(m.query.get("user_id")).toBe("u-42")
  expect(m.headers.get("x-signature")).toMatch(/^[0-9a-f]{32}$/)
  // no plan, no windows asked for; and nothing claimed
  expect(f.seen.some((r) => r.path.includes("coding_plan"))).toBe(false)
  expect(f.seen.some((r) => r.path.includes("signin"))).toBe(false)
})

test("an M Plan shows its tier, its end and its windows", async () => {
  f = fakeMiniMax()
  account(f, { plan: true })
  const hooks = await MiniMaxCodeAuthPlugin({ client: {} })
  const u = await hooks.auth.usage(async () => auth)
  expect(u.plan).toBe("M Plan Plus")
  expect(u.until).toBe(new Date(1800000000000).toISOString())
  expect(u.balance).toBe("88.5 credits")
  expect(u.windows.map((w) => [w.name, w.used])).toEqual([["5 hours", 40], ["7 days", 25]])
  const q = f.seen.find((r) => r.path === "/v1/api/openplatform/coding_plan/remains")
  expect(q.headers.get("x-group-id")).toBe("grp-7")
  expect(q.headers.get("authorization")).toBe("Bearer tok")
})

test("the account refused says so, the sign-in kept", async () => {
  f = fakeMiniMax()
  f.route("GET /v1/api/user/info", () => json({ statusInfo: { code: 1000048, message: "login expired" } }))
  const hooks = await MiniMaxCodeAuthPlugin({ client: {} })
  const u = await hooks.auth.usage(async () => auth)
  expect(u.error).toContain("refused")
  expect(u.signIn).toBe("kept")
  expect(await hooks.auth.usage(async () => undefined)).toEqual({ error: "not signed in" })
})
