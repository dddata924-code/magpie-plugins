import test from "node:test"
import assert from "node:assert/strict"
import { _internal } from "./index.mjs"
const { usageOf } = _internal
const spent = { kind: "login_checkin", scope: "all", total_tokens: 2000, remaining: 0 }

test("quota amount is consumed tokens and agrees with used percentage", () => {
  const window = usageOf({ packages: [{ ...spent, remaining: 1500 }] }).windows[0]
  assert.equal(window.amount, 500)
  assert.equal(window.limit, 2000)
  assert.equal(window.used, 25)
  assert.equal(window.used, window.amount / window.limit * 100)
  assert.match(window.display, /剩余.*1500/)
})

test("spent package does not block another available package", () => {
  const windows = usageOf({ packages: [spent, { kind: "invite", scope: "all", remaining: 3000, total_tokens: 5000 }] }).windows
  assert.equal(windows.find((w) => w.used === 100).aside, true)
  assert.ok(windows.some((w) => !w.aside && w.used < 100))
})

test("fully exhausted account retains a routing window when no cash remains", () => {
  const windows = usageOf({ packages: [spent], paid_balance_usd: 0, gift_balance_usd: 0 }).windows
  assert.ok(windows.some((w) => !w.aside && w.used === 100))
})

test("cash balance keeps spent packages informational", () => {
  const u = usageOf({ packages: [spent], paid_balance_usd: 0.2, gift_balance_usd: 0 })
  assert.equal(u.windows[0].aside, true)
  assert.equal(u.windows[0].amount, 2000)
  assert.equal(u.balance, "$0.2000")
})
