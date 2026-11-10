// A reply that fails before any of its answer fails as magpie's built-in
// Kiro relay failed it (internal/gateway/claude_subscription.go relay): a
// status, not a stream — a 429 when the error reads as a quota or rate limit
// (quotaWords), else a 502 — so magpie's gateway moves on to the next account.
import { test, expect } from "bun:test"
import { _internal } from "./index.mjs"

const { events, reply } = _internal

// frame is one AWS event-stream message with string headers.
function frame(headers, payload) {
  const enc = new TextEncoder()
  const hs = []
  for (const [k, v] of Object.entries(headers)) {
    const name = enc.encode(k)
    const val = enc.encode(v)
    const h = new Uint8Array(1 + name.length + 1 + 2 + val.length)
    h[0] = name.length
    h.set(name, 1)
    h[1 + name.length] = 7
    new DataView(h.buffer).setUint16(2 + name.length, val.length)
    h.set(val, 4 + name.length)
    hs.push(h)
  }
  const hlen = hs.reduce((n, h) => n + h.length, 0)
  const body = enc.encode(JSON.stringify(payload))
  const total = 12 + hlen + body.length + 4
  const out = new Uint8Array(total)
  const v = new DataView(out.buffer)
  v.setUint32(0, total)
  v.setUint32(4, hlen)
  let i = 12
  for (const h of hs) {
    out.set(h, i)
    i += h.length
  }
  out.set(body, i)
  return out
}

const stream = (...fs) =>
  new ReadableStream({
    start(c) {
      for (const f of fs) c.enqueue(f)
      c.close()
    },
  })

const exception = (type, message) => frame({ ":message-type": "exception", ":exception-type": type }, { message })
const text = (content) => frame({ ":message-type": "event", ":event-type": "assistantResponseEvent" }, { content })

const ask = (body, streaming) => reply(events(body, "claude-sonnet-4.5", 0), "claude-sonnet-4.5", streaming)

test("a throttling exception before the answer is a 429, streamed or not", async () => {
  for (const s of [true, false]) {
    const res = await ask(stream(exception("ThrottlingException", "Too many requests")), s)
    expect(res.status).toBe(429)
    const b = await res.json()
    expect(b.error.message).toBe("rate limited: Too many requests")
  }
})

test("a quota exception before the answer is a 429", async () => {
  const res = await ask(stream(exception("ServiceQuotaExceededException", "You have reached the limit")), true)
  expect(res.status).toBe(429)
})

test("another exception before the answer is a 502, not a stream", async () => {
  const res = await ask(stream(exception("ValidationException", "Input is too long.")), true)
  expect(res.status).toBe(502)
  expect((await res.json()).error.message).toBe("ValidationException: Input is too long.")
})

test("an exception after the answer began ends the stream with an error event", async () => {
  const res = await ask(stream(text("Hello"), exception("ThrottlingException", "slow down")), true)
  expect(res.status).toBe(200)
  const sse = await res.text()
  expect(sse).toContain("Hello")
  expect(sse).toContain("event: error")
})

test("unstreamed, what was said before an exception is the answer", async () => {
  const res = await ask(stream(text("Hello"), exception("InternalServerException", "boom")), false)
  expect(res.status).toBe(200)
  expect((await res.json()).content).toEqual([{ type: "text", text: "Hello" }])
})

// Failing before any of the answer, a request is answered with the built-in's
// status (internal/gateway/kiro.go askKiro), and X-Magpie-Sign-In: kept,
// as the built-in marked no Kiro account lapsed, even one Kiro refused.
const { generate, refresh, failure } = _internal
const msgReq = { model: "claude-sonnet-4.5", messages: [{ role: "user", content: "hi" }] }
const gone = (msg) => Object.assign(new Error(msg), { gone: true })

test("credentials that can't be had are a 401, the account kept even when the sign-in is gone", async () => {
  let res = await generate(async () => { throw new Error("refreshing Kiro's sign-in: fetch failed") }, {}, msgReq)
  expect(res.status).toBe(401)
  expect(res.headers.get("X-Magpie-Sign-In")).toBe("kept")
  expect((await res.json()).error.message).toBe("refreshing Kiro's sign-in: fetch failed")
  res = await generate(async () => { throw gone("Kiro's sign-in has expired; sign in again with `kiro-cli login` or the Kiro IDE") }, {}, msgReq)
  expect(res.status).toBe(401)
  expect(res.headers.get("X-Magpie-Sign-In")).toBe("kept")
})

const withFetch = async (answer, fn) => {
  const was = globalThis.fetch
  globalThis.fetch = async (...a) => answer(...a)
  try {
    return await fn()
  } finally {
    globalThis.fetch = was
  }
}
const creds = (fail) => {
  let n = 0
  return async () => {
    if (n++ && fail) throw fail
    return { token: "t", tokenType: "", profile: "arn:aws:codewhisperer:us-east-1:1:profile/x", region: "us-east-1" }
  }
}

test("a refresh failing after Kiro's 403 is a 502, the account kept even when Kiro refused it", async () => {
  await withFetch(() => new Response("{}", { status: 403 }), async () => {
    let res = await generate(creds(new Error("refreshing Kiro's sign-in: 503 Service Unavailable")), {}, msgReq)
    expect(res.status).toBe(502)
    expect(res.headers.get("X-Magpie-Sign-In")).toBe("kept")
    res = await generate(creds(gone("Kiro's sign-in has expired; sign in again with `kiro-cli login` or the Kiro IDE")), {}, msgReq)
    expect(res.status).toBe(502)
    expect(res.headers.get("X-Magpie-Sign-In")).toBe("kept")
  })
})

test("Kiro's own 401 is passed on without marking the account", async () => {
  await withFetch(() => new Response(JSON.stringify({ message: "bad token" }), { status: 401 }), async () => {
    const res = await generate(creds(), {}, msgReq)
    expect(res.status).toBe(401)
    expect(res.headers.get("X-Magpie-Sign-In")).toBe("kept")
    expect((await res.json()).error.message).toBe("bad token")
  })
})

test("an error Kiro gives no words for is Go's status text", () => {
  expect(failure(500, "")).toEqual({ status: 500, message: "Internal Server Error" })
})

test("a refresh is worded as the built-in's", async () => {
  const c = { method: "social", refresh: "r", region: "us-east-1", access: "a" }
  await withFetch(() => new Response("", { status: 500 }), async () => {
    await expect(refresh(c)).rejects.toThrow(/^refreshing Kiro's sign-in: 500 Internal Server Error$/)
  })
  await withFetch(() => new Response("", { status: 400 }), async () => {
    await expect(refresh(c)).rejects.toMatchObject({ gone: true, message: "Kiro's sign-in has expired; sign in again with `kiro-cli login` or the Kiro IDE" })
  })
  await expect(refresh({ ...c, refresh: "" })).rejects.toMatchObject({ message: "Kiro's sign-in has expired; sign in again with `kiro-cli login` or the Kiro IDE" })
  await expect(refresh({ ...c, method: "odd" })).rejects.toMatchObject({ message: "Kiro's sign-in has expired" })
})

// a success, even after a renewal, never cleared the built-in's account
test("an answer says the account is kept, streamed or not, renewed or not", async () => {
  const ok = () => new Response(stream(text("Hello")), { status: 200 })
  for (const s of [true, false]) {
    await withFetch(ok, async () => {
      const res = await generate(creds(), {}, { ...msgReq, stream: s })
      expect(res.status).toBe(200)
      expect(res.headers.get("X-Magpie-Sign-In")).toBe("kept")
    })
    let n = 0
    await withFetch(() => (n++ ? ok() : new Response("{}", { status: 403 })), async () => {
      const res = await generate(creds(), {}, { ...msgReq, stream: s })
      expect(res.status).toBe(200)
      expect(res.headers.get("X-Magpie-Sign-In")).toBe("kept")
    })
  }
})
