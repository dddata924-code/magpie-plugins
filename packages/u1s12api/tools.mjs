import { randomUUID } from "node:crypto"

const MAX_CATALOG_CHARS = 512 * 1024
const MAX_HELD_CHARS = 1024 * 1024
const DSML_TAG = String.raw`<\s*\/?\s*[|｜][\s|｜]*DSML[\s|｜]*`
const TOOL_MARK = /<tool_call\b|<\s*\/?\s*[|｜][\s|｜]*DSML/u

function protocolError(message) {
  return Object.assign(new Error(message), { code: "TOOL_PROTOCOL" })
}

function plainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

export function offeredTools(tools, choice) {
  if (choice === "none" || choice?.type === "none") return []
  const descriptors = []
  const names = new Set()
  for (const tool of Array.isArray(tools) ? tools : []) {
    if (tool?.type && !["function", "custom"].includes(tool.type)) continue
    const descriptor = tool?.function ?? tool
    if (typeof descriptor?.name !== "string" || !descriptor.name.trim()) continue
    if (names.has(descriptor.name)) throw protocolError("duplicate external tool " + descriptor.name)
    names.add(descriptor.name)
    descriptors.push({
      name: descriptor.name,
      description: typeof descriptor.description === "string" ? descriptor.description : "",
      parameters: descriptor.parameters ?? descriptor.input_schema ?? { type: "object", properties: {} },
    })
  }
  const selected = choice?.function?.name ?? (choice?.type === "tool" ? choice.name : undefined)
  if (selected !== undefined) {
    if (!names.has(selected)) throw protocolError("unknown selected external tool " + selected)
    return descriptors.filter(descriptor => descriptor.name === selected)
  }
  return descriptors
}

export function toolProtocol(tools, choice) {
  const descriptors = offeredTools(tools, choice)
  if (!descriptors.length) return ""
  const protocol = [
    "[External Harness tool protocol]",
    "This request is for an external Harness, whose available tools are defined below.",
    "Your local CLI tools remain disabled. Do not execute commands locally or claim that a tool has run.",
    'Return the next external action by writing <tool_call>{"name":"tool_name","arguments":{}}</tool_call>.',
    "The external Harness parses this response and executes the selected tool under its own permission policy.",
    "Use only the exact tool names and argument schemas below, never internal DSML or shell names from earlier messages.",
    "Write no code fences and no text after tool calls. If no tool is needed, answer normally.",
    ...(choice === "required" || choice?.type === "tool" || choice?.type === "function" ? ["The current request requires an external tool call."] : []),
    ...descriptors.map(descriptor => JSON.stringify(descriptor)),
  ].join("\n")
  if (protocol.length > MAX_CATALOG_CHARS) throw protocolError("external tool catalog exceeds the supported size")
  return protocol
}

function nativeCall(name, argumentsValue, names) {
  if (!names.has(name)) throw protocolError("unknown external tool " + name)
  let argumentsObject = argumentsValue
  if (typeof argumentsObject === "string") {
    try { argumentsObject = JSON.parse(argumentsObject) } catch { throw protocolError("invalid external tool arguments for " + name) }
  }
  if (!plainObject(argumentsObject)) throw protocolError("external tool arguments must be an object for " + name)
  return { id: "call_" + randomUUID().replaceAll("-", ""), type: "function", function: { name, arguments: JSON.stringify(argumentsObject) } }
}

// salvageObject parses a tool-call payload, tolerating prose or extra text
// around the JSON object (the CLI sometimes wraps the payload when the model
// rambles). Returns undefined when no object can be recovered.
function salvageObject(raw) {
  try {
    const value = JSON.parse(raw)
    return plainObject(value) ? value : undefined
  } catch {}
  const first = raw.indexOf("{")
  const last = raw.lastIndexOf("}")
  if (first < 0 || last <= first) return undefined
  try {
    const value = JSON.parse(raw.slice(first, last + 1))
    return plainObject(value) ? value : undefined
  } catch {
    return undefined
  }
}

// stripTrailingFragments drops a reply tail that was cut off mid-tool-call
// (an unterminated <tool_call> or DSML marker with no closer after it). The
// CLI truncates long outputs, and failing the whole reply for that loses a
// reply that already parsed fine otherwise.
function stripTrailingFragments(text) {
  const trimmed = text.trimEnd()
  const open = trimmed.lastIndexOf("<tool_call")
  if (open >= 0) {
    const after = trimmed.slice(open)
    if (!after.includes("</tool_call>")) return trimmed.slice(0, open)
  }
  const dsml = trimmed.search(/<\s*\/?\s*[|｜][\s|｜]*DSML/u)
  if (dsml >= 0) {
    const after = trimmed.slice(dsml)
    const closed = /<[|｜][\s|｜]*DSML[\s|｜]*(?:invoke|parameter|calls|tool_calls|function_calls)\s*>|<\/\s*[|｜][\s|｜]*DSML/u.test(after)
    if (!closed) return trimmed.slice(0, dsml)
  }
  return trimmed
}

export function parseToolOutput(text, tools) {
  if (!tools.length) return { content: text, calls: [] }
  const names = new Set(tools.map(tool => tool.name))
  const segments = []
  for (const match of text.matchAll(/<tool_call>([\s\S]*?)<\/tool_call>/gu)) {
    const value = salvageObject(match[1])
    if (!value) continue // unparseable block stays as literal text, no throw
    segments.push({ start: match.index, end: match.index + match[0].length, name: value.name, arguments: value.arguments ?? {} })
  }
  const invokes = new RegExp(String.raw`<\s*[|｜][\s|｜]*DSML[\s|｜]*invoke\s+name\s*=\s*"([^"]+)"\s*>([\s\S]*?)${DSML_TAG}invoke\s*>`, "gu")
  const parameters = new RegExp(String.raw`<\s*[|｜][\s|｜]*DSML[\s|｜]*parameter\s+name\s*=\s*"([^"]+)"([^>]*)>([\s\S]*?)${DSML_TAG}parameter\s*>`, "gu")
  for (const match of text.matchAll(invokes)) {
    const argumentsObject = Object.create(null)
    for (const parameter of match[2].matchAll(parameters)) {
      if (Object.hasOwn(argumentsObject, parameter[1])) throw protocolError("duplicate external tool parameter " + parameter[1])
      let value = parameter[3]
      if (!/\bstring\s*=\s*"true"/u.test(parameter[2])) {
        try { value = JSON.parse(value) } catch {}
      }
      argumentsObject[parameter[1]] = value
    }
    segments.push({ start: match.index, end: match.index + match[0].length, name: match[1], arguments: argumentsObject })
  }
  segments.sort((left, right) => left.start - right.start)
  let cursor = 0
  let content = ""
  const calls = []
  for (const segment of segments) {
    if (segment.start < cursor) continue
    content += text.slice(cursor, segment.start)
    calls.push(nativeCall(segment.name, segment.arguments, names))
    cursor = segment.end
  }
  content += text.slice(cursor)
  content = content.replace(new RegExp(DSML_TAG + String.raw`(?:calls|tool_calls|function_calls)\s*>`, "gu"), "")
  content = stripTrailingFragments(content)
  return { content: calls.length ? content.trim() : content, calls }
}

export class ExternalToolOutput {
  constructor(tools) {
    this.tools = tools
    this.pending = ""
    this.holding = false
  }

  push(text) {
    if (!this.tools.length) return text
    this.pending += text
    if (this.pending.length > MAX_HELD_CHARS) throw protocolError("external tool output exceeds the supported size")
    if (this.holding) return ""
    const marker = TOOL_MARK.exec(this.pending)
    if (marker) {
      const content = this.pending.slice(0, marker.index)
      this.pending = this.pending.slice(marker.index)
      this.holding = true
      return content
    }
    const possible = this.pending.lastIndexOf("<")
    if (possible >= 0 && this.pending.length - possible <= 64) {
      const content = this.pending.slice(0, possible)
      this.pending = this.pending.slice(possible)
      return content
    }
    const content = this.pending
    this.pending = ""
    return content
  }

  finish() {
    const result = parseToolOutput(this.pending, this.tools)
    this.pending = ""
    return result
  }
}
