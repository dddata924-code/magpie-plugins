// A model's context is the largest window Qoder offers it (context_config,
// Qoder's Context setting: 200K / 400K / 1M), not max_input_tokens, which
// is 180K on Qwen3.8-Flash (yetone/magpie#722); a request is sent the
// default window while it fits, a larger one only when it needs it.
import { expect, test } from "bun:test"
import { _internal } from "./index.mjs"

const flash = {
  key: "qfmodel",
  enable: true,
  display_name: "Qwen3.8-Flash",
  max_input_tokens: 180000,
  is_reasoning: true,
  context_config: {
    "1m": { token_count: 1000000 },
    "200k": { token_count: 200000, is_default: true },
    "400k": { token_count: 400000 },
  },
}

test("the context is the largest window context_config offers", () => {
  const m = _internal.modelInfo(flash)
  expect(m.context).toBe(1000000)
  expect(m.windows).toEqual([200000, 400000, 1000000])
  expect(m.defaultWindow).toBe(200000)
})

test("available_context_windows is read without context_config", () => {
  const m = _internal.modelInfo({ key: "x", max_input_tokens: 180000, available_context_windows: [400000, 200000], default_context_window: 200000 })
  expect(m.context).toBe(400000)
  expect(m.defaultWindow).toBe(200000)
})

test("a model with no windows keeps max_input_tokens", () => {
  const m = _internal.modelInfo({ key: "y", max_input_tokens: 180000 })
  expect(m.context).toBe(180000)
  const body = _internal.qoderBody({ messages: [{ role: "user", content: "hi" }] }, { ...m, config: { key: "y" } })
  expect(body.parameters.context_length).toBe(180000)
})

const sent = (chars) => {
  const m = { ..._internal.modelInfo(flash), config: flash }
  return _internal.qoderBody({ messages: [{ role: "user", content: "a".repeat(chars) }] }, m).parameters.context_length
}

test("a request is sent the default window while it fits, a larger one when it doesn't", () => {
  expect(sent(10)).toBe(200000)
  expect(sent(300000 * 3)).toBe(400000)
  expect(sent(700000 * 3)).toBe(1000000)
  expect(sent(1200000 * 3)).toBe(1000000)
})

// a window holds the reply too: a prompt that fits 200K alone but not with
// the max_tokens asked for the reply is sent the next window (yetone/magpie#700)
test("the reply's max_tokens is counted in the window a request needs", () => {
  const m = { ..._internal.modelInfo(flash), config: flash }
  const ctx = (max_tokens) =>
    _internal.qoderBody({ max_tokens, messages: [{ role: "user", content: "a".repeat(180000 * 3) }] }, m).parameters.context_length
  expect(ctx(1000)).toBe(200000)
  expect(ctx(32000)).toBe(400000)
  // none asked: the 32000 Qoder is sent counts
  expect(_internal.qoderBody({ messages: [{ role: "user", content: "a".repeat(180000 * 3) }] }, m).parameters.context_length).toBe(400000)
})
