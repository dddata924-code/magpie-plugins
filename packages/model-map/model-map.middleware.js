// New API's 模型重定向 (a channel's model_mapping) as magpie gateway
// middleware: the model an agent asks for is sent as another, and the
// reply names the model the agent asked for again, so an agent that reads
// its model's name back (Claude Code does, for its context window) sees
// what it asked for.
//
//   {"mapping": {"fast": "deepseek-chat", "/^claude-(.*)$/": "glm-$1"}}
//
// New API's own flat form, {"fast": "deepseek-chat"}, works too. A name
// maps on (a → b → c) until it maps to nothing more; a cycle stops where
// it would repeat. A key written /like this/ is a regular expression, and
// its value can use $1. "keep_upstream_name": true leaves the upstream
// model's name in replies.

export function onRequest(body, ctx) {
  // the gateway puts a Gemini request's model in its body too (the URL's
  // model, which it reads from there as for every other API)
  if (body.model === null || typeof body.model !== "string") return
  const to = map(body.model, rules(ctx.options))
  if (to === body.model) return
  ctx.state.asked = body.model
  body.model = to
  return body
}

export function onEvent(ev, ctx) {
  const asked = ctx.state.asked
  if (!asked || ctx.options.keep_upstream_name) return
  if (ev.type === "message_start" && ev.message && typeof ev.message.model === "string") {
    ev.message.model = asked
    return ev
  }
  if (typeof ev.model === "string" && ev.model !== asked) {
    ev.model = asked
    return ev
  }
  if (ev.response && typeof ev.response.model === "string") {
    ev.response.model = asked
    return ev
  }
  // Gemini names it in modelVersion
  if (typeof ev.modelVersion === "string" && ev.modelVersion !== asked) {
    ev.modelVersion = asked
    return ev
  }
}

export function onResponse(body, ctx) {
  const asked = ctx.state.asked
  if (!asked || ctx.options.keep_upstream_name || ctx.status >= 400) return
  if (typeof body.model === "string") {
    body.model = asked
    return body
  }
  if (body.response && typeof body.response.model === "string") {
    body.response.model = asked
    return body
  }
  if (typeof body.modelVersion === "string" && body.modelVersion !== asked) {
    body.modelVersion = asked
    return body
  }
}

// rules are the options' mappings, compiled: exact names, and patterns
function rules(o) {
  if (!o || typeof o !== "object") return { exact: {}, patterns: [] }
  const m = o.mapping && typeof o.mapping === "object" ? o.mapping : o
  const exact = {}
  const patterns = []
  for (const k of Object.keys(m)) {
    const v = m[k]
    if (typeof v !== "string" || !v || k === "keep_upstream_name") continue
    const re = /^\/(.+)\/([a-z]*)$/.exec(k)
    if (re) patterns.push([new RegExp(re[1], re[2].replace("g", "")), v])
    else exact[k] = v
  }
  return { exact, patterns }
}

function map(name, r) {
  const seen = [name]
  let cur = name
  for (let i = 0; i < 16; i++) {
    let next = Object.prototype.hasOwnProperty.call(r.exact, cur) ? r.exact[cur] : undefined
    if (next === undefined) {
      for (const [re, to] of r.patterns) {
        if (re.test(cur)) {
          next = cur.replace(re, to)
          break
        }
      }
    }
    if (next === undefined || next === cur || seen.includes(next)) return cur
    seen.push(next)
    cur = next
  }
  return cur
}
