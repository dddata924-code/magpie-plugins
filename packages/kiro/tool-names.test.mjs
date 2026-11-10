// Kiro refuses a tool named past 64 characters: "Invalid tool use format."
// (REQUEST_BODY_INVALID). Claude Code names a plugin's MCP tools
// mcp__plugin_<plugin>_<server>__<tool>, which runs past it
// (yetone/magpie#1393, the reporter's names). Kiro is sent a short name,
// the same in every turn, and the caller gets its own name back.
import { expect, test } from "bun:test"
import { _internal } from "./index.mjs"

const { buildKiro, events, reply, toolName, toolNames } = _internal

const LONG = "mcp__plugin_cloudflare_cloudflare-docs__search_cloudflare_documentation" // 71
const LONG2 = "mcp__plugin_cloudflare_cloudflare-docs__migrate_pages_to_workers_guide" // 70

const req = () => ({
  model: "claude-opus-4.5",
  messages: [
    { role: "user", content: "search" },
    { role: "assistant", content: [{ type: "tool_use", id: "toolu_1", name: LONG, input: { q: "workers" } }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "found" }] },
  ],
  tools: [
    { name: LONG, description: "Search Cloudflare docs", input_schema: { type: "object", properties: {} } },
    { name: LONG2, description: "Guide", input_schema: { type: "object", properties: {} } },
    { name: "Read", description: "read", input_schema: { type: "object", properties: {} } },
  ],
})

const sent = (r) => JSON.parse(buildKiro(r, "claude-opus-4.5", "", 0)).conversationState

test("every tool name Kiro is sent is one it takes, and a short one is kept", () => {
  const s = sent(req())
  const names = s.currentMessage.userInputMessage.userInputMessageContext.tools.map((t) => t.toolSpecification.name)
  for (const n of names) expect(n).toMatch(/^[a-zA-Z0-9_-]{1,64}$/)
  expect(names[2]).toBe("Read")
  expect(new Set(names).size).toBe(3)
  expect(names[0].startsWith("mcp__plugin_cloudflare_cloudflare-docs__")).toBe(true)
  // the call in the history names the tool as its declaration does
  expect(s.history[1].assistantResponseMessage.toolUses[0].name).toBe(names[0])
  expect(s.currentMessage.userInputMessage.userInputMessageContext.toolResults[0].toolUseId).toBe("toolu_1")
})

test("a name is shortened the same way each turn", () => {
  expect(toolName(LONG)).toBe(toolName(LONG))
  expect(toolName(LONG)).not.toBe(toolName(LONG2))
  expect(toolName(LONG).length).toBeLessThanOrEqual(64)
  expect(toolName("a.b")).toMatch(/^[a-zA-Z0-9_-]{1,64}$/)
})

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

const call = (name) =>
  new ReadableStream({
    start(c) {
      c.enqueue(frame({ ":message-type": "event", ":event-type": "toolUseEvent" }, { toolUseId: "tooluse_x", name, input: '{"q":"r2"}' }))
      c.enqueue(frame({ ":message-type": "event", ":event-type": "toolUseEvent" }, { toolUseId: "tooluse_x", name, stop: true }))
      c.close()
    },
  })

test("a call Kiro makes under the short name comes back under the caller's, streamed or not", async () => {
  const short = toolName(LONG)
  const names = toolNames(req())
  const whole = await (await reply(events(call(short), "claude-opus-4.5", 0), "claude-opus-4.5", false, names)).json()
  expect(whole.content[0]).toEqual({ type: "tool_use", id: "tooluse_x", name: LONG, input: { q: "r2" } })
  expect(whole.stop_reason).toBe("tool_use")
  const sse = await (await reply(events(call(short), "claude-opus-4.5", 0), "claude-opus-4.5", true, names)).text()
  expect(sse).toContain(`"name":"${LONG}"`)
  expect(sse).not.toContain(`"name":"${short}"`)
})
