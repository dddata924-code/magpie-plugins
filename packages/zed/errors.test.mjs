// A request that fails before the reply says anything is answered with the
// status magpie's built-in Zed account answers it with (relayStatus over
// internal/gateway/zed.go), not a 200 whose stream carries the failure:
// magpie's gateway moves on to the next account or member just as it did.
import { afterEach, expect, test } from "bun:test"
import { _internal } from "./index.mjs"

const real = globalThis.fetch
afterEach(() => {
  globalThis.fetch = real
  _internal.tokens.clear()
})

const s = { userId: "4242", access: "plain-access", systemId: "", org: "org-me", plan: "zed_pro", who: "octo" }

const URLS = {
  anthropic: "https://cloud.zed.dev/v1/messages",
  responses: "https://cloud.zed.dev/v1/responses",
  chat: "https://cloud.zed.dev/v1/chat/completions",
}
const MODEL = { anthropic: "claude-sonnet-5", responses: "gpt-5.5", chat: "grok-4.7" }

// ask sends one request on wire, Zed's /completions answering with lines
// (each a JSON value, one a line) in its status-message form.
async function ask(wire, lines, stream = true) {
  globalThis.fetch = async (url) => {
    const path = new URL(String(url)).pathname
    if (path === "/client/llm_tokens") return Response.json({ token: "llm-token" })
    if (path === "/completions")
      return new Response(lines.map((l) => JSON.stringify(l)).join("\n") + "\n", { headers: { "x-zed-server-supports-status-messages": "true" } })
    return new Response("", { status: 404 })
  }
  const res = await _internal.complete(s, URLS[wire], {
    method: "POST",
    body: JSON.stringify({ model: MODEL[wire], stream, messages: [{ role: "user", content: "hi" }], max_tokens: 100 }),
  })
  const text = await res.text()
  return { status: res.status, text, signIn: res.headers.get("x-magpie-sign-in") }
}

const msgOf = (text) => {
  const j = JSON.parse(text)
  return j.error?.message
}

const start = { event: { type: "message_start", message: { id: "msg_1", type: "message", role: "assistant", content: [], model: "claude-sonnet-5", usage: { input_tokens: 5, output_tokens: 0 } } } }
const textStart = { event: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } } }

test("a rate limit Zed reports after the reply's start is the 429 it stands for", async () => {
  const r = await ask("anthropic", [{ status: "started" }, start, textStart, { status: { failed: { code: "upstream_http_429", message: "Rate limited" } } }])
  expect(r.status).toBe(429)
  expect(JSON.parse(r.text)).toEqual({ type: "error", error: { type: "rate_limit_error", message: "Rate limited" } })
})

test("a failure keeps the status its code names on every API: 401 on chat, 403 on Responses, 402 for billing", async () => {
  const chat = await ask("chat", [{ status: "started" }, { status: { failed: { code: "upstream_http_401", message: "bad key upstream" } } }])
  expect([chat.status, msgOf(chat.text)]).toEqual([401, "bad key upstream"])
  // a vendor's 401 in the stream never lapsed the built-in's account
  expect(chat.signIn).toBe("kept")
  expect((await ask("anthropic", [start, { status: { failed: { code: "upstream_http_401", message: "x" } } }], false)).signIn).toBe("kept")
  const resp = await ask("responses", [{ event: { type: "response.created", response: { id: "r1" } } }, { status: { failed: { code: "http_403", message: "no" } } }])
  expect([resp.status, msgOf(resp.text)]).toEqual([403, "no"])
  const bill = await ask("anthropic", [start, { status: { failed: { code: "billing_limit", message: "" } } }])
  expect([bill.status, msgOf(bill.text)]).toEqual([402, "billing_limit"])
})

test("the provider's own error event before any content is a 502 with its message, as the built-in's decoders read it", async () => {
  const r = await ask("anthropic", [start, { event: { type: "error", error: { type: "overloaded_error", message: "Overloaded" } } }])
  expect([r.status, msgOf(r.text)]).toEqual([502, "Overloaded"])
  const c = await ask("chat", [{ event: { id: "c", choices: [{ index: 0, delta: { role: "assistant", content: "" } }] } }, { event: { error: { message: "upstream went away" } } }])
  expect([c.status, msgOf(c.text)]).toEqual([502, "upstream went away"])
})

test("a reply that ends with nothing said, or breaks off before it, is a 502", async () => {
  const none = await ask("anthropic", [start, textStart, { status: "stream_ended" }])
  expect([none.status, msgOf(none.text)]).toEqual([502, "Zed ended without an answer"])
  const cut = await ask("anthropic", [start])
  expect([cut.status, msgOf(cut.text)]).toEqual([502, "the reply ended before it was complete"])
})

test("a reply that says something streams with its start, and a failure after it stays in the stream", async () => {
  const delta = { event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hi" } } }
  const r = await ask("anthropic", [start, textStart, delta, { status: { failed: { code: "upstream_http_429", message: "Rate limited" } } }])
  expect(r.status).toBe(200)
  expect(r.text.split("event: ").map((e) => e.split("\n")[0]).filter(Boolean)).toEqual(["message_start", "content_block_start", "content_block_delta", "error"])
})

test("a whole reply carrying the provider's error is that error, and an out-of-range code is a 502", async () => {
  const r = await ask("anthropic", [start, { event: { type: "error", error: { type: "overloaded_error", message: "Overloaded" } } }, { status: "stream_ended" }], false)
  expect([r.status, msgOf(r.text)]).toEqual([502, "Overloaded"])
  const odd = await ask("anthropic", [start, { status: { failed: { code: "http_999", message: "odd" } } }], false)
  expect([odd.status, msgOf(odd.text)]).toEqual([502, "odd"])
})

test("an answer that goes through keeps the mark, as the built-in took it off only on signing in again", async () => {
  const delta = { event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hi" } } }
  const lines = [{ status: "started" }, start, textStart, delta, { event: { type: "message_stop" } }, { status: "stream_ended" }]
  const streamed = await ask("anthropic", lines)
  expect([streamed.status, streamed.signIn]).toEqual([200, "kept"])
  const whole = await ask("anthropic", lines, false)
  expect([whole.status, whole.signIn]).toEqual([200, "kept"])
})
