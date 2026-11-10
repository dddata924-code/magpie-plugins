// New API's 参数覆盖 (a channel's param_override) as magpie gateway
// middleware: the same JSON, so a param_override copied from New API works
// here unchanged, on every request an agent sends through magpie.
//
// Two forms, as in New API:
//   {"temperature": 0.2, "max_tokens": 8000}     each key set as it is
//   {"operations": [{path, mode, value, ...}]}    run in order
// Keys beside "operations" are set first, the operations after.
//
// A path is gjson's: "a.b.0", "messages.-1" from the end, "*" any key or
// index, "\." a dot in a key. A condition looks in the body first, then in
// the request: model, original_model, request_path, protocol, agent, stream.
// What New API does with headers (set_header, pass_headers…) and with
// retries has nothing to act on here and is left out.

export function onRequest(body, ctx) {
  const o = ctx.options
  if (!o || typeof o !== "object") return
  const req = { model: ctx.model, original_model: ctx.model, upstream_model: ctx.model, request_path: ctx.path, protocol: ctx.protocol, agent: ctx.agent, stream: ctx.stream }
  let root = body
  let changed = false
  for (const k of Object.keys(o)) {
    if (k === "operations") continue
    root[k] = o[k]
    changed = true
  }
  const ops = Array.isArray(o.operations) ? o.operations : []
  for (const op of ops) {
    if (!op || typeof op !== "object" || !when(root, req, op.conditions, op.logic || "OR")) continue
    const r = run(root, op, req, ctx)
    if (r === REJECTED) return
    if (r !== UNCHANGED) {
      root = r
      changed = true
    }
  }
  return changed ? root : undefined
}

const REJECTED = {}
const UNCHANGED = {}

// run applies one operation, giving the new root, UNCHANGED when it touched
// nothing, or REJECTED when it turned the request away.
function run(root, op, req, ctx) {
  const mode = String(op.mode || "")
  if (mode === "return_error") {
    const e = returnError(op.value)
    ctx.reject(e.status, e.message)
    return REJECTED
  }
  if (mode === "move" || mode === "copy") {
    const from = resolve(root, split(op.from))
    const to = resolve(root, split(op.to))
    if (from.length !== 1 || to.length !== 1) return UNCHANGED
    const v = getAt(root, from[0])
    if (v === undefined) return UNCHANGED
    root = setAt(root, to[0], clone(v))
    if (mode === "move") delAt(root, from[0])
    return root
  }
  const paths = mode === "prune_objects" && !op.path ? [[]] : resolve(root, split(op.path))
  if (!paths.length) return UNCHANGED
  let touched = false
  // deleting from the end keeps the indexes still to come in place
  if (mode === "delete") paths.reverse()
  for (const p of paths) {
    const cur = getAt(root, p)
    let next
    switch (mode) {
      case "set":
        if (op.keep_origin && cur !== undefined) continue
        next = clone(op.value)
        break
      case "delete":
        if (cur === undefined) continue
        delAt(root, p)
        touched = true
        continue
      case "prepend":
      case "append":
        next = join(cur, op.value, mode === "prepend", op.keep_origin)
        if (next === undefined) continue
        break
      case "trim_prefix":
      case "trim_suffix":
      case "ensure_prefix":
      case "ensure_suffix": {
        if (typeof cur !== "string" || op.value == null) continue
        const v = String(op.value)
        if (mode === "trim_prefix") next = cur.startsWith(v) ? cur.slice(v.length) : cur
        else if (mode === "trim_suffix") next = v && cur.endsWith(v) ? cur.slice(0, cur.length - v.length) : cur
        else if (mode === "ensure_prefix") next = cur.startsWith(v) ? cur : v + cur
        else next = cur.endsWith(v) ? cur : cur + v
        break
      }
      case "trim_space":
        if (typeof cur !== "string") continue
        next = cur.trim()
        break
      case "to_lower":
        if (typeof cur !== "string") continue
        next = cur.toLowerCase()
        break
      case "to_upper":
        if (typeof cur !== "string") continue
        next = cur.toUpperCase()
        break
      case "replace":
        if (typeof cur !== "string" || !op.from) continue
        next = cur.split(String(op.from)).join(String(op.to ?? ""))
        break
      case "regex_replace":
        if (typeof cur !== "string" || !op.from) continue
        next = cur.replace(goRegexp(String(op.from)), goReplacement(String(op.to ?? "")))
        break
      case "prune_objects":
        if (cur === undefined) continue
        next = prune(cur, pruneRule(op.value), req, true)
        break
      default:
        // header modes, sync_fields and anything unknown
        return UNCHANGED
    }
    if (next === cur) continue
    root = setAt(root, p, next)
    touched = true
  }
  return touched ? root : UNCHANGED
}

// join is prepend/append: arrays are joined (an array value spread in),
// strings joined, objects merged (keep_origin keeps the keys already there).
function join(cur, value, before, keep) {
  if (Array.isArray(cur)) {
    const add = Array.isArray(value) ? clone(value) : [clone(value)]
    return before ? add.concat(cur) : cur.concat(add)
  }
  if (typeof cur === "string") {
    const v = typeof value === "string" ? value : JSON.stringify(value)
    return before ? v + cur : cur + v
  }
  if (isObj(cur) && isObj(value)) {
    const out = { ...cur }
    for (const k of Object.keys(value)) if (!keep || !(k in out)) out[k] = clone(value[k])
    return out
  }
}

function returnError(v) {
  let status = 400
  let message = ""
  if (typeof v === "string") message = v.trim()
  else if (isObj(v)) {
    message = String(v.message ?? v.msg ?? "").trim()
    const s = Number(v.status_code ?? v.status)
    if (Number.isInteger(s)) status = s
  }
  return { status, message: message || "turned away by param-override" }
}

// prune_objects' value: a type, or {type, where, conditions, logic, recursive}
function pruneRule(v) {
  const r = { conds: [], logic: "AND", recursive: true }
  if (typeof v === "string" && v.trim()) r.conds.push({ path: "type", mode: "full", value: v.trim() })
  else if (isObj(v)) {
    if (typeof v.logic === "string" && v.logic.trim()) r.logic = v.logic
    if (typeof v.recursive === "boolean") r.recursive = v.recursive
    r.conds.push(...conditions(v.conditions))
    if (isObj(v.where)) for (const k of Object.keys(v.where)) r.conds.push({ path: k, mode: "full", value: v.where[k] })
    if (v.type !== undefined) r.conds.push({ path: "type", mode: "full", value: v.type })
  }
  return r
}

// prune drops every object below node the rule matches; node itself stays
function prune(node, rule, req, top) {
  if (!rule.conds.length) return node
  const keep = (x) => !(isObj(x) && when(x, req, rule.conds, rule.logic))
  const deeper = (x) => (rule.recursive && (isObj(x) || Array.isArray(x)) ? prune(x, rule, req, false) : x)
  if (Array.isArray(node)) {
    let out = node.filter(keep).map(deeper)
    const same = out.length === node.length && out.every((x, i) => x === node[i])
    return same ? node : out
  }
  if (isObj(node)) {
    let out = null
    for (const k of Object.keys(node)) {
      const x = node[k]
      if (!keep(x)) {
        if (!out) out = { ...node }
        delete out[k]
      } else {
        const y = deeper(x)
        if (y !== x) {
          if (!out) out = { ...node }
          out[k] = y
        }
      }
    }
    return out ?? node
  }
  return node
}

function conditions(c) {
  if (Array.isArray(c)) return c.filter(isObj)
  if (isObj(c)) return Object.keys(c).map((k) => ({ path: k, mode: "full", value: c[k] }))
  return []
}

// when says whether the conditions hold: any of them (New API's default,
// OR), or all with logic AND. None hold always.
function when(body, req, raw, logic) {
  const cs = conditions(raw)
  if (!cs.length) return true
  const hit = (c) => {
    let v = lookup(body, String(c.path ?? ""))
    if (v === undefined) v = lookup(req, String(c.path ?? ""))
    if (v === undefined) return !!c.pass_missing_key
    const r = compare(v, c.value, String(c.mode || "full").toLowerCase())
    return c.invert ? !r : r
  }
  return String(logic).toUpperCase() === "AND" ? cs.every(hit) : cs.some(hit)
}

function lookup(root, path) {
  const ps = resolve(root, split(path))
  return ps.length === 1 ? getAt(root, ps[0]) : undefined
}

function compare(v, t, mode) {
  const s = (x) => (typeof x === "string" ? x : JSON.stringify(x))
  switch (mode) {
    case "full":
      if (v === null || t === null || typeof v !== typeof t) return v === t
      return typeof v === "object" ? JSON.stringify(v) === JSON.stringify(t) : v === t
    case "prefix":
      return s(v).startsWith(s(t))
    case "suffix":
      return s(v).endsWith(s(t))
    case "contains":
      return s(v).includes(s(t))
    case "gt":
    case "gte":
    case "lt":
    case "lte":
      if (typeof v !== "number" || typeof t !== "number") return false
      return mode === "gt" ? v > t : mode === "gte" ? v >= t : mode === "lt" ? v < t : v <= t
  }
  return false
}

// split is a gjson path's keys: "a.b\.c.0" is a, b.c, 0
function split(path) {
  path = String(path ?? "")
  if (!path) return []
  const out = []
  let cur = ""
  for (let i = 0; i < path.length; i++) {
    const c = path[i]
    if (c === "\\" && i + 1 < path.length) cur += path[++i]
    else if (c === ".") {
      out.push(cur)
      cur = ""
    } else cur += c
  }
  out.push(cur)
  return out
}

// resolve is the concrete paths keys stand for in root: "*" is each key or
// index there, "-1" an array's last. A key not there yet resolves (set makes
// it); a wildcard over nothing resolves to nothing.
function resolve(root, keys) {
  let paths = [[]]
  for (const k of keys) {
    const next = []
    for (const p of paths) {
      const node = getAt(root, p)
      if (k === "*") {
        if (Array.isArray(node)) node.forEach((_, i) => next.push(p.concat(i)))
        else if (isObj(node)) Object.keys(node).sort().forEach((key) => next.push(p.concat(key)))
      } else if (Array.isArray(node)) {
        let i = /^-?\d+$/.test(k) ? Number(k) : NaN
        if (i < 0) i += node.length
        if (i >= 0 && i < node.length) next.push(p.concat(i))
      } else if (node === undefined || isObj(node)) next.push(p.concat(k))
    }
    paths = next
  }
  return paths
}

function getAt(root, p) {
  let n = root
  for (const k of p) {
    if (n === null || typeof n !== "object") return undefined
    n = n[k]
  }
  return n
}

function setAt(root, p, v) {
  if (!p.length) return v
  let n = root
  for (let i = 0; i < p.length - 1; i++) {
    if (n[p[i]] === null || typeof n[p[i]] !== "object") n[p[i]] = {}
    n = n[p[i]]
  }
  n[p[p.length - 1]] = v
  return root
}

function delAt(root, p) {
  const parent = getAt(root, p.slice(0, -1))
  const k = p[p.length - 1]
  if (Array.isArray(parent)) parent.splice(k, 1)
  else if (isObj(parent)) delete parent[k]
}

// goRegexp is New API's (Go's) pattern as JavaScript's: Go's leading flag
// group (?i) becomes a flag, and every match is replaced, as Go's
// ReplaceAllString does.
function goRegexp(src) {
  let flags = "g"
  const m = /^\(\?([imsU]+)\)/.exec(src)
  if (m) {
    src = src.slice(m[0].length)
    for (const f of m[1]) if (f !== "U" && !flags.includes(f)) flags += f
  }
  return new RegExp(src.replace(/\(\?P</g, "(?<"), flags)
}

// goReplacement is Go's ${1} and ${name} as JavaScript's $1 and $<name>
function goReplacement(to) {
  return to.replace(/\$\{(\d+)\}/g, "$$$1").replace(/\$\{([A-Za-z_]\w*)\}/g, "$$<$1>")
}

function clone(v) {
  return v === undefined || v === null || typeof v !== "object" ? v : JSON.parse(JSON.stringify(v))
}

function isObj(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v)
}
