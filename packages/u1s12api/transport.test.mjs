import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { once } from "node:events"
import { U1s12apiPlugin, _internal } from "./index.mjs"

const dist = fileURLToPath(new URL("./test/fixtures/cli/", import.meta.url))
const cli = { node: process.execPath, index: fileURLToPath(new URL("./test/fixtures/cli/index.js", import.meta.url)) }

async function loader() {
  process.env.U1S1_CLI_DIST = dist
  const plugin = await U1s12apiPlugin({})
  return (await plugin.auth.loader(async () => ({ type: "oauth" }))).fetch
}
function request(fetcher, content, opts = {}) {
  return fetcher("https://api.u1s1app.com/v1/chat/completions", {
    method: "POST", signal: opts.signal,
    body: JSON.stringify({ model: opts.model ?? "deepseek-flash", stream: opts.stream ?? false, messages: opts.messages ?? [{ role: "user", content }] }),
  })
}
async function payload(response) {
  assert.equal(response.status, 200)
  return JSON.parse((await response.json()).choices[0].message.content)
}

test("loader completes overlapping requests without a shared-worker busy failure", async () => {
  const fetcher = await loader()
  const result = await Promise.allSettled([request(fetcher, "FIRST"), request(fetcher, "SECOND")])
  assert.deepEqual(result.map((r) => r.status), ["fulfilled", "fulfilled"], result.map((r) => r.reason?.message).join("; "))
  const replies = await Promise.all(result.map((r) => payload(r.value)))
  assert.equal(replies[0].prompt, "FIRST")
  assert.equal(replies[1].prompt, "SECOND")
  assert.notEqual(replies[0].pid, replies[1].pid)
})

test("worker sends a long quoted prompt through stdin rather than argv", async () => {
  const worker = new _internal.RpcWorker(cli, "test")
  const prompt = ('\"\\中文\n').repeat(15000)
  const result = await worker.prompt(prompt, [], { model: "qwen3.8-flash" })
  const data = JSON.parse(result.text)
  assert.equal(data.prompt, prompt)
  assert.ok(data.args.join(" ").length < 1000)
  assert.equal(data.args[data.args.indexOf("--model") + 1], "u1s1/qwen3.8-flash")
})

test("loader passes selected model and isolates CLI tools and session", async () => {
  const data = await payload(await request(await loader(), "MODEL", { model: "glm-5.3-flash" }))
  assert.equal(data.args[data.args.indexOf("--model") + 1], "u1s1/glm-5.3-flash")
  assert.ok(data.args.includes("--no-session"))
  assert.ok(data.args.includes("--no-tools"))
})

test("loader pins a low thinking level so the first byte is not spent on heavy reasoning", async () => {
  const data = await payload(await request(await loader(), "THINKING"))
  assert.ok(data.args.includes("--thinking"), "thinking flag present")
  assert.equal(data.args[data.args.indexOf("--thinking") + 1], "low")
})

test("stagingImage keeps local image paths and rejects remote URLs", async () => {
  const { stagingImage } = _internal
  assert.equal(stagingImage({ image_url: { url: "https://example.com/x.png" } }), "")
  assert.equal(stagingImage({ type: "image", source: { type: "base64", media_type: "image/png", data: "bm90LWltZw==" } }) === "", false)
})

test("pre-aborted requests do not start inference", async () => {
  const signal = AbortSignal.abort()
  await assert.rejects(request(await loader(), "CANCELLED", { signal }), /abort/i)
})

test("active cancellation stops one request without poisoning the next", async () => {
  const fetcher = await loader()
  const controller = new AbortController()
  const pending = request(fetcher, "FIXTURE_SLOW", { signal: controller.signal })
  const rejected = assert.rejects(pending, /abort/i)
  controller.abort()
  await rejected
  const next = await payload(await request(fetcher, "AFTER_ABORT"))
  assert.equal(next.prompt, "AFTER_ABORT")
})

test("upstream failure is rejected and a later request succeeds", async () => {
  const fetcher = await loader()
  await assert.rejects(request(fetcher, "FIXTURE_FAIL"), /fixture upstream failure/)
  assert.equal((await payload(await request(fetcher, "RECOVERED"))).prompt, "RECOVERED")
})

test("empty CLI output is a failure, not an empty successful completion", async () => {
  await assert.rejects(request(await loader(), "FIXTURE_EMPTY"), /empty/i)
})

test("SSE uses real newlines, terminal finish reason, and DONE", async () => {
  const response = await request(await loader(), "STREAM", { stream: true })
  const text = await response.text()
  const events = text.split("\n\n").filter(Boolean)
  assert.ok(events.length >= 3, text)
  assert.equal(events.at(-1), "data: [DONE]")
  const json = events.slice(0, -1).map((e) => JSON.parse(e.replace(/^data: /, "")))
  assert.equal(json.at(-1).choices[0].finish_reason, "stop")
  assert.equal(JSON.parse(json.map((e) => e.choices[0].delta.content ?? "").join("")).prompt, "STREAM")
})

test("packing bounds an oversized latest user message even with zero history budget", () => {
  const packed = _internal.packPrompt([{ role: "user", content: "x".repeat(100000) + "LATEST_END" }])
  assert.ok(packed.prompt.length <= _internal.MAX_PROMPT_CHARS)
  assert.ok(packed.prompt.endsWith("LATEST_END"))
})

test("packing retains assistant turns and content-array user text", () => {
  const packed = _internal.packPrompt([
    { role: "user", content: "Remember alpha" },
    { role: "assistant", content: "alpha remembered" },
    { role: "user", content: [{ type: "text", text: "repeat it" }] },
  ])
  assert.match(packed.prompt, /alpha remembered/)
  assert.match(packed.prompt, /repeat it/)
  assert.ok(packed.prompt.includes("\n\n"))
})

test("loader uses the same bounded packer as unit tests", async () => {
  const data = await payload(await request(await loader(), "x".repeat(100000) + "TAIL"))
  assert.ok(data.prompt.length <= _internal.MAX_PROMPT_CHARS)
  assert.ok(data.prompt.endsWith("TAIL"))
})

test("provider-prefixed model names are normalized once", async () => {
  const data = await payload(await request(await loader(), "MODEL", { model: "u1s12api/qwen3.8-flash" }))
  assert.equal(data.args[data.args.indexOf("--model") + 1], "u1s1/qwen3.8-flash")
})

test("worker timeout rejects and the actual child process exits", async () => {
  const worker = new _internal.RpcWorker(cli)
  const pending = worker.prompt("FIXTURE_SLOW", [], { timeoutMs: 100 })
  const child = worker.proc
  assert.ok(child?.pid)
  const closed = once(child, "close")
  await assert.rejects(pending, /timed out/)
  await closed
  assert.ok(child.exitCode !== null || child.signalCode !== null)
  assert.equal(worker.proc, null)
})

test("aborting one live worker does not cancel another", async () => {
  const worker = new _internal.RpcWorker(cli)
  const other = new _internal.RpcWorker(cli)
  const controller = new AbortController()
  const pending = worker.prompt("FIXTURE_SLOW", [], { signal: controller.signal })
  const child = worker.proc
  const closed = once(child, "close")
  const survivor = other.prompt("FIXTURE_SLOW_SURVIVOR", [])
  const rejected = assert.rejects(pending, /abort/i)
  controller.abort()
  await rejected
  await closed
  assert.equal(JSON.parse((await survivor).text).prompt, "FIXTURE_SLOW_SURVIVOR")
})

test("cancelling the response stream leaves a new loader request usable", async () => {
  const fetcher = await loader()
  const response = await request(fetcher, "FIXTURE_SLOW", { stream: true })
  await response.body.cancel()
  assert.equal((await payload(await request(fetcher, "AFTER_STREAM_CANCEL"))).prompt, "AFTER_STREAM_CANCEL")
})

test("stream failures surface instead of emitting an empty successful DONE", async () => {
  const response = await request(await loader(), "FIXTURE_FAIL", { stream: true })
  await assert.rejects(response.text(), /fixture upstream failure/)
})

test("non-stream responses carry an estimated 输入/输出 usage block", async () => {
  const response = await request(await loader(), "USAGE_FIXTURE")
  const json = await response.json()
  assert.ok(json.usage, "usage block present")
  assert.ok(json.usage.prompt_tokens >= 1)
  assert.ok(json.usage.completion_tokens >= 1)
  assert.equal(json.usage.total_tokens, json.usage.prompt_tokens + json.usage.completion_tokens)
})

test("streaming responses end with a usage frame before DONE", async () => {
  const response = await request(await loader(), "STREAM", { stream: true })
  const text = await response.text()
  const events = text.split("\n\n").filter(Boolean)
  const frames = events.slice(0, -1).map((e) => JSON.parse(e.replace(/^data: /, "")))
  const usage = frames.findLast((frame) => frame.usage)
  assert.ok(usage, "a frame carries usage")
  assert.ok(usage.usage.prompt_tokens >= 1)
  assert.ok(usage.usage.completion_tokens >= 1)
  assert.equal(usage.usage.total_tokens, usage.usage.prompt_tokens + usage.usage.completion_tokens)
})

// RPC daemon: these run against the real installed CLI and consume quota, so
// they are opt-in via U1S1_RPC_TEST=1. The first one cold-starts the daemon;
// later ones reuse it, which is the whole point of the resident transport.
const rpcTest = process.env.U1S1_RPC_TEST === "1" ? test : test.skip

// The real CLI (not the fixture) is required for RPC mode.
function realCli() {
  const candidates = [
    process.env.U1S1_RPC_CLI_DIST,
    "E:/Scoop/apps/nodejs/current/bin/node_modules/u1s1-cli/dist",
    "E:/Scoop/persist/nodejs24/bin/node_modules/u1s1-cli/dist",
  ]
  for (const d of candidates) {
    if (d && fs.existsSync(join(d, "index.js"))) return { dist: d, node: "node", index: join(d, "index.js") }
  }
  return null
}

rpcTest("resident RPC daemon returns a reply and real per-turn usage", async (t) => {
  const cli = realCli()
  assert.ok(cli, "real u1s1 CLI installed")
  if (!_internal.supportsRpc(cli)) return t.skip("CLI too old for RPC mode")
  const daemon = new _internal.RpcDaemon(cli)
  try {
    const first = await daemon.prompt("回复两个字：收到", [], { model: "deepseek-flash" })
    assert.equal(String(first.text).trim(), "收到")
    assert.ok(first.usage?.totalTokens > 0, "real usage present")
    assert.ok(first.usage?.input > 0 && first.usage?.output > 0)
    const warm = await daemon.prompt("回复两个字：好的", [], { model: "deepseek-flash" })
    assert.equal(String(warm.text).trim(), "好的")
    assert.ok(warm.usage?.totalTokens > 0)
  } finally {
    daemon.stop()
  }
})

rpcTest("resident RPC daemon carries the injected tool protocol to parseToolOutput", async (t) => {
  const cli = realCli()
  if (!_internal.supportsRpc(cli)) return t.skip("CLI too old for RPC mode")
  const daemon = new _internal.RpcDaemon(cli)
  try {
    const protocol = '[External Harness tool protocol]\nReturn the next external action by writing <tool_call>{"name":"tool_name","arguments":{}}</tool_call>.\n{"name":"bash","description":"run a command","parameters":{"type":"object","properties":{"command":{"type":"string"}}}}'
    const reply = await daemon.prompt("请调用 bash 工具执行 echo hi。\n\n" + protocol, [], { model: "deepseek-flash" })
    const tools = [{ name: "bash", description: "run a command", parameters: { type: "object", properties: { command: { type: "string" } } } }]
    const parsed = (await import("./tools.mjs")).parseToolOutput(reply.text, tools)
    assert.ok(parsed.calls.length >= 1, "the model used the tool protocol")
    assert.equal(parsed.calls[0].function.name, "bash")
  } finally {
    daemon.stop()
  }
})
