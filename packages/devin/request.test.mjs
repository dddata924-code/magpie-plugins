// The conversation goes to Devin as magpie's built-in Devin
// (internal/gateway/devin.go, buildDevin) sent it: a reply keeps the tool
// calls it made after they are answered (magpie#416: they were dropped, and
// Devin was sent answers to calls no reply had made).
import { expect, test } from "bun:test"
import { _internal } from "./index.mjs"

const dec = new TextDecoder()

// msgs is each message sent: its role, text, the calls it made (id/name
// args) and the call it answers.
const msgs = (b) =>
  _internal
    .fields(b)
    .filter((f) => f.num === 3 && f.wire === 2)
    .map((f) => {
      const m = { role: 0, text: "", calls: [], answers: "" }
      for (const g of _internal.fields(f.data)) {
        if (g.num === 2) m.role = g.n
        else if (g.num === 3) m.text = dec.decode(g.data)
        else if (g.num === 6) m.calls.push(_internal.fields(g.data).map((h) => dec.decode(h.data)).join(" "))
        else if (g.num === 7) m.answers = dec.decode(g.data)
      }
      return m
    })

test("a reply keeps the tool calls it made once they are answered", () => {
  const call = (id, name, args) => ({ id, type: "function", function: { name, arguments: args } })
  const chat = {
    messages: [
      { role: "user", content: "hi" },
      { role: "assistant", content: "let me look", tool_calls: [call("call_a", "read", '{"path":"a"}'), call("call_b", "bash", '{"cmd":"ls"}')] },
      { role: "tool", tool_call_id: "call_a", content: "A" },
      { role: "tool", tool_call_id: "call_b", content: "file1" },
      { role: "assistant", content: null, tool_calls: [call("call_c", "read", "{}")] },
      { role: "tool", tool_call_id: "call_c", content: "C" },
      { role: "assistant", content: "", tool_calls: [call("call_d", "read", "{}")] },
    ],
  }
  const got = msgs(_internal.build(chat, "swe-2-high", "k"))
  expect(got.map((m) => [m.role, m.calls, m.answers])).toEqual([
    [1, [], ""],
    [2, ['call_a read {"path":"a"}', 'call_b bash {"cmd":"ls"}'], ""],
    [4, [], "call_a"],
    [4, [], "call_b"],
    [2, ["call_c read {}"], ""],
    [4, [], "call_c"],
    // one never answered keeps its call, and is answered for it
    [2, ["call_d read {}"], ""],
    [4, [], "call_d"],
  ])
  expect(got[7].text).toBe("Tool use was interrupted and did not produce a result.")
})
