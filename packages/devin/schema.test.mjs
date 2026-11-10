// A tool whose parameters have anyOf, oneOf or allOf at the root goes to
// Devin as a plain object (magpie#1196): Devin's Claude models answered
// every request offering one with 502 "There is an issue with this request,
// please try a different model", and Codex desktop offers one in codex_app's
// automation_update. The schema is folded as magpie's built-in folds it for
// Anthropic (provider.ObjectRoot, magpie#646).
import { expect, test } from "bun:test"
import { _internal } from "./index.mjs"

const dec = new TextDecoder()

// sent is each tool sent with the request: name -> its schema, parsed.
const sent = (b) =>
  Object.fromEntries(
    _internal
      .fields(b)
      .filter((f) => f.num === 10 && f.wire === 2)
      .map((f) => {
        const g = _internal.fields(f.data)
        return [dec.decode(g.find((h) => h.num === 1).data), JSON.parse(dec.decode(g.find((h) => h.num === 3).data))]
      }),
  )

// the parameters of the issue's minimal reproduction, byte for byte
const ISSUE = `{
      "type": "object",
      "properties": {"a": {"type": "string"}},
      "oneOf": [{"properties": {"a": {"type": "string"}}}, {"properties": {"b": {"type": "string"}}}]
    }`

const chatWith = (parameters) => ({
  messages: [{ role: "user", content: "ok" }],
  tools: [{ type: "function", function: { name: "t", description: "t", parameters } }],
})

for (const k of ["oneOf", "anyOf", "allOf"]) {
  test(`a root ${k} goes to Devin as a plain object`, () => {
    const parameters = JSON.parse(ISSUE.replace('"oneOf"', `"${k}"`))
    const before = JSON.stringify(parameters)
    const got = sent(_internal.build(chatWith(parameters), "claude-opus-5-5-high", "k")).t
    expect(got).toEqual({ type: "object", properties: { a: { type: "string" }, b: { type: "string" } } })
    // the caller's own schema is left as it came
    expect(JSON.stringify(parameters)).toBe(before)
  })
}

test("a schema with no root combinator is sent as it came", () => {
  const parameters = {
    type: "object",
    properties: { a: { anyOf: [{ type: "string" }, { type: "null" }] }, n: { type: "integer" } },
    required: ["n"],
    $defs: { x: { type: "string" } },
  }
  const got = sent(_internal.build(chatWith(parameters), "claude-opus-5-5-high", "k")).t
  expect(got).toEqual(parameters)
})

test("allOf's branches are all merged, required and all", () => {
  expect(
    _internal.objectRoot({
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
      allOf: [{ $ref: "#/definitions/when" }, { properties: { id: { type: "integer" } } }],
      definitions: { when: { properties: { when: { type: "string" } }, required: ["when"] } },
    }),
  ).toEqual({
    type: "object",
    properties: { id: { type: "string" }, when: { type: "string" } },
    required: ["id", "when"],
    definitions: { when: { properties: { when: { type: "string" } }, required: ["when"] } },
  })
})

test("anyOf's object branches are merged, a field every one requires stays required, $refs are followed", () => {
  const byName = { type: "object", properties: { name: { type: "string" }, when: { type: "string" } }, required: ["name", "when"] }
  expect(
    _internal.objectRoot({
      anyOf: [
        { $ref: "#/$defs/byName" },
        { type: "object", properties: { name: { type: "string" }, tag: { type: "string" } }, required: ["name", "tag"] },
        { type: "string" },
        { $ref: "#/$defs/missing" },
      ],
      $defs: { byName },
    }),
  ).toEqual({
    type: "object",
    properties: { name: { type: "string" }, when: { type: "string" }, tag: { type: "string" } },
    required: ["name"],
    $defs: { byName },
  })
})

test("objectRoot keeps the root's own required beside anyOf's branches", () => {
  const { objectRoot } = _internal
  const out = objectRoot({
    type: "object",
    properties: { id: { type: "string" } },
    required: ["id"],
    anyOf: [
      { type: "object", properties: { a: { type: "string" } }, required: ["a"] },
      { type: "object", properties: { b: { type: "string" } }, required: ["b"] },
    ],
  })
  expect(out.required).toEqual(["id"])
  expect(Object.keys(out.properties).sort()).toEqual(["a", "b", "id"])
})

// Codex desktop's automation_update (testdata: what ChatGPT.app 26.930's
// zod builds) has create and update branches that are unions themselves;
// they were dropped, leaving only view's fields with id required, so the
// model could never create an automation (magpie#1271).
test("a branch that is itself a union is folded, not dropped", () => {
  const { readFileSync } = require("node:fs")
  const schema = JSON.parse(readFileSync(new URL("./testdata/codex_automation_update_schema.json", import.meta.url), "utf8"))
  const ps = _internal.objectRoot(schema)
  expect(ps.type).toBe("object")
  expect(ps.anyOf).toBeUndefined()
  for (const k of ["mode", "id", "name", "prompt", "rrule", "status", "kind"]) expect(Object.keys(ps.properties)).toContain(k)
  expect(ps.required).toEqual(["mode"])
  for (const v of ["view", "delete"]) expect(JSON.stringify(ps.properties.mode)).toContain(v)
})
