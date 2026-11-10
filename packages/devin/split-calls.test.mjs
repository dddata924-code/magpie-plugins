// One turn's parallel tool calls split over two consecutive assistant
// messages, answered together after (yetone/magpie#1275): both calls keep
// their real results, as magpie's built-in buildDevin does since 7067fce5
// (internal/gateway/split_calls_test.go).
import { expect, test } from "bun:test"
import { _internal } from "./index.mjs"

const NO_RESULT = "Tool use was interrupted and did not produce a result."
const dec = new TextDecoder()
const call = (id, path) => ({ id, type: "function", function: { name: "read", arguments: JSON.stringify({ path }) } })
const split = () => ({
  messages: [
    { role: "user", content: "read a and b" },
    { role: "assistant", content: null, tool_calls: [call("toolu_a", "a")] },
    { role: "assistant", content: null, tool_calls: [call("toolu_b", "b")] },
    { role: "tool", tool_call_id: "toolu_a", content: "A!" },
    { role: "tool", tool_call_id: "toolu_b", content: "B!" },
  ],
})

// summary is each message sent, as magpie's devinSummary writes it: role,
// text, the calls it made and the call it answers.
const summary = (chat) =>
  _internal
    .fields(_internal.build(chat, "swe-2-high", "k"))
    .filter((f) => f.num === 3 && f.wire === 2)
    .map((f) => {
      let role = 0, text = "", answers = ""
      const calls = []
      for (const g of _internal.fields(f.data)) {
        if (g.num === 2) role = g.n
        else if (g.num === 3) text = dec.decode(g.data)
        else if (g.num === 6) calls.push(_internal.fields(g.data).slice(0, 2).map((h) => dec.decode(h.data)).join("/"))
        else if (g.num === 7) answers = dec.decode(g.data)
      }
      return `${role}:${text}${calls.map((c) => " call " + c).join("")}${answers ? " for " + answers : ""}`
    })

test("a split turn's calls are answered by their real results", () => {
  const got = summary(split())
  expect(got.join("\n")).not.toContain(NO_RESULT)
  expect(got.slice(1)).toEqual(["2: call toolu_a/read call toolu_b/read", "4:A! for toolu_a", "4:B! for toolu_b"])
})

test("a call of a split turn that went unanswered is still answered for", () => {
  const chat = split()
  chat.messages.splice(3, 1)
  expect(summary(chat).slice(1)).toEqual(["2: call toolu_a/read call toolu_b/read", "4:B! for toolu_b", `4:${NO_RESULT} for toolu_a`])
})

test("text the turn said after its call, in a message of its own, joins it", () => {
  const chat = {
    messages: [
      { role: "user", content: "read a" },
      { role: "assistant", content: null, tool_calls: [call("toolu_a", "a")] },
      { role: "assistant", content: "reading" },
      { role: "tool", tool_call_id: "toolu_a", content: "1" },
    ],
  }
  expect(summary(chat).slice(1)).toEqual(["2:reading call toolu_a/read", "4:1 for toolu_a"])
})

test("two assistant messages with no calls stay two", () => {
  const chat = { messages: [{ role: "user", content: "hi" }, { role: "assistant", content: "one" }, { role: "assistant", content: "two" }] }
  expect(summary(chat).slice(1, 3)).toEqual(["2:one", "2:two"])
})
