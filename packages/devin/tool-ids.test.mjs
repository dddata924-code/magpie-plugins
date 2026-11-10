// Devin's SWE-2 names a call "Bash:0#a65b6a5e02194b87bbc796c4428c946d"
// (yetone/magpie#1304, StarMoonCity's capture). Claude Code takes a
// tool_use id only of [A-Za-z0-9_-] and dropped every such call ("The
// model's tool call could not be parsed"). The id goes out safe, and its
// result goes back to Devin under the id Devin gave.
import { afterEach, expect, test } from "bun:test"
import { _internal } from "./index.mjs"

const { PB, frame, fields, build, complete } = _internal
const real = globalThis.fetch
afterEach(() => (globalThis.fetch = real))

const RAW = "Bash:0#a65b6a5e02194b87bbc796c4428c946d" // the reporter's literal id
const ARGS = '{"command":"date","description":"Print the date"}'
const SAFE = /^[A-Za-z0-9_-]+$/
const enc = new TextEncoder()
const dec = new TextDecoder()

const reply = () => {
  const call = new PB().str(1, RAW).str(2, "Bash").str(3, ARGS).done()
  const msg = new PB().bytes(6, call).varint(5, 10).done()
  const end = enc.encode("{}")
  const tail = new Uint8Array(5 + end.length)
  tail[0] = 2
  new DataView(tail.buffer).setUint32(1, end.length)
  tail.set(end, 5)
  return new Response(new Blob([frame(msg), tail]))
}

const ask = async (stream) => {
  globalThis.fetch = async () => reply()
  const res = await complete(
    { key: "k", server: "https://devin.test", families: _internal.familiesOf(_internal.SNAPSHOT) },
    { model: "swe-2", stream, messages: [{ role: "user", content: "用 Bash 跑一下 date" }] },
  )
  return res.text()
}

const sentIDs = (chat) => {
  const out = { calls: [], answers: [] }
  for (const f of fields(build(chat, "swe-2-high", "k"))) {
    if (f.num !== 3 || f.wire !== 2) continue
    for (const g of fields(f.data)) {
      if (g.num === 6) out.calls.push(dec.decode(fields(g.data).find((h) => h.num === 1).data))
      if (g.num === 7) out.answers.push(dec.decode(g.data))
    }
  }
  return out
}

const answered = (id) => ({
  messages: [
    { role: "user", content: "用 Bash 跑一下 date" },
    { role: "assistant", content: null, tool_calls: [{ id, type: "function", function: { name: "Bash", arguments: ARGS } }] },
    { role: "tool", tool_call_id: id, content: "Thu Oct  8 10:00:00 CST 2026" },
  ],
})

for (const stream of [false, true])
  test(`Devin's call id goes out of [A-Za-z0-9_-] only and comes back as Devin gave it (${stream ? "streamed" : "whole"})`, async () => {
    const body = await ask(stream)
    let id
    if (stream) {
      for (const line of body.split("\n"))
        if (line.startsWith("data: {")) id ??= JSON.parse(line.slice(6)).choices?.[0]?.delta?.tool_calls?.[0]?.id
    } else id = JSON.parse(body).choices[0].message.tool_calls[0].id
    expect(id).toMatch(SAFE)
    const sent = sentIDs(answered(id))
    expect(sent.calls).toEqual([RAW])
    expect(sent.answers).toEqual([RAW])
  })

test("a safe id goes both ways as it came", () => {
  for (const id of ["toolu_01AbC", "call_abc-123"]) {
    expect(_internal.outID(id)).toBe(id)
    expect(sentIDs(answered(id))).toEqual({ calls: [id], answers: [id] })
  }
})

test("an id of the caller's own that begins dv_ goes both ways as it came", () => {
  for (const id of ["dv_", "dv_abc", "dv_QmFzaDowI2E"]) expect(_internal.inID(_internal.outID(id))).toBe(id)
  // not one outID makes: sent to Devin untouched
  for (const id of ["dv_", "dv_abc"]) expect(sentIDs(answered(id))).toEqual({ calls: [id], answers: [id] })
})
