// One turn's parallel tool_use blocks split over two consecutive assistant
// messages, answered by one user message (yetone/magpie#1275, the request
// as Claude Code sent it): both calls keep their real results. buildKiro
// joins consecutive assistant messages already; this keeps it so.
import { expect, test } from "bun:test"
import { _internal } from "./index.mjs"

const NO_RESULT = "Tool use was interrupted and did not produce a result."
const split = () => ({
  messages: [
    { role: "user", content: "read a and b" },
    { role: "assistant", content: [{ type: "tool_use", id: "toolu_a", name: "read", input: { path: "a" } }] },
    { role: "assistant", content: [{ type: "tool_use", id: "toolu_b", name: "read", input: { path: "b" } }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_a", content: "A!" }, { type: "tool_result", tool_use_id: "toolu_b", content: "B!" }] },
  ],
})

const sent = (req) => JSON.parse(_internal.buildKiro(req, "claude-sonnet-4.5", "", 0)).conversationState

test("a split turn's calls are answered by their real results", () => {
  const s = sent(split())
  expect(s.history.map((e) => Object.keys(e)[0])).toEqual(["userInputMessage", "assistantResponseMessage"])
  expect(s.history[1].assistantResponseMessage.toolUses.map((c) => c.toolUseId)).toEqual(["toolu_a", "toolu_b"])
  expect(s.currentMessage.userInputMessage.userInputMessageContext.toolResults.map((r) => `${r.toolUseId}=${r.content[0].text}`)).toEqual(["toolu_a=A!", "toolu_b=B!"])
  expect(JSON.stringify(s)).not.toContain(NO_RESULT)
})

test("a call of a split turn that went unanswered is still answered for", () => {
  const req = split()
  req.messages[3].content.shift()
  const r = sent(req).currentMessage.userInputMessage.userInputMessageContext.toolResults
  expect(r.map((x) => `${x.toolUseId}=${x.content[0].text}`)).toEqual(["toolu_b=B!", `toolu_a=${NO_RESULT}`])
})
