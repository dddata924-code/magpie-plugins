import test from "node:test"
import assert from "node:assert/strict"
import { offeredTools, parseToolOutput, ExternalToolOutput } from "./tools.mjs"

const TOOLS = [
  { name: "bash", description: "run a command", parameters: { type: "object", properties: {}, required: [] } },
]

test("offeredTools keeps only function/custom descriptors and drops unknown selection", () => {
  assert.equal(offeredTools([{ type: "function", function: { name: "bash", description: "d", parameters: {} } }], undefined).length, 1)
  assert.equal(offeredTools([{ type: "object" }], undefined).length, 0)
  assert.equal(offeredTools(TOOLS, "none").length, 0)
  assert.equal(offeredTools(TOOLS, { type: "tool", name: "bash" }).length, 1)
})

test("parseToolOutput extracts a simple tool_call", () => {
  const text = 'hello <tool_call>{"name":"bash","arguments":{"command":"ls"}}</tool_call> world'
  const out = parseToolOutput(text, TOOLS)
  assert.equal(out.calls.length, 1)
  assert.equal(out.calls[0].function.name, "bash")
  assert.equal(out.content, "hello  world")
})

test("parseToolOutput tolerates prose wrapped around the JSON", () => {
  const text = '<tool_call>方便说明：{"name":"bash","arguments":{"command":"pwd"}} 结束</tool_call>'
  const out = parseToolOutput(text, TOOLS)
  assert.equal(out.calls.length, 1)
  assert.equal(out.calls[0].function.arguments, '{"command":"pwd"}')
})

test("parseToolOutput drops a truncated trailing tool_call instead of a hard failure", () => {
  const text = 'answer <tool_call>{"name":"bash","arguments":{"command":"ls"}}</tool_call> then <tool_call>{"name":"bash","argum'
  const out = parseToolOutput(text, TOOLS)
  assert.equal(out.calls.length, 1)
  assert.ok(!out.content.includes("<tool_call"), out.content)
  assert.match(out.content, /answer/)
  assert.match(out.content, /then/)
})

test("parseToolOutput keeps text of an unparseable tool_call", () => {
  const text = 'story <tool_call>not json at all</tool_call> end'
  const out = parseToolOutput(text, TOOLS)
  assert.equal(out.calls.length, 0)
  assert.match(out.content, /not json at all/)
})

test("parseToolOutput leaves plain text alone", () => {
  const out = parseToolOutput("just a sentence", TOOLS)
  assert.equal(out.calls.length, 0)
  assert.equal(out.content, "just a sentence")
})

test("ExternalToolOutput finishes a complete tool call and holds mid-call bytes", () => {
  const output = new ExternalToolOutput(TOOLS)
  const streamed = '<tool_call>{"name":"bash","arguments":{"command":"ls"}}</tool_call>'
  let flushed = ""
  for (const chunk of [streamed.slice(0, 12), streamed.slice(12)]) flushed += output.push(chunk) ?? ""
  const result = output.finish()
  assert.equal(result.calls.length, 1)
  assert.equal(flushed, "")
})